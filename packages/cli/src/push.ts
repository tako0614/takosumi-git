/**
 * `takosumi-git push` implementation.
 *
 * Flow:
 *   1. Read project root's `.takosumi/manifest.yml` (YAML), which is a
 *      takosumi v1 manifest envelope (apiVersion / kind / metadata /
 *      template / resources[]).
 *   2. For each entry in `resources[]` that carries a `workflowRef:
 *      { file, job, artifact }` field — a takosumi-git private extension
 *      placed alongside `shape` / `spec` / etc. on the resource entry —
 *      read the referenced workflow file under `.takosumi/workflows/`.
 *   3. Run the named job's steps as subprocesses (`bash -lc <run>`),
 *      capturing each step's stdout.
 *   4. Resolve the artifact URI. The default v1 contract scans successful
 *      step stdout for `TAKOSUMI_ARTIFACT=<uri>`. v0 remains available as a
 *      legacy fallback via `--artifact-contract v0` or auto-detection.
 *   5. Substitute the resolved URI into the corresponding resource field.
 *      The default target is `resources[i].spec.image`; workflowRef.target
 *      may choose another dotted field below `spec`, such as
 *      `spec.artifact.hash` for worker bundles.
 *   6. Strip every `workflowRef` field so the kernel receives a clean
 *      manifest matching the closed v1 envelope (kernel rejects unknown
 *      fields on resource entries).
 *   7. POST the cleaned manifest to takosumi via `postDeployment`,
 *      unless `--dry-run` was passed (in which case the resolved
 *      manifest is printed to stdout).
 */

import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { dirname, isAbsolute, join, resolve } from "@std/path";
import { parseArgs } from "@std/cli/parse-args";
import {
  type DeploymentProvenance,
  type DeploymentResourceArtifactProvenance,
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
import {
  compileInstallManifest,
  type KernelManifestServiceImport,
  parseInstallableAppYaml,
} from "./install.ts";

export interface PushOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly manifestPath: string;
  readonly workflowsDir: string;
  readonly mode: DeployMode;
  readonly dryRun: boolean;
  readonly artifactContract?: ArtifactContract;
  readonly serviceResolvers?: readonly ServiceResolverConfig[];
  readonly event?: WorkflowEvent;
  /** Injected for tests. Defaults to global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Injected for tests. Defaults to a real `Deno.Command`-backed executor. */
  readonly executorFactory?: (workflowDir: string) => StepExecutor;
  /** Injected for tests. Defaults to local `git` commands. */
  readonly git?: GitRunner;
  /** Injected for tests. Defaults to `crypto.randomUUID`. */
  readonly workflowRunIdFactory?: () => string;
  /** Injected for tests. Defaults to current wall-clock time. */
  readonly now?: () => string;
  /** Captures stdout for tests. Defaults to `Deno.stdout.writeSync`. */
  readonly stdout?: (text: string) => void;
}

export interface ServiceResolverConfig {
  readonly kind: "anchor";
  readonly url: string;
  readonly publicKey: string;
}

export interface PushResult {
  readonly manifest: Record<string, unknown>;
  readonly resolved: ReadonlyArray<{
    readonly resource: string;
    readonly artifact: ResolvedArtifact;
  }>;
  readonly serviceImports: ReadonlyArray<KernelManifestServiceImport>;
  readonly provenance?: DeploymentProvenance;
  readonly response?: { status: number; body: unknown };
}

export type ArtifactContract = "v0" | "v1" | "auto";
export type GitRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<{ readonly code: number; readonly stdout: string }>;

const DEFAULT_ARTIFACT_CONTRACT: ArtifactContract = "v1";
const ARTIFACT_MARKER_PREFIX = "TAKOSUMI_ARTIFACT=";
const digestPinnedImagePattern = /^.+@sha256:[0-9a-f]{64}$/;
const WORKFLOW_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
] as const;

