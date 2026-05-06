/**
 * `takosumi-git push` implementation.
 *
 * Flow:
 *   1. Read project root's `.takosumi/manifest.yml` (YAML).
 *   2. For each `compute.<name>` entry that carries a `workflowRef:
 *      { file, job, artifact }` field (a takosumi-git private extension
 *      that takosumi kernel does not understand), read the referenced
 *      workflow file under `.takosumi/workflows/`.
 *   3. Run the named job's steps as subprocesses (`bash -lc <run>`),
 *      capturing each step's stdout.
 *   4. Resolve the artifact URI: **the last successful step's last
 *      stdout line is taken as the artifact URI**. This is the v0
 *      contract — explicit, simple, and easy to produce from any build
 *      script (`echo "ghcr.io/foo/bar@sha256:..."` as the final line).
 *   5. Substitute the resolved URI into the corresponding
 *      `compute.<name>.image` field. takosumi requires a digest-pinned
 *      URI, but we do not enforce that here — it is the workflow's
 *      responsibility to print one.
 *   6. Strip every `workflowRef` field from the manifest so the kernel
 *      receives a clean document.
 *   7. POST the cleaned manifest to takosumi via `postDeployment`,
 *      unless `--dry-run` was passed (in which case the resolved
 *      manifest is printed to stdout).
 */

import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { dirname, isAbsolute, join, resolve } from "@std/path";
import { parseArgs } from "@std/cli/parse-args";
import {
  type DeployMode,
  type ManifestEnvelope,
  postDeployment,
} from "@takos/takosumi-git-deploy-client";
import type {
  ComputeWorkflowRef,
  ResolvedArtifact,
  WorkflowEvent,
  WorkflowFile,
  WorkflowJobSpec,
} from "@takos/takosumi-git-workflow-contract";
import {
  type ArtifactResolver,
  runWorkflow,
  type StepExecutor,
  type StepOutcome,
} from "@takos/takosumi-git-workflow-runner";

export interface PushOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly manifestPath: string;
  readonly workflowsDir: string;
  readonly mode: DeployMode;
  readonly dryRun: boolean;
  /** Injected for tests. Defaults to global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Injected for tests. Defaults to a real `Deno.Command`-backed executor. */
  readonly executorFactory?: (workflowDir: string) => StepExecutor;
  /** Captures stdout for tests. Defaults to `Deno.stdout.writeSync`. */
  readonly stdout?: (text: string) => void;
}

export interface PushResult {
  readonly manifest: Record<string, unknown>;
  readonly resolved: ReadonlyArray<{
    readonly compute: string;
    readonly artifact: ResolvedArtifact;
  }>;
  readonly response?: { status: number; body: unknown };
}

