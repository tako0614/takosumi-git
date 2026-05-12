import { parseArgs } from "@std/cli/parse-args";
import { isAbsolute, resolve } from "@std/path";
import type { DeployMode } from "@takos/takosumi-git-deploy-client";
import type { StepExecutor } from "@takos/takosumi-git-workflow-runner";
import {
  type ArtifactContract,
  type GitRunner,
  parseArtifactContract,
  push,
  type PushOptions,
  type PushResult,
} from "./push.ts";

const DEFAULT_MANIFEST = ".takosumi/manifest.yml";
const DEFAULT_WORKFLOWS_DIR = ".takosumi/workflows";
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface WatchOptions {
  readonly cwd: string;
  readonly endpoint: string;
  readonly token: string;
  readonly manifestPath: string;
  readonly workflowsDir: string;
  readonly mode: DeployMode;
  readonly artifactContract: ArtifactContract;
  readonly dryRun: boolean;
  readonly pollIntervalMs: number;
  readonly once?: boolean;
  readonly runCurrent?: boolean;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly executorFactory?: (workflowDir: string) => StepExecutor;
  readonly git?: GitRunner;
  readonly pushImpl?: (options: PushOptions) => Promise<PushResult>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly stdout?: (text: string) => void;
}

export interface WatchResult {
  readonly observedHead: string;
  readonly deployments: readonly {
    readonly commit: string;
    readonly status?: number;
  }[];
}

export interface ParsedWatchArgs {
  readonly cwd: string;
  readonly endpoint: string;
  readonly token: string;
  readonly manifestPath: string;
  readonly workflowsDir: string;
  readonly mode: DeployMode;
  readonly artifactContract: ArtifactContract;
  readonly dryRun: boolean;
  readonly pollIntervalMs: number;
  readonly once: boolean;
  readonly runCurrent: boolean;
}

export async function watchDeployIntentRepo(
  options: WatchOptions,
): Promise<WatchResult> {
  const cwd = resolve(options.cwd);
  const git = options.git ?? defaultGitRunner;
  const pushImpl = options.pushImpl ?? push;
  const sleep = options.sleep ?? delay;
  const stdout = options.stdout ?? ((text: string) => {
    Deno.stdout.writeSync(new TextEncoder().encode(text));
  });
  let observedHead = await currentHead({ cwd, git });
  const deployments: { commit: string; status?: number }[] = [];

  if (options.runCurrent) {
    deployments.push(
      await dispatchPush({
        options,
        cwd,
        commit: observedHead,
        pushImpl,
        stdout,
      }),
    );
    if (options.once) return { observedHead, deployments };
  }

  while (!options.signal?.aborted) {
    await sleep(options.pollIntervalMs);
    if (options.signal?.aborted) break;
    const head = await currentHead({ cwd, git });
    if (head === observedHead) continue;
    observedHead = head;
    deployments.push(
      await dispatchPush({
        options,
        cwd,
        commit: head,
        pushImpl,
        stdout,
      }),
    );
    if (options.once) break;
  }

  return { observedHead, deployments };
}

async function dispatchPush(input: {
  options: WatchOptions;
  cwd: string;
  commit: string;
  pushImpl: (options: PushOptions) => Promise<PushResult>;
  stdout: (text: string) => void;
}): Promise<{ commit: string; status?: number }> {
  input.stdout(`takosumi-git watch: detected commit ${input.commit}\n`);
  const result = await input.pushImpl({
    endpoint: input.options.endpoint,
    token: input.options.token,
    manifestPath: absoluteFromCwd(input.cwd, input.options.manifestPath),
    workflowsDir: absoluteFromCwd(input.cwd, input.options.workflowsDir),
    mode: input.options.mode,
    dryRun: input.options.dryRun,
    artifactContract: input.options.artifactContract,
    event: {
      kind: "git-push",
      source: "takosumi-git watch",
      payload: { commit: input.commit },
    },
    fetch: input.options.fetch,
    executorFactory: input.options.executorFactory,
    git: input.options.git,
    stdout: input.options.stdout,
  });
  return {
    commit: input.commit,
    ...(result.response ? { status: result.response.status } : {}),
  };
}