/** Default executor: spawns `bash -lc <run>` from `cwd`. */
export function defaultStepExecutor(cwd: string): StepExecutor {
  return async (run, _ctx): Promise<StepOutcome> => {
    const cmd = new Deno.Command("bash", {
      args: ["-lc", run],
      cwd,
      clearEnv: true,
      env: workflowSandboxEnv(),
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    const decoder = new TextDecoder();
    const out = decoder.decode(stdout);
    const err = decoder.decode(stderr);
    // Surface stderr by appending it to stdout for log capture; downstream
    // artifact resolution only reads stdout proper, so we keep them separated
    // by a marker.
    const merged = err.length > 0 ? `${out}\n[stderr]\n${err}` : out;
    return { stdout: merged, exitCode: code };
  };
}

function workflowSandboxEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
  };
  for (const key of WORKFLOW_ENV_ALLOWLIST) {
    const value = Deno.env.get(key);
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function stdoutLines(text: string): string[] {
  // Only consider the first segment before our `[stderr]` marker.
  const stdoutOnly = text.split("\n[stderr]\n")[0] ?? text;
  return stdoutOnly.split("\n").map((l) => l.trim()).filter((l) =>
    l.length > 0
  );
}

function lastNonEmptyLine(text: string): string | null {
  const lines = stdoutLines(text);
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

type MarkerResult =
  | { readonly found: true; readonly uri: string }
  | { readonly found: false };

function artifactMarkerLine(text: string): MarkerResult {
  const lines = stdoutLines(text);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith(ARTIFACT_MARKER_PREFIX)) continue;
    const uri = line.slice(ARTIFACT_MARKER_PREFIX.length).trim();
    if (!uri) {
      throw new Error(
        `${ARTIFACT_MARKER_PREFIX}<uri> marker must include a URI`,
      );
    }
    return { found: true, uri };
  }
  return { found: false };
}

function findArtifactMarker(logs: readonly string[]): MarkerResult {
  for (let i = logs.length - 1; i >= 0; i--) {
    const marker = artifactMarkerLine(logs[i]);
    if (marker.found) return marker;
  }
  return { found: false };
}

function findLegacyStdoutArtifact(logs: readonly string[]): string | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = lastNonEmptyLine(logs[i]);
    if (line) return line;
  }
  return null;
}

function resolveArtifactUri(
  logs: readonly string[],
  jobName: string,
  contract: ArtifactContract,
): string {
  if (contract === "v1" || contract === "auto") {
    const marker = findArtifactMarker(logs);
    if (marker.found) return marker.uri;
    if (contract === "v1") {
      throw new Error(
        `workflow job '${jobName}' produced no ${ARTIFACT_MARKER_PREFIX}<uri> marker; cannot resolve artifact URI`,
      );
    }
  }

  const legacy = findLegacyStdoutArtifact(logs);
  if (legacy) return legacy;
  if (contract === "auto") {
    throw new Error(
      `workflow job '${jobName}' produced no ${ARTIFACT_MARKER_PREFIX}<uri> marker or stdout artifact; cannot resolve artifact URI`,
    );
  }
  throw new Error(
    `workflow job '${jobName}' produced no stdout; cannot resolve artifact URI`,
  );
}

/**
 * ArtifactResolver factory that implements the selected artifact URI contract.
 */
export function artifactContractResolver(
  capturedLogs: () => readonly string[],
  ref: ComputeWorkflowRef,
  contract: ArtifactContract,
): ArtifactResolver {
  return (job: WorkflowJobSpec, _event: WorkflowEvent) => {
    const logs = capturedLogs();
    try {
      return Promise.resolve({
        name: job.artifact?.name ?? ref.artifact,
        uri: resolveArtifactUri(logs, job.name, contract),
      });
    } catch (error) {
      return Promise.reject(error);
    }
  };
}

/**
 * Legacy v0 resolver: captures the last non-empty stdout line as the artifact
 * URI. Prefer `artifactContractResolver(..., "v1")` for new workflows.
 */