/** Default executor: spawns `bash -lc <run>` from `cwd`. */
export function defaultStepExecutor(cwd: string): StepExecutor {
  return async (run, _ctx): Promise<StepOutcome> => {
    const cmd = new Deno.Command("bash", {
      args: ["-lc", run],
      cwd,
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    const decoder = new TextDecoder();
    const out = decoder.decode(stdout);
    const err = decoder.decode(stderr);
    // Surface stderr by appending it to stdout for log capture; downstream
    // last-line logic only looks at the trailing non-empty line of stdout
    // proper, so we keep them separated by a marker.
    const merged = err.length > 0 ? `${out}\n[stderr]\n${err}` : out;
    return { stdout: merged, exitCode: code };
  };
}

function lastNonEmptyLine(text: string): string | null {
  // Only consider the first segment before our `[stderr]` marker.
  const stdoutOnly = text.split("\n[stderr]\n")[0] ?? text;
  const lines = stdoutOnly.split("\n").map((l) => l.trim()).filter((l) =>
    l.length > 0
  );
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

/**
 * ArtifactResolver factory that returns a resolver capturing the **last
 * non-empty stdout line of the final step's output** as the artifact URI.
 */
export function lastLineArtifactResolver(
  capturedLogs: () => readonly string[],
  ref: ComputeWorkflowRef,
): ArtifactResolver {
  return (job: WorkflowJobSpec, _event: WorkflowEvent) => {
    const logs = capturedLogs();
    // Walk backwards through captured stdout chunks and find the last
    // non-empty line. The runner pushes one stdout chunk per step.
    for (let i = logs.length - 1; i >= 0; i--) {
      const line = lastNonEmptyLine(logs[i]);
      if (line) {
        return Promise.resolve({
          name: job.artifact?.name ?? ref.artifact,
          uri: line,
        });
      }
    }
    return Promise.reject(
      new Error(
        `workflow job '${job.name}' produced no stdout; cannot resolve artifact URI`,
      ),
    );
  };
}

interface ComputeEntry {
  readonly name: string;
  readonly workflowRef: ComputeWorkflowRef;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function extractComputeEntries(
  manifest: Record<string, unknown>,
): ComputeEntry[] {
  const compute = manifest.compute;
  if (!isRecord(compute)) return [];
  const entries: ComputeEntry[] = [];
  for (const [name, raw] of Object.entries(compute)) {
    if (!isRecord(raw)) continue;
    const ref = raw.workflowRef;
    if (!isRecord(ref)) continue;
    if (
      typeof ref.file !== "string" ||
      typeof ref.job !== "string" ||
      typeof ref.artifact !== "string"
    ) {
      throw new Error(
        `compute.${name}.workflowRef must have string {file, job, artifact}`,
      );
    }
    entries.push({
      name,
      workflowRef: {
        file: ref.file,
        job: ref.job,
        artifact: ref.artifact,
      },
    });
  }
  return entries;
}

function stripWorkflowRefs(manifest: Record<string, unknown>): void {
  const compute = manifest.compute;
  if (!isRecord(compute)) return;
  for (const value of Object.values(compute)) {
    if (isRecord(value) && "workflowRef" in value) {
      delete (value as Record<string, unknown>).workflowRef;
    }
  }
}

function setComputeImage(
  manifest: Record<string, unknown>,
  computeName: string,
  uri: string,
): void {
  const compute = manifest.compute;
  if (!isRecord(compute)) return;
  const entry = compute[computeName];
  if (!isRecord(entry)) return;
  entry.image = uri;
}

async function readYaml<T>(path: string): Promise<T> {
  const text = await Deno.readTextFile(path);
  return parseYaml(text) as T;
}

function resolveWorkflowDir(workflowsDir: string): string {
  if (isAbsolute(workflowsDir)) return workflowsDir;
  // Relative paths resolve against cwd, matching how shell users would
  // expect `--workflows-dir .takosumi/workflows` to behave.
  return resolve(workflowsDir);
}

export async function push(options: PushOptions): Promise<PushResult> {
  const stdout = options.stdout ?? ((text: string) => {
    Deno.stdout.writeSync(new TextEncoder().encode(text));
  });
  const manifestPath = resolve(options.manifestPath);
  const workflowsDir = resolveWorkflowDir(options.workflowsDir);

  const manifest = await readYaml<Record<string, unknown>>(manifestPath);
  if (!isRecord(manifest)) {
    throw new Error(`manifest at ${manifestPath} is not an object`);
  }
  const entries = extractComputeEntries(manifest);
  const projectRoot = dirname(dirname(manifestPath)); // parent of `.takosumi/`
  const executorFactory = options.executorFactory ??
    ((_dir: string) => defaultStepExecutor(projectRoot));

  const resolved: { compute: string; artifact: ResolvedArtifact }[] = [];

  for (const entry of entries) {
    const workflowPath = join(workflowsDir, entry.workflowRef.file);
    const workflow = await readYaml<WorkflowFile>(workflowPath);
    if (
      !isRecord(workflow) ||
      !Array.isArray((workflow as unknown as { jobs: unknown }).jobs)
    ) {
      throw new Error(
        `workflow file ${workflowPath} is missing a 'jobs' array`,
      );
    }

    // Capture per-step stdout so the artifact resolver can read the last
    // step's last line. We wrap the executor to push outcomes into this
    // buffer in execution order.
    const stepStdouts: string[] = [];
    const baseExecutor = executorFactory(projectRoot);
    const wrappedExecutor: StepExecutor = async (run, ctx) => {
      const outcome = await baseExecutor(run, ctx);
      stepStdouts.push(outcome.stdout);
      return outcome;
    };

    const event: WorkflowEvent = {
      kind: "manual",
      source: `takosumi-git push ${entry.name}`,
    };

    const result = await runWorkflow({
      file: workflow,
      job: entry.workflowRef.job,
      event,
      executor: wrappedExecutor,
      resolveArtifact: lastLineArtifactResolver(
        () => stepStdouts,
        entry.workflowRef,
      ),
    });

    if (!result.success) {
      const detail = result.logs.join("\n");
      throw new Error(
        `workflow job '${entry.workflowRef.job}' (compute '${entry.name}') failed:\n${detail}`,
      );
    }
    if (!result.artifact) {
      throw new Error(
        `workflow job '${entry.workflowRef.job}' (compute '${entry.name}') produced no artifact; ` +
          `add an 'artifact' field to the job spec so the runner resolves a URI`,
      );
    }

    setComputeImage(manifest, entry.name, result.artifact.uri);
    resolved.push({ compute: entry.name, artifact: result.artifact });
  }

  stripWorkflowRefs(manifest);

  if (options.dryRun) {
    stdout(
      `# takosumi-git push --dry-run\n# resolved ${resolved.length} compute(s)\n`,
    );
    stdout(stringifyYaml(manifest));
    return { manifest, resolved };
  }

  const response = await postDeployment(
    {
      endpoint: options.endpoint,
      token: options.token,
      fetch: options.fetch,
    },
    {
      mode: options.mode,
      manifest: manifest as unknown as ManifestEnvelope,
    },
  );

  return { manifest, resolved, response };
}

const DEFAULT_MANIFEST = ".takosumi/manifest.yml";
const DEFAULT_WORKFLOWS_DIR = ".takosumi/workflows";

export interface ParsedPushArgs {
  readonly endpoint: string;
  readonly token: string;
  readonly manifestPath: string;
  readonly workflowsDir: string;
  readonly mode: DeployMode;
  readonly dryRun: boolean;
}

export function parsePushArgs(
  args: readonly string[],
  env: { get(key: string): string | undefined } = Deno.env,
): ParsedPushArgs {
  const flags = parseArgs(args as string[], {
    string: ["endpoint", "token", "manifest", "workflows-dir", "mode"],
    boolean: ["dry-run"],
    alias: {},
    default: {
      manifest: DEFAULT_MANIFEST,
      "workflows-dir": DEFAULT_WORKFLOWS_DIR,
      mode: "apply",
      "dry-run": false,
    },
  });
  const endpoint = (flags.endpoint as string | undefined) ??
    env.get("TAKOSUMI_ENDPOINT") ?? "";
  const token = (flags.token as string | undefined) ??
    env.get("TAKOSUMI_TOKEN") ?? "";
  const dryRun = Boolean(flags["dry-run"]);
  if (!dryRun && !endpoint) {
    throw new Error(
      "missing --endpoint (or TAKOSUMI_ENDPOINT); required unless --dry-run",
    );
  }
  if (!dryRun && !token) {
    throw new Error(
      "missing --token (or TAKOSUMI_TOKEN); required unless --dry-run",
    );
  }
  const mode = (flags.mode as string) as DeployMode;
  if (mode !== "apply" && mode !== "plan" && mode !== "destroy") {
    throw new Error(
      `--mode must be one of apply|plan|destroy (got '${mode}')`,
    );
  }
  return {
    endpoint,
    token,
    manifestPath: flags.manifest as string,
    workflowsDir: flags["workflows-dir"] as string,
    mode,
    dryRun,
  };
}

export async function runPushCli(args: readonly string[]): Promise<number> {
  let parsed: ParsedPushArgs;
  try {
    parsed = parsePushArgs(args);
  } catch (e) {
    Deno.stderr.writeSync(
      new TextEncoder().encode(`takosumi-git push: ${(e as Error).message}\n`),
    );
    return 64;
  }
  try {
    const result = await push(parsed);
    if (!parsed.dryRun) {
      const status = result.response?.status ?? 0;
      Deno.stdout.writeSync(
        new TextEncoder().encode(
          `takosumi-git push: kernel responded with HTTP ${status}\n`,
        ),
      );
      if (status >= 400) return 1;
    }
    return 0;
  } catch (e) {
    Deno.stderr.writeSync(
      new TextEncoder().encode(`takosumi-git push: ${(e as Error).message}\n`),
    );
    return 1;
  }
}
