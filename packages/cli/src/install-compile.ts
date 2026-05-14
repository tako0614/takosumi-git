/**
 * `takosumi-git install` entry manifest compilation and workflow artifact
 * resolution.
 *
 * Compiles a YAML manifest into the kernel-bound shape, asserts the absence of
 * removed kernel fields and unresolved installer placeholders, and (when the
 * caller requests it) runs declared `resources[i].workflowRef` jobs to
 * substitute artifact URIs into `spec.image` / target paths before submission.
 */

import { parse as parseYaml } from "@std/yaml";
import {
  type ComputeWorkflowRef,
  parseWorkflowFile,
  type WorkflowEvent,
  type WorkflowJobSpec,
} from "@takos/takosumi-git-workflow-contract";
import {
  type ArtifactResolver,
  runWorkflow,
  type StepExecutor,
} from "@takos/takosumi-git-workflow-runner";
import { resolveWorkflowFilePath } from "./workflow_path.ts";
import { createWorkflowStepExecutor } from "./workflow_sandbox.ts";
import { type InstallableApp, isRecord } from "./install-parse.ts";
import { digestJson } from "./install-preview.ts";

export interface CompiledInstallManifest {
  readonly manifest: Record<string, unknown>;
  readonly digest: `sha256:${string}`;
}

interface InstallWorkflowResourceEntry {
  readonly index: number;
  readonly name: string;
  readonly workflowRef: ComputeWorkflowRef;
}

export const installerPlaceholderPattern =
  /\$\{(?:params|installation|artifacts|bindings|secrets|refs|imports)\.[^}]+}/;
export const installerPlaceholderGlobalPattern =
  /\$\{(params|installation|artifacts|bindings|secrets|refs|imports)\.([^}]+)}/g;
const installArtifactMarkerPrefix = "TAKOSUMI_ARTIFACT=";
const digestPinnedImagePattern = /^.+@sha256:[0-9a-f]{64}$/;

export function compileInstallManifest(
  _app: InstallableApp,
  manifestText: string,
  options: { readonly allowInstallerPlaceholders?: boolean } = {},
): CompiledInstallManifest {
  const parsed = parseYaml(manifestText);
  if (!isRecord(parsed)) {
    throw new Error("entry manifest must be a YAML object");
  }
  const manifest = parsed;
  assertNoForbiddenKernelManifestFields(manifest, "entry manifest");
  if (!options.allowInstallerPlaceholders) {
    assertNoInstallerPlaceholders(manifest);
  }
  return {
    manifest,
    digest: digestJson(manifest),
  };
}

