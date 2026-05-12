import { parseArgs } from "@std/cli/parse-args";
import { isAbsolute, join, resolve } from "@std/path";
import {
  type DeployMode,
  type ManifestEnvelope,
  parseManifestEnvelope,
  postDeployment,
} from "@takos/takosumi-git-deploy-client";
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
const DEFAULT_INTENT_PATH_PREFIX = "deployments";
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface WatchOptions {
  readonly cwd: string;
  readonly endpoint: string;
  readonly token: string;
  readonly manifestPath: string;
  readonly workflowsDir: string;
  readonly intentPathPrefix?: string;
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
  readonly postDeploymentImpl?: typeof postDeployment;
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
  readonly intentPathPrefix: string;
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
  const postDeploymentImpl = options.postDeploymentImpl ?? postDeployment;
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
        postDeploymentImpl,
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
        postDeploymentImpl,
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
  postDeploymentImpl: typeof postDeployment;
  stdout: (text: string) => void;
}): Promise<{ commit: string; status?: number }> {
  input.stdout(`takosumi-git watch: detected commit ${input.commit}\n`);
  const intent = await readLatestDeployIntent(
    join(
      input.cwd,
      input.options.intentPathPrefix ?? DEFAULT_INTENT_PATH_PREFIX,
    ),
  );
  if (intent) {
    input.stdout(
      `takosumi-git watch: dispatching deploy intent ${intent.id}\n`,
    );
    if (input.options.dryRun) {
      input.stdout(
        `${
          JSON.stringify(
            { mode: intent.mode, manifest: intent.manifest },
            null,
            2,
          )
        }\n`,
      );
      return { commit: input.commit };
    }
    const budgetGuard = evaluateBudgetGuard(intent);
    if (budgetGuard.requiresApproval && !budgetGuard.approved) {
      throw new Error(
        `deploy intent ${intent.id} requires budget guard approval: ${
          budgetGuard.reasons.join(", ")
        }`,
      );
    }
    const result = await input.postDeploymentImpl({
      endpoint: input.options.endpoint,
      token: input.options.token,
      fetch: input.options.fetch,
      idempotencyKey: `takosumi-git-watch-${input.commit}`,
    }, {
      mode: intent.mode,
      manifest: intent.manifest,
    });
    return { commit: input.commit, status: result.status };
  }
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

interface DeployIntentDocument {
  readonly id: string;
  readonly mode: DeployMode;
  readonly metadata?: Record<string, unknown>;
  readonly manifest: ManifestEnvelope;
}

async function readLatestDeployIntent(
  directory: string,
): Promise<DeployIntentDocument | null> {
  let latest: { path: string; name: string; mtime: number } | null = null;
  try {
    for await (const entry of Deno.readDir(directory)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const path = join(directory, entry.name);
      const stat = await Deno.stat(path);
      const mtime = stat.mtime?.getTime() ?? 0;
      if (
        !latest || mtime > latest.mtime ||
        (mtime === latest.mtime && entry.name > latest.name)
      ) {
        latest = { path, name: entry.name, mtime };
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
  if (!latest) return null;
  return parseDeployIntentDocument(await Deno.readTextFile(latest.path));
}

function parseDeployIntentDocument(text: string): DeployIntentDocument {
  const value = JSON.parse(text) as unknown;
  if (!isRecord(value) || value.kind !== "takos.deploy-intent@v1") {
    throw new Error(
      "deploy intent document must have kind takos.deploy-intent@v1",
    );
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error("deploy intent document id is required");
  }
  const mode = typeof value.mode === "string" ? value.mode : "apply";
  if (mode !== "apply" && mode !== "plan" && mode !== "destroy") {
    throw new Error(
      `deploy intent mode must be one of apply|plan|destroy (got '${mode}')`,
    );
  }
  if (!isRecord(value.manifest)) {
    throw new Error("deploy intent document manifest must be an object");
  }
  return {
    id: value.id,
    mode,
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
    manifest: parseManifestEnvelope(value.manifest, "deploy intent manifest"),
  };
}

function evaluateBudgetGuard(intent: DeployIntentDocument): {
  readonly requiresApproval: boolean;
  readonly approved: boolean;
  readonly reasons: readonly string[];
} {
  const reasons = budgetGuardReasons(intent.manifest);
  return {
    requiresApproval: reasons.length > 0,
    approved: isBudgetGuardApproved(intent.metadata),
    reasons,
  };
}

function isBudgetGuardApproved(
  metadata: Record<string, unknown> | undefined,
): boolean {
  const guard = isRecord(metadata?.budgetGuard) ? metadata.budgetGuard : null;
  return isRecord(guard) && guard.approved === true;
}

function budgetGuardReasons(manifest: ManifestEnvelope): string[] {
  const resources = Array.isArray(manifest.resources) ? manifest.resources : [];
  const reasons: string[] = [];
  for (const resource of resources) {
    if (!isRecord(resource)) continue;
    const name = typeof resource.name === "string" ? resource.name : "resource";
    const spec = isRecord(resource.spec) ? resource.spec : {};
    if (hasExpensiveAccelerator(spec)) {
      reasons.push(`${name} requests accelerator/GPU capacity`);
    }
    const instanceCount = numericProperty(
      spec,
      "instances",
      "replicas",
      "replicaCount",
    );
    if (instanceCount !== undefined && instanceCount > 10) {
      reasons.push(`${name} requests ${instanceCount} instances`);
    }
  }
  return reasons;
}

function hasExpensiveAccelerator(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasExpensiveAccelerator);
  if (!isRecord(value)) return false;
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (
      (normalized.includes("gpu") || normalized.includes("accelerator")) &&
      isTruthyBudgetValue(entry)
    ) {
      return true;
    }
    if (isRecord(entry) || Array.isArray(entry)) {
      if (hasExpensiveAccelerator(entry)) return true;
    }
  }
  return false;
}

function isTruthyBudgetValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    return value.trim().length > 0 &&
      value !== "0" && value !== "false";
  }
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function numericProperty(
  value: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry === "number" && Number.isFinite(entry)) return entry;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      "intent-path-prefix",
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
    intentPathPrefix: (flags["intent-path-prefix"] as string | undefined) ??
      env.get("DEPLOY_INTENT_WRITE_PATH_PREFIX") ?? DEFAULT_INTENT_PATH_PREFIX,
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