export function lastLineArtifactResolver(
  capturedLogs: () => readonly string[],
  ref: ComputeWorkflowRef,
): ArtifactResolver {
  return artifactContractResolver(capturedLogs, ref, "v0");
}

interface ResourceEntry {
  /** Index into the manifest.resources[] array. */
  readonly index: number;
  /** Resource's `name` field (or fallback synthesized from index). */
  readonly name: string;
  readonly workflowRef: ComputeWorkflowRef;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function extractResourceEntries(
  manifest: Record<string, unknown>,
): ResourceEntry[] {
  const resources = manifest.resources;
  if (!Array.isArray(resources)) return [];
  const entries: ResourceEntry[] = [];
  for (let i = 0; i < resources.length; i++) {
    const raw = resources[i];
    if (!isRecord(raw)) continue;
    const ref = raw.workflowRef;
    if (!isRecord(ref)) continue;
    if (
      typeof ref.file !== "string" ||
      typeof ref.job !== "string" ||
      typeof ref.artifact !== "string" ||
      (ref.target !== undefined && typeof ref.target !== "string")
    ) {
      throw new Error(
        `resources[${i}].workflowRef must have string {file, job, artifact, target?}`,
      );
    }
    const target = ref.target === undefined
      ? undefined
      : parseArtifactTarget(ref.target, `resources[${i}].workflowRef.target`);
    const name = typeof raw.name === "string" ? raw.name : `resources[${i}]`;
    entries.push({
      index: i,
      name,
      workflowRef: {
        file: ref.file,
        job: ref.job,
        artifact: ref.artifact,
        ...(target ? { target } : {}),
      },
    });
  }
  return entries;
}

function parseArtifactTarget(value: string, path: string): `spec.${string}` {
  if (!/^spec(?:\.[A-Za-z_][A-Za-z0-9_-]*)+$/.test(value)) {
    throw new Error(
      `${path} must be a dotted field path below spec, such as spec.image or spec.artifact.hash`,
    );
  }
  return value as `spec.${string}`;
}

function stripWorkflowRefs(manifest: Record<string, unknown>): void {
  const resources = manifest.resources;
  if (!Array.isArray(resources)) return;
  for (const entry of resources) {
    if (isRecord(entry) && "workflowRef" in entry) {
      delete (entry as Record<string, unknown>).workflowRef;
    }
  }
}

function setResourceArtifactTarget(
  manifest: Record<string, unknown>,
  index: number,
  uri: string,
  target = "spec.image",
): void {
  const resources = manifest.resources;
  if (!Array.isArray(resources)) return;
  const entry = resources[index];
  if (!isRecord(entry)) return;
  if (!isRecord(entry.spec)) {
    entry.spec = {};
  }
  const parts = target.split(".");
  let current = entry as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!isRecord(next)) {
      const created: Record<string, unknown> = {};
      current[part] = created;
      current = created;
      continue;
    }
    current = next;
  }
  current[parts[parts.length - 1]] = uri;
}

function validateResolvedArtifactTarget(
  entry: ResourceEntry,
  uri: string,
): void {
  const target = entry.workflowRef.target ?? "spec.image";
  if (target !== "spec.image") return;
  if (digestPinnedImagePattern.test(uri)) return;
  throw new Error(
    `workflow job '${entry.workflowRef.job}' (resource '${entry.name}') resolved '${uri}', but spec.image artifacts must be digest-pinned as <image>@sha256:<64-hex>`,
  );
}

function setResourceProvenanceMetadata(
  manifest: Record<string, unknown>,
  index: number,
  provenance: DeploymentResourceArtifactProvenance,
  workflowRunId: string,
  gitCommitSha: string | undefined,
): void {
  const resources = manifest.resources;
  if (!Array.isArray(resources)) return;
  const entry = resources[index];
  if (!isRecord(entry)) return;
  const metadata = isRecord(entry.metadata) ? entry.metadata : {};
  metadata.takosumiGitProvenance = {
    kind: "takosumi-git.resource-provenance@v1",
    provenanceDigest: digestJson(provenance),
    workflowRunId,
    ...(gitCommitSha ? { gitCommitSha } : {}),
    artifactUri: provenance.artifactUri,
    stepLogDigests: provenance.stepLogs.map((step) => step.stdoutDigest),
  };
  entry.metadata = metadata;
}