export function assertNoInstallerPlaceholders(
  value: unknown,
  path = "$",
): void {
  if (typeof value === "string") {
    const match = value.match(installerPlaceholderPattern);
    if (match) {
      throw new Error(
        `entry manifest contains unresolved installer placeholder at ${path}: ${
          match[0]
        }`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoInstallerPlaceholders(entry, `${path}[${index}]`)
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    assertNoInstallerPlaceholders(entry, `${path}.${key}`);
  }
}

export function assertNoForbiddenKernelManifestFields(
  manifest: Record<string, unknown>,
  label = "manifest",
): void {
  for (const field of ["imports", "serviceResolvers", "services"] as const) {
    if (Object.hasOwn(manifest, field)) {
      throw new Error(
        `${label}.${field} is forbidden; takosumi-git only deploys JSON-LD Shape manifests`,
      );
    }
  }
  if (
    isRecord(manifest.metadata) &&
    Object.hasOwn(manifest.metadata, "takosumiServiceImports")
  ) {
    throw new Error(
      `${label}.metadata.takosumiServiceImports is forbidden; service import metadata is not part of the current Shape manifest`,
    );
  }
}

export async function compileInstallWorkflowRefs(input: {
  readonly compiled: CompiledInstallManifest;
  readonly projectRoot: string;
  readonly workflowsDir: string;
  readonly executorFactory?: (projectRoot: string) => StepExecutor;
}): Promise<CompiledInstallManifest> {
  const manifest = structuredClone(input.compiled.manifest);
  const entries = installWorkflowResourceEntries(manifest);
  const executorFactory = input.executorFactory ??
    ((projectRoot: string) => createWorkflowStepExecutor(projectRoot));

  for (const entry of entries) {
    const workflowPath = await resolveWorkflowFilePath(
      input.workflowsDir,
      entry.workflowRef.file,
      `resources[${entry.index}].workflowRef.file`,
    );
    const workflow = parseWorkflowFile(
      parseYaml(await Deno.readTextFile(workflowPath)),
      `workflow file ${workflowPath}`,
    );
    const stepStdouts: string[] = [];
    const baseExecutor = executorFactory(input.projectRoot);
    const wrappedExecutor: StepExecutor = async (run, context) => {
      const outcome = await baseExecutor(run, context);
      stepStdouts.push(outcome.stdout);
      return outcome;
    };
    const result = await runWorkflow({
      file: workflow,
      job: entry.workflowRef.job,
      event: {
        kind: "manual",
        source: `takosumi-git install ${entry.name}`,
      } satisfies WorkflowEvent,
      executor: wrappedExecutor,
      resolveArtifact: installArtifactResolver(
        () => stepStdouts,
        entry.workflowRef,
      ),
    });
    if (!result.success) {
      throw new Error(
        `workflow job '${entry.workflowRef.job}' (resource '${entry.name}') failed:\n${
          result.logs.join("\n")
        }`,
      );
    }
    if (!result.artifact) {
      throw new Error(
        `workflow job '${entry.workflowRef.job}' (resource '${entry.name}') produced no artifact; add an 'artifact' field to the job spec so the runner resolves a URI`,
      );
    }
    validateInstallArtifactTarget(entry, result.artifact.uri);
    setInstallResourceArtifactTarget(
      manifest,
      entry.index,
      result.artifact.uri,
      entry.workflowRef.target,
    );
  }

  stripInstallWorkflowRefs(manifest);
  validateInstallManifestImagePins(manifest);
  return {
    ...input.compiled,
    manifest,
    digest: digestJson(manifest),
  };
}

function installWorkflowResourceEntries(
  manifest: Record<string, unknown>,
): InstallWorkflowResourceEntry[] {
  const resources = manifest.resources;
  if (!Array.isArray(resources)) return [];
  const entries: InstallWorkflowResourceEntry[] = [];
  for (const [index, raw] of resources.entries()) {
    if (!isRecord(raw) || !isRecord(raw.workflowRef)) continue;
    const ref = raw.workflowRef;
    if (
      typeof ref.file !== "string" ||
      typeof ref.job !== "string" ||
      typeof ref.artifact !== "string" ||
      (ref.target !== undefined && typeof ref.target !== "string")
    ) {
      throw new Error(
        `resources[${index}].workflowRef must have string {file, job, artifact, target?}`,
      );
    }
    const target = ref.target === undefined
      ? undefined
      : parseInstallArtifactTarget(
        ref.target,
        `resources[${index}].workflowRef.target`,
      );
    entries.push({
      index,
      name: typeof raw.name === "string" ? raw.name : `resources[${index}]`,
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

function parseInstallArtifactTarget(
  value: string,
  path: string,
): `spec.${string}` {
  if (!/^spec(?:\.[A-Za-z_][A-Za-z0-9_-]*)+$/.test(value)) {
    throw new Error(
      `${path} must be a dotted field path below spec, such as spec.image or spec.artifact.hash`,
    );
  }
  return value as `spec.${string}`;
}

function installArtifactResolver(
  capturedLogs: () => readonly string[],
  ref: ComputeWorkflowRef,
): ArtifactResolver {
  return (job: WorkflowJobSpec, _event: WorkflowEvent) =>
    Promise.resolve({
      name: job.artifact?.name ?? ref.artifact,
      uri: resolveInstallArtifactUri(capturedLogs(), job.name),
    });
}

function resolveInstallArtifactUri(
  logs: readonly string[],
  jobName: string,
): string {
  for (let i = logs.length - 1; i >= 0; i--) {
    const marker = findInstallArtifactMarker(logs[i]);
    if (marker) return marker;
  }
  throw new Error(
    `workflow job '${jobName}' produced no ${installArtifactMarkerPrefix}<uri> marker; cannot resolve artifact URI`,
  );
}

function findInstallArtifactMarker(text: string): string | undefined {
  const stdoutOnly = text.split("\n[stderr]\n")[0] ?? text;
  const lines = stdoutOnly.split("\n").map((line) => line.trim()).filter((
    line,
  ) => line.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith(installArtifactMarkerPrefix)) continue;
    const uri = line.slice(installArtifactMarkerPrefix.length).trim();
    if (!uri) {
      throw new Error(
        `${installArtifactMarkerPrefix}<uri> marker must include a URI`,
      );
    }
    return uri;
  }
}

function validateInstallArtifactTarget(
  entry: InstallWorkflowResourceEntry,
  uri: string,
): void {
  const target = entry.workflowRef.target ?? "spec.image";
  if (target !== "spec.image") return;
  if (digestPinnedImagePattern.test(uri)) return;
  throw new Error(
    `workflow job '${entry.workflowRef.job}' (resource '${entry.name}') resolved '${uri}', but spec.image artifacts must be digest-pinned as <image>@sha256:<64-hex>`,
  );
}

function setInstallResourceArtifactTarget(
  manifest: Record<string, unknown>,
  index: number,
  uri: string,
  target = "spec.image",
): void {
  const resources = manifest.resources;
  if (!Array.isArray(resources)) return;
  const entry = resources[index];
  if (!isRecord(entry)) return;
  if (!isRecord(entry.spec)) entry.spec = {};
  const parts = target.split(".");
  let current = entry as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (isRecord(next)) {
      current = next;
      continue;
    }
    const created: Record<string, unknown> = {};
    current[part] = created;
    current = created;
  }
  current[parts[parts.length - 1]] = uri;
}

function stripInstallWorkflowRefs(manifest: Record<string, unknown>): void {
  const resources = manifest.resources;
  if (!Array.isArray(resources)) return;
  for (const entry of resources) {
    if (isRecord(entry) && "workflowRef" in entry) delete entry.workflowRef;
  }
}

function validateInstallManifestImagePins(
  manifest: Record<string, unknown>,
): void {
  const resources = manifest.resources;
  if (!Array.isArray(resources)) return;
  for (const [index, resource] of resources.entries()) {
    if (!isRecord(resource) || !isRecord(resource.spec)) continue;
    const shape = typeof resource.shape === "string" ? resource.shape : "";
    if (!shape.startsWith("web-service@") && !shape.startsWith("worker@")) {
      continue;
    }
    const image = resource.spec.image;
    if (typeof image !== "string") continue;
    if (digestPinnedImagePattern.test(image)) continue;
    throw new Error(
      `manifest.resources[${index}].spec.image must be digest-pinned as <image>@sha256:<64-hex>`,
    );
  }
}