function absoluteFromCwd(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

async function currentHead(input: {
  cwd: string;
  git: GitRunner;
}): Promise<string> {
  const result = await input.git(["rev-parse", "HEAD"], input.cwd);
  const head = result.stdout.trim();
  if (result.code !== 0 || head.length === 0) {
    throw new Error("watch requires a git repository with a readable HEAD");
  }
  return head;
}

async function defaultGitRunner(
  args: readonly string[],
  cwd: string,
): Promise<{ readonly code: number; readonly stdout: string }> {
  try {
    const command = new Deno.Command("git", {
      args: [...args],
      cwd,
      stdout: "piped",
      stderr: "null",
    });
    const output = await command.output();
    return {
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout),
    };
  } catch {
    return { code: 1, stdout: "" };
  }
}

export function parseWatchArgs(
  args: readonly string[],
  env: { get(key: string): string | undefined } = Deno.env,
): ParsedWatchArgs {
  const flags = parseArgs(args as string[], {
    string: [
      "cwd",
      "endpoint",
      "token",
      "manifest",
      "workflows-dir",
      "mode",
      "artifact-contract",
      "poll-interval-ms",
    ],
    boolean: ["dry-run", "once", "run-current"],
    default: {
      cwd: ".",
      manifest: DEFAULT_MANIFEST,
      "workflows-dir": DEFAULT_WORKFLOWS_DIR,
      mode: "apply",
      "artifact-contract": "v1",
      "poll-interval-ms": String(DEFAULT_POLL_INTERVAL_MS),
      "dry-run": false,
      once: false,
      "run-current": false,
    },
  });
  const dryRun = Boolean(flags["dry-run"]);
  const endpoint = (flags.endpoint as string | undefined) ??
    env.get("TAKOSUMI_ENDPOINT") ?? "";
  const token = (flags.token as string | undefined) ??
    env.get("TAKOSUMI_TOKEN") ?? "";
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
  const mode = flags.mode as DeployMode;
  if (mode !== "apply" && mode !== "plan" && mode !== "destroy") {
    throw new Error(`--mode must be one of apply|plan|destroy (got '${mode}')`);
  }
  const pollIntervalMs = positiveInteger(
    flags["poll-interval-ms"],
    "--poll-interval-ms",
  );
  return {
    cwd: flags.cwd as string,
    endpoint,
    token,
    manifestPath: flags.manifest as string,
    workflowsDir: flags["workflows-dir"] as string,
    mode,
    artifactContract: parseArtifactContract(flags["artifact-contract"]),
    dryRun,
    pollIntervalMs,
    once: Boolean(flags.once),
    runCurrent: Boolean(flags["run-current"]),
  };
}

function positiveInteger(value: unknown, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export async function runWatchCli(args: readonly string[]): Promise<number> {
  let parsed: ParsedWatchArgs;
  try {
    parsed = parseWatchArgs(args);
  } catch (error) {
    Deno.stderr.writeSync(
      new TextEncoder().encode(
        `takosumi-git watch: ${(error as Error).message}\n`,
      ),
    );
    return 64;
  }

  const abort = new AbortController();
  const abortOnSignal = () => abort.abort();
  try {
    Deno.addSignalListener("SIGINT", abortOnSignal);
    Deno.addSignalListener("SIGTERM", abortOnSignal);
  } catch {
    // Signal listeners are unavailable in some embedded/test runtimes.
  }

  try {
    await watchDeployIntentRepo({ ...parsed, signal: abort.signal });
    return 0;
  } catch (error) {
    Deno.stderr.writeSync(
      new TextEncoder().encode(
        `takosumi-git watch: ${(error as Error).message}\n`,
      ),
    );
    return 1;
  } finally {
    try {
      Deno.removeSignalListener("SIGINT", abortOnSignal);
      Deno.removeSignalListener("SIGTERM", abortOnSignal);
    } catch {
      // Ignore runtimes that did not register signal listeners.
    }
  }
}