async function readYaml<T>(path: string): Promise<T> {
  const text = await Deno.readTextFile(path);
  return parseYaml(text) as T;
}

async function tryReadText(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
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
  const artifactContract = options.artifactContract ??
    DEFAULT_ARTIFACT_CONTRACT;

  const manifestText = await Deno.readTextFile(manifestPath);
  let manifest = parseYaml(manifestText) as Record<string, unknown>;
  if (!isRecord(manifest)) {
    throw new Error(`manifest at ${manifestPath} is not an object`);
  }
  const projectRoot = dirname(dirname(manifestPath)); // parent of `.takosumi/`
  const appText = await tryReadText(join(projectRoot, ".takosumi", "app.yml"));
  const compiled = appText
    ? compileInstallManifest(parseInstallableAppYaml(appText), manifestText)
    : undefined;
  if (compiled) manifest = compiled.manifest;
  const serviceImports = readKernelManifestServiceImports(manifest);
  applyServiceResolvers({
    manifest,
    serviceImportCount: serviceImports.length,
    serviceResolvers: options.serviceResolvers ?? [],
  });
  const entries = extractResourceEntries(manifest);
  const executorFactory = options.executorFactory ??
    ((_dir: string) => defaultStepExecutor(projectRoot));
  const workflowRunId = options.workflowRunIdFactory?.() ??
    `takosumi-git:run:${crypto.randomUUID()}`;
  const generatedAt = options.now?.() ?? new Date().toISOString();
  const git = await collectGitMetadata(
    projectRoot,
    options.event,
    options.git ?? defaultGitRunner,
  );

  const resolved: { resource: string; artifact: ResolvedArtifact }[] = [];
  const resourceProvenance: DeploymentResourceArtifactProvenance[] = [];

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
    const stepLogProvenance: DeploymentResourceArtifactProvenance[
      "stepLogs"
    ][number][] = [];
    const baseExecutor = executorFactory(projectRoot);
    const wrappedExecutor: StepExecutor = async (run, ctx) => {
      const outcome = await baseExecutor(run, ctx);
      stepStdouts.push(outcome.stdout);
      stepLogProvenance.push({
        stepName: ctx.step,
        exitCode: outcome.exitCode,
        stdoutDigest: digestText(outcome.stdout),
        stdoutBytes: new TextEncoder().encode(outcome.stdout).byteLength,
      });
      return outcome;
    };

    const event: WorkflowEvent = options.event ?? {
      kind: "manual",
      source: `takosumi-git push ${entry.name}`,
    };

    const result = await runWorkflow({
      file: workflow,
      job: entry.workflowRef.job,
      event,
      executor: wrappedExecutor,
      resolveArtifact: artifactContractResolver(
        () => stepStdouts,
        entry.workflowRef,
        artifactContract,
      ),
    });

    if (!result.success) {
      const detail = result.logs.join("\n");
      throw new Error(
        `workflow job '${entry.workflowRef.job}' (resource '${entry.name}') failed:\n${detail}`,
      );
    }
    if (!result.artifact) {
      throw new Error(
        `workflow job '${entry.workflowRef.job}' (resource '${entry.name}') produced no artifact; ` +
          `add an 'artifact' field to the job spec so the runner resolves a URI`,
      );
    }

    validateResolvedArtifactTarget(entry, result.artifact.uri);
    setResourceArtifactTarget(
      manifest,
      entry.index,
      result.artifact.uri,
      entry.workflowRef.target,
    );
    const provenance: DeploymentResourceArtifactProvenance = {
      resourceName: entry.name,
      artifactName: result.artifact.name,
      artifactUri: result.artifact.uri,
      ...(result.artifact.digest
        ? { artifactDigest: result.artifact.digest }
        : {}),
      workflow: {
        file: entry.workflowRef.file,
        job: entry.workflowRef.job,
        artifact: entry.workflowRef.artifact,
      },
      stepLogs: stepLogProvenance,
    };
    setResourceProvenanceMetadata(
      manifest,
      entry.index,
      provenance,
      workflowRunId,
      git.commitSha,
    );
    resolved.push({ resource: entry.name, artifact: result.artifact });
    resourceProvenance.push(provenance);
  }

  stripWorkflowRefs(manifest);
  const provenance = resourceProvenance.length > 0
    ? {
      kind: "takosumi-git.deployment-provenance@v1" as const,
      workflowRunId,
      generatedAt,
      event: serializableEvent(
        options.event ?? {
          kind: "manual",
          source: "takosumi-git push",
        },
      ),
      git: stripUndefined(git),
      resourceArtifacts: resourceProvenance,
    }
    : undefined;

  if (options.dryRun) {
    stdout(
      `# takosumi-git push --dry-run\n# resolved ${resolved.length} resource(s)\n`,
    );
    stdout(stringifyYaml(manifest));
    return {
      manifest,
      resolved,
      serviceImports,
      ...(provenance ? { provenance } : {}),
    };
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
      ...(provenance ? { provenance } : {}),
    },
  );

  return {
    manifest,
    resolved,
    serviceImports,
    ...(provenance ? { provenance } : {}),
    response,
  };
}

function readKernelManifestServiceImports(
  manifest: Record<string, unknown>,
): readonly KernelManifestServiceImport[] {
  const imports = manifest.imports;
  if (imports === undefined) return [];
  if (!Array.isArray(imports)) {
    throw new Error("manifest.imports must be an array");
  }
  return imports.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`manifest.imports[${index}] must be an object`);
    }
    if (typeof entry.alias !== "string" || typeof entry.service !== "string") {
      throw new Error(
        `manifest.imports[${index}] must declare alias and service`,
      );
    }
    return {
      alias: entry.alias,
      service: entry.service,
      ...(entry.refreshPolicy !== undefined
        ? { refreshPolicy: entry.refreshPolicy as Record<string, unknown> }
        : {}),
    };
  });
}

function applyServiceResolvers(input: {
  manifest: Record<string, unknown>;
  serviceImportCount: number;
  serviceResolvers: readonly ServiceResolverConfig[];
}): void {
  if (input.serviceImportCount === 0) return;
  const existing = input.manifest.serviceResolvers;
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new Error("manifest.serviceResolvers must be an array");
  }
  if (Array.isArray(existing) && existing.length > 0) return;
  if (input.serviceResolvers.length === 0) {
    throw new Error(
      "service imports require serviceResolvers; pass --service-resolver-url and --service-resolver-public-key",
    );
  }
  input.manifest.serviceResolvers = input.serviceResolvers.map((resolver) => ({
    kind: resolver.kind,
    url: resolver.url,
    publicKey: resolver.publicKey,
  }));
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

async function collectGitMetadata(
  projectRoot: string,
  event: WorkflowEvent | undefined,
  git: GitRunner,
): Promise<{
  readonly repository?: string;
  readonly repositoryUrl?: string;
  readonly ref?: string;
  readonly commitSha?: string;
}> {
  const payload = isRecord(event?.payload) ? event.payload : undefined;
  const eventCommit = readString(payload?.commit);
  const eventRef = readString(payload?.ref);
  const eventRepository = readString(payload?.repository) ??
    readString(payload?.repo);
  const eventRepositoryUrl = readString(payload?.repositoryUrl) ??
    readString(payload?.remoteUrl);
  const [commitSha, ref, repositoryUrl] = await Promise.all([
    eventCommit ? Promise.resolve(eventCommit) : gitString(git, projectRoot, [
      "rev-parse",
      "HEAD",
    ]),
    eventRef ? Promise.resolve(eventRef) : gitString(git, projectRoot, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]),
    eventRepositoryUrl
      ? Promise.resolve(eventRepositoryUrl)
      : gitString(git, projectRoot, [
        "config",
        "--get",
        "remote.origin.url",
      ]),
  ]);
  return stripUndefined({
    repository: eventRepository,
    repositoryUrl: repositoryUrl || undefined,
    ref: ref || undefined,
    commitSha: commitSha || undefined,
  });
}

async function gitString(
  git: GitRunner,
  cwd: string,
  args: readonly string[],
): Promise<string | undefined> {
  const result = await git(args, cwd);
  if (result.code !== 0) return undefined;
  const value = result.stdout.trim();
  return value.length > 0 ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function serializableEvent(event: WorkflowEvent): Record<string, unknown> {
  return stripUndefined({
    kind: event.kind,
    source: event.source,
    ...(event.payload ? { payload: event.payload } : {}),
  });
}

function stripUndefined<T extends Record<string, unknown>>(input: T): T {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output as T;
}

function digestText(text: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function digestJson(value: unknown): `sha256:${string}` {
  return `sha256:${
    createHash("sha256").update(JSON.stringify(canonicalize(value))).digest(
      "hex",
    )
  }`;
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      const canonical = canonicalize(object[key]);
      if (canonical !== undefined) output[key] = canonical;
    }
    return output;
  }
  return value;
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
  readonly artifactContract: ArtifactContract;
  readonly serviceResolvers?: readonly ServiceResolverConfig[];
}

export function parseArtifactContract(raw: unknown): ArtifactContract {
  if (raw === "v0" || raw === "v1" || raw === "auto") return raw;
  throw new Error(
    `--artifact-contract must be one of v0|v1|auto (got '${String(raw)}')`,
  );
}

export function parsePushArgs(
  args: readonly string[],
  env: { get(key: string): string | undefined } = Deno.env,
): ParsedPushArgs {
  const flags = parseArgs(args as string[], {
    string: [
      "endpoint",
      "token",
      "manifest",
      "workflows-dir",
      "mode",
      "artifact-contract",
      "service-resolver-url",
      "service-resolver-public-key",
    ],
    boolean: ["dry-run"],
    alias: {},
    default: {
      manifest: DEFAULT_MANIFEST,
      "workflows-dir": DEFAULT_WORKFLOWS_DIR,
      mode: "apply",
      "artifact-contract": DEFAULT_ARTIFACT_CONTRACT,
      "dry-run": false,
    },
  });
  const endpoint = (flags.endpoint as string | undefined) ??
    env.get("TAKOSUMI_ENDPOINT") ?? "";
  const token = (flags.token as string | undefined) ??
    env.get("TAKOSUMI_TOKEN") ?? "";
  const dryRun = Boolean(flags["dry-run"]);
  const serviceResolverUrl = (flags["service-resolver-url"] as
    | string
    | undefined) ??
    env.get("TAKOSUMI_SERVICE_RESOLVER_URL");
  const serviceResolverPublicKey = (flags["service-resolver-public-key"] as
    | string
    | undefined) ??
    env.get("TAKOSUMI_SERVICE_RESOLVER_PUBLIC_KEY");
  if (Boolean(serviceResolverUrl) !== Boolean(serviceResolverPublicKey)) {
    throw new Error(
      "--service-resolver-url and --service-resolver-public-key must be provided together",
    );
  }
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
    artifactContract: parseArtifactContract(flags["artifact-contract"]),
    ...(serviceResolverUrl && serviceResolverPublicKey
      ? {
        serviceResolvers: [{
          kind: "anchor" as const,
          url: serviceResolverUrl,
          publicKey: serviceResolverPublicKey,
        }],
      }
      : {}),
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
