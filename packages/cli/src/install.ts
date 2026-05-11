/**
 * `takosumi-git install` preview support.
 *
 * `.takosumi/app.yml` is installer-bound metadata. It never gets submitted to
 * the takosumi kernel; it feeds preview, approval, AppInstallation creation,
 * and later manifest compilation.
 */

import { createHash } from "node:crypto";
import { parseArgs } from "@std/cli/parse-args";
import { parse as parseYaml } from "@std/yaml";
import { dirname, isAbsolute, join, resolve } from "@std/path";
import {
  type DeployResponse,
  type ManifestEnvelope,
  postDeployment,
} from "@takos/takosumi-git-deploy-client";
import type {
  ComputeWorkflowRef,
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

export const INSTALLABLE_APP_API_VERSION = "app.takosumi.dev/v1";
export const INSTALLABLE_APP_KIND = "InstallableApp";

export const INSTALLABLE_APP_BINDING_TYPES = [
  "identity.oidc@v1",
  "database.postgres@v1",
  "object-store.s3-compatible@v1",
  "domain.http@v1",
  "deploy-intent.gitops@v1",
  "install-launch-token@v1",
] as const;

export const INSTALLABLE_APP_RUNTIME_MODES = [
  "shared-cell",
  "dedicated",
  "self-hosted",
] as const;

export const INSTALLABLE_APP_PERMISSIONS = [
  "app.profile.write",
  "app.memory.write",
  "deploy.intent.write",
  "logs.read.own",
  "billing.usage.report",
  "spaces:read",
  "spaces:write",
  "files:read",
  "files:write",
  "memories:read",
  "memories:write",
  "threads:read",
  "threads:write",
  "runs:read",
  "runs:write",
  "agents:execute",
  "repos:read",
  "repos:write",
  "mcp:invoke",
  "events:subscribe",
] as const;

const UPGRADE_POLICIES = ["automatic", "ask", "manual"] as const;

export type InstallableAppBindingType =
  typeof INSTALLABLE_APP_BINDING_TYPES[number];
export type InstallableAppRuntimeMode =
  typeof INSTALLABLE_APP_RUNTIME_MODES[number];
export type InstallableAppPermission =
  typeof INSTALLABLE_APP_PERMISSIONS[number];
export type InstallableAppUpgradePolicy = typeof UPGRADE_POLICIES[number];

export interface InstallableApp {
  readonly apiVersion: typeof INSTALLABLE_APP_API_VERSION;
  readonly kind: typeof INSTALLABLE_APP_KIND;
  readonly metadata: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly publisher: string;
    readonly homepage: string;
    readonly signingKeyFingerprint?: string;
  };
  readonly source: {
    readonly git: string;
    readonly ref: string;
    readonly commit?: string;
  };
  readonly entry: {
    readonly manifest: string;
  };
  readonly runtime: {
    readonly modes: readonly InstallableAppRuntimeMode[];
  };
  readonly bindings: Readonly<Record<string, InstallableAppBinding>>;
  readonly install: {
    readonly healthcheckPath: string;
    readonly postInstallLaunchPath: string;
  };
  readonly permissions: {
    readonly requested: readonly InstallableAppPermission[];
  };
  readonly upgrade?: {
    readonly policy: {
      readonly securityPatch?: InstallableAppUpgradePolicy;
      readonly minor?: InstallableAppUpgradePolicy;
      readonly major?: InstallableAppUpgradePolicy;
    };
  };
  readonly compatibility?: {
    readonly "takosumi-git"?: string;
    readonly kernel?: string;
  };
}

export interface InstallableAppBinding {
  readonly type: InstallableAppBindingType;
  readonly required: boolean;
  readonly redirectPaths?: readonly string[];
  readonly subjectMode?: "pairwise";
  readonly tokenEndpointAuthMethod?:
    | "client_secret_basic"
    | "client_secret_post"
    | "private_key_jwt";
  readonly allowedScopes?: readonly string[];
  readonly plan?: string;
  readonly version?: string;
  readonly extensions?: readonly string[];
  readonly backupRetentionDays?: number;
  readonly encryption?: Record<string, unknown>;
  readonly lifecycleDays?: number;
  readonly hostname?: "auto" | { readonly custom: string };
  readonly tlsMode?: "auto" | "managed" | "byo";
  readonly tlsCertRef?: string;
  readonly branch?: string;
  readonly writePathPrefix?: string;
  readonly consumePath?: string;
  readonly maxLifetimeSeconds?: number;
}

export interface InstallPreview {
  readonly kind: "takosumi-git.install-preview@v1";
  readonly previewId: `preview_${string}`;
  readonly expiresAt: string;
  readonly app: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly homepage: string;
  };
  readonly publisher: {
    readonly id: string;
    readonly verified: boolean;
    readonly signingKeyFingerprint?: string;
  };
  readonly source: {
    readonly git: string;
    readonly ref: string;
    readonly commit?: string;
    readonly pinned: boolean;
    readonly appManifestDigest?: string;
    readonly compiledManifestDigest?: string;
    readonly manifestPath: string;
  };
  readonly runtime: {
    readonly modes: readonly InstallableAppRuntimeMode[];
  };
  readonly bindings: readonly {
    readonly name: string;
    readonly type: InstallableAppBindingType;
    readonly required: boolean;
    readonly redirectPaths?: readonly string[];
  }[];
  readonly permissions: {
    readonly requested: readonly InstallableAppPermission[];
  };
  readonly permissionDigest: `sha256:${string}`;
  readonly cost: {
    readonly estimate: "unknown";
    readonly meteredBindingCount: number;
    readonly note: string;
  };
  readonly risk: {
    readonly level: "low" | "medium" | "high";
    readonly reasons: readonly string[];
  };
  readonly approvalRequired: boolean;
  readonly compatibility: {
    readonly requirements: Record<string, string>;
    readonly warnings: readonly string[];
  };
}

export interface InstallOidcClientCreateRequest {
  readonly binding: string;
  readonly namespacePath: string;
  readonly redirectUris: readonly string[];
  readonly allowedScopes: readonly string[];
  readonly subjectMode: "pairwise";
  readonly tokenEndpointAuthMethod?:
    | "client_secret_basic"
    | "client_secret_post"
    | "none";
}

export interface CompiledInstallManifest {
  readonly manifest: Record<string, unknown>;
  readonly digest: `sha256:${string}`;
}

interface InstallWorkflowResourceEntry {
  readonly index: number;
  readonly name: string;
  readonly workflowRef: ComputeWorkflowRef;
}

export interface InstallableAppValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class InstallableAppValidationError extends Error {
  readonly issues: readonly InstallableAppValidationIssue[];

  constructor(issues: readonly InstallableAppValidationIssue[]) {
    super(
      `invalid .takosumi/app.yml: ${
        issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")
      }`,
    );
    this.name = "InstallableAppValidationError";
    this.issues = issues;
  }
}

const DEFAULT_APP_PATH = ".takosumi/app.yml";
const reverseDomainPattern = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const publisherPattern = /^[a-z0-9]([a-z0-9-]{0,78}[a-z0-9])?$/;
const bindingNamePattern = /^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$/;
const pathPattern = /^\/[^?#]{0,199}$/;
const fullCommitPattern = /^[0-9a-f]{40}$/;
const installerPlaceholderPattern =
  /\$\{(?:params|installation|artifacts|bindings|secrets|refs|imports)\.[^}]+}/;
const installerPlaceholderGlobalPattern =
  /\$\{(params|installation|artifacts|bindings|secrets|refs|imports)\.([^}]+)}/g;
const installArtifactMarkerPrefix = "TAKOSUMI_ARTIFACT=";
const digestPinnedImagePattern = /^.+@sha256:[0-9a-f]{64}$/;
const workflowEnvAllowlist = [
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
const semverTagPattern = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const releaseTagPattern = /^release[/-][0-9][0-9A-Za-z._-]*$/;
const mutableRefs = new Set([
  "HEAD",
  "head",
  "main",
  "master",
  "develop",
  "latest",
]);
const postgresPlans = new Set(["nano", "small", "medium", "large", "xlarge"]);
const postgresVersions = new Set(["15", "16", "17"]);
const postgresExtensions = new Set([
  "pgvector",
  "pgcrypto",
  "uuid-ossp",
  "pg_stat_statements",
  "pg_trgm",
]);
const objectStorePlans = new Set(["standard", "infrequent-access", "archive"]);
const tlsModes = new Set(["auto", "managed", "byo"]);
const oidcAuthMethods = new Set([
  "client_secret_basic",
  "client_secret_post",
  "private_key_jwt",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(
  record: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
  issues: InstallableAppValidationIssue[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      issues.push({ path: `${path}.${key}`, message: "is not allowed" });
    }
  }
}

function requiredRecord(
  record: Record<string, unknown>,
  key: string,
  issues: InstallableAppValidationIssue[],
): Record<string, unknown> {
  const value = record[key];
  if (isRecord(value)) return value;
  issues.push({ path: key, message: "must be an object" });
  return {};
}

function stringField(
  record: Record<string, unknown>,
  path: string,
  issues: InstallableAppValidationIssue[],
): string {
  const value = path.split(".").reduce<unknown>((current, key) => {
    return isRecord(current) ? current[key] : undefined;
  }, record);
  if (typeof value === "string" && value.length > 0) return value;
  issues.push({ path, message: "must be a non-empty string" });
  return "";
}

function optionalStringField(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: InstallableAppValidationIssue[],
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.length > 0) return value;
  issues.push({ path, message: "must be a non-empty string" });
  return undefined;
}

function booleanField(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: InstallableAppValidationIssue[],
): boolean {
  const value = record[key];
  if (typeof value === "boolean") return value;
  issues.push({ path, message: "must be a boolean" });
  return false;
}

function integerField(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: InstallableAppValidationIssue[],
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (Number.isInteger(value)) return Number(value);
  issues.push({ path, message: "must be an integer" });
  return undefined;
}

function assertLength(
  value: string,
  path: string,
  min: number,
  max: number,
  issues: InstallableAppValidationIssue[],
): void {
  if (value.length < min || value.length > max) {
    issues.push({ path, message: `must be ${min}-${max} characters` });
  }
}

function assertHttpsUrl(
  value: string,
  path: string,
  issues: InstallableAppValidationIssue[],
): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      issues.push({ path, message: "must be an https URL" });
    }
  } catch {
    issues.push({ path, message: "must be a valid URL" });
  }
}

function validateSourceRef(
  ref: string,
  issues: InstallableAppValidationIssue[],
): void {
  if (
    mutableRefs.has(ref) ||
    ref.startsWith("refs/heads/") ||
    ref.startsWith("origin/")
  ) {
    issues.push({ path: "source.ref", message: `looks mutable: ${ref}` });
    return;
  }
  if (
    fullCommitPattern.test(ref) ||
    semverTagPattern.test(ref) ||
    releaseTagPattern.test(ref) ||
    (ref.startsWith("refs/tags/") && ref.length > "refs/tags/".length)
  ) {
    return;
  }
  issues.push({
    path: "source.ref",
    message:
      "must be a full commit SHA, semver tag, release tag, or refs/tags/<tag>",
  });
}

function validateRelativePath(
  value: string,
  path: string,
  issues: InstallableAppValidationIssue[],
): void {
  if (isAbsolute(value) || value.split("/").includes("..")) {
    issues.push({ path, message: "must be a repo-relative path without .." });
  }
}

function validateUniqueStringArray(
  value: unknown,
  path: string,
  allowed: readonly string[],
  min: number,
  max: number,
  issues: InstallableAppValidationIssue[],
): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    issues.push({
      path,
      message: `must be an array with ${min}-${max} entries`,
    });
    return [];
  }
  const allowedSet = new Set(allowed);
  const seen = new Set<string>();
  const output: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !allowedSet.has(entry)) {
      issues.push({
        path,
        message: `contains unsupported value ${String(entry)}`,
      });
      continue;
    }
    if (seen.has(entry)) {
      issues.push({ path, message: `contains duplicate value ${entry}` });
      continue;
    }
    seen.add(entry);
    output.push(entry);
  }
  return output;
}

function validatePathArray(
  value: unknown,
  path: string,
  min: number,
  max: number,
  issues: InstallableAppValidationIssue[],
): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    issues.push({ path, message: `must contain ${min}-${max} paths` });
    return [];
  }
  const output: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !pathPattern.test(entry)) {
      issues.push({ path, message: "must contain slash-prefixed paths" });
      continue;
    }
    output.push(entry);
  }
  return output;
}

function validateOptionalStringArray(
  value: unknown,
  path: string,
  issues: InstallableAppValidationIssue[],
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array" });
    return undefined;
  }
  const output: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      issues.push({ path, message: "must contain non-empty strings" });
      continue;
    }
    output.push(entry);
  }
  return output;
}

function parseBindings(
  record: Record<string, unknown>,
  issues: InstallableAppValidationIssue[],
): Record<string, InstallableAppBinding> {
  const bindingsRaw = requiredRecord(record, "bindings", issues);
  if (
    Object.keys(bindingsRaw).length < 1 ||
    Object.keys(bindingsRaw).length > 32
  ) {
    issues.push({ path: "bindings", message: "must contain 1-32 entries" });
  }
  const bindings: Record<string, InstallableAppBinding> = {};
  for (const [name, raw] of Object.entries(bindingsRaw)) {
    if (!bindingNamePattern.test(name)) {
      issues.push({
        path: `bindings.${name}`,
        message: "name must match ^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$",
      });
    }
    if (!isRecord(raw)) {
      issues.push({ path: `bindings.${name}`, message: "must be an object" });
      continue;
    }
    const type = raw.type;
    if (
      typeof type !== "string" ||
      !INSTALLABLE_APP_BINDING_TYPES.includes(type as InstallableAppBindingType)
    ) {
      issues.push({
        path: `bindings.${name}.type`,
        message: "must be one of the v1 binding catalog identifiers",
      });
      continue;
    }
    const allowedKeys = bindingAllowedKeys(type as InstallableAppBindingType);
    unknownKeys(raw, `bindings.${name}`, allowedKeys, issues);
    const binding: Record<string, unknown> = {
      type,
      required: bindingRequired(
        type as InstallableAppBindingType,
        raw,
        `bindings.${name}.required`,
        issues,
      ),
    };
    parseBindingSpecificFields(
      name,
      type as InstallableAppBindingType,
      raw,
      binding,
      issues,
    );
    bindings[name] = binding as unknown as InstallableAppBinding;
  }
  return bindings;
}

function bindingAllowedKeys(
  type: InstallableAppBindingType,
): readonly string[] {
  const common = ["type", "required"];
  switch (type) {
    case "identity.oidc@v1":
      return [
        ...common,
        "redirectPaths",
        "subjectMode",
        "tokenEndpointAuthMethod",
        "allowedScopes",
      ];
    case "database.postgres@v1":
      return [
        ...common,
        "plan",
        "version",
        "extensions",
        "backupRetentionDays",
      ];
    case "object-store.s3-compatible@v1":
      return [...common, "plan", "encryption", "lifecycleDays"];
    case "domain.http@v1":
      return [...common, "hostname", "tlsMode", "tlsCertRef"];
    case "deploy-intent.gitops@v1":
      return [...common, "branch", "writePathPrefix"];
    case "install-launch-token@v1":
      return [...common, "consumePath", "maxLifetimeSeconds"];
  }
}

function parseBindingSpecificFields(
  name: string,
  type: InstallableAppBindingType,
  raw: Record<string, unknown>,
  binding: Record<string, unknown>,
  issues: InstallableAppValidationIssue[],
): void {
  if (type === "identity.oidc@v1") {
    binding.redirectPaths = validatePathArray(
      raw.redirectPaths,
      `bindings.${name}.redirectPaths`,
      1,
      10,
      issues,
    );
    if (raw.subjectMode !== undefined) {
      if (raw.subjectMode !== "pairwise") {
        issues.push({
          path: `bindings.${name}.subjectMode`,
          message: "must be pairwise",
        });
      } else binding.subjectMode = raw.subjectMode;
    }
    if (raw.tokenEndpointAuthMethod !== undefined) {
      if (!oidcAuthMethods.has(String(raw.tokenEndpointAuthMethod))) {
        issues.push({
          path: `bindings.${name}.tokenEndpointAuthMethod`,
          message: "is not supported",
        });
      } else binding.tokenEndpointAuthMethod = raw.tokenEndpointAuthMethod;
    }
    const scopes = validateOptionalStringArray(
      raw.allowedScopes,
      `bindings.${name}.allowedScopes`,
      issues,
    );
    if (scopes) {
      if (!scopes.includes("openid")) {
        issues.push({
          path: `bindings.${name}.allowedScopes`,
          message: "must include openid",
        });
      }
      binding.allowedScopes = scopes;
    }
  } else if (type === "database.postgres@v1") {
    if (!postgresPlans.has(String(raw.plan))) {
      issues.push({
        path: `bindings.${name}.plan`,
        message: "must be nano, small, medium, large, or xlarge",
      });
    } else binding.plan = raw.plan;
    if (raw.version !== undefined) {
      if (!postgresVersions.has(String(raw.version))) {
        issues.push({
          path: `bindings.${name}.version`,
          message: "must be 15, 16, or 17",
        });
      } else binding.version = String(raw.version);
    }
    const extensions = validateOptionalStringArray(
      raw.extensions,
      `bindings.${name}.extensions`,
      issues,
    );
    if (
      extensions &&
      extensions.some((extension) => !postgresExtensions.has(extension))
    ) {
      issues.push({
        path: `bindings.${name}.extensions`,
        message: "contains an extension outside the allowlist",
      });
    } else if (extensions) binding.extensions = extensions;
    const backupRetentionDays = integerField(
      raw,
      "backupRetentionDays",
      `bindings.${name}.backupRetentionDays`,
      issues,
    );
    if (backupRetentionDays !== undefined) {
      if (backupRetentionDays < 1 || backupRetentionDays > 35) {
        issues.push({
          path: `bindings.${name}.backupRetentionDays`,
          message: "must be from 1 to 35",
        });
      } else binding.backupRetentionDays = backupRetentionDays;
    }
  } else if (type === "object-store.s3-compatible@v1") {
    if (!objectStorePlans.has(String(raw.plan))) {
      issues.push({
        path: `bindings.${name}.plan`,
        message: "must be standard, infrequent-access, or archive",
      });
    } else binding.plan = raw.plan;
    if (raw.encryption !== undefined) {
      if (!isRecord(raw.encryption)) {
        issues.push({
          path: `bindings.${name}.encryption`,
          message: "must be an object",
        });
      } else if (
        raw.encryption.mode !== "sse-s3" &&
        raw.encryption.mode !== "sse-kms"
      ) {
        issues.push({
          path: `bindings.${name}.encryption.mode`,
          message: "must be sse-s3 or sse-kms",
        });
      } else if (
        raw.encryption.mode === "sse-kms" &&
        typeof raw.encryption.kmsKeyRef !== "string"
      ) {
        issues.push({
          path: `bindings.${name}.encryption.kmsKeyRef`,
          message: "is required for sse-kms",
        });
      } else binding.encryption = raw.encryption;
    }
    const lifecycleDays = integerField(
      raw,
      "lifecycleDays",
      `bindings.${name}.lifecycleDays`,
      issues,
    );
    if (lifecycleDays !== undefined) {
      if (lifecycleDays < 0) {
        issues.push({
          path: `bindings.${name}.lifecycleDays`,
          message: "must be non-negative",
        });
      } else binding.lifecycleDays = lifecycleDays;
    }
  } else if (type === "domain.http@v1") {
    if (
      raw.hostname === "auto" ||
      (isRecord(raw.hostname) && typeof raw.hostname.custom === "string" &&
        raw.hostname.custom.length > 0)
    ) {
      binding.hostname = raw.hostname;
    } else {
      issues.push({
        path: `bindings.${name}.hostname`,
        message: "must be auto or { custom: string }",
      });
    }
    if (raw.tlsMode !== undefined) {
      if (!tlsModes.has(String(raw.tlsMode))) {
        issues.push({
          path: `bindings.${name}.tlsMode`,
          message: "must be auto, managed, or byo",
        });
      } else binding.tlsMode = raw.tlsMode;
    }
    binding.tlsCertRef = optionalStringField(
      raw,
      "tlsCertRef",
      `bindings.${name}.tlsCertRef`,
      issues,
    );
    if (raw.tlsMode === "byo" && !binding.tlsCertRef) {
      issues.push({
        path: `bindings.${name}.tlsCertRef`,
        message: "is required when tlsMode is byo",
      });
    }
  } else if (type === "deploy-intent.gitops@v1") {
    binding.branch = optionalStringField(
      raw,
      "branch",
      `bindings.${name}.branch`,
      issues,
    );
    binding.writePathPrefix = optionalStringField(
      raw,
      "writePathPrefix",
      `bindings.${name}.writePathPrefix`,
      issues,
    );
  } else if (type === "install-launch-token@v1") {
    binding.consumePath = optionalStringField(
      raw,
      "consumePath",
      `bindings.${name}.consumePath`,
      issues,
    );
    if (binding.consumePath && !pathPattern.test(String(binding.consumePath))) {
      issues.push({
        path: `bindings.${name}.consumePath`,
        message: "must be a slash-prefixed path",
      });
    }
    const maxLifetimeSeconds = integerField(
      raw,
      "maxLifetimeSeconds",
      `bindings.${name}.maxLifetimeSeconds`,
      issues,
    );
    if (maxLifetimeSeconds !== undefined) {
      if (maxLifetimeSeconds < 30 || maxLifetimeSeconds > 300) {
        issues.push({
          path: `bindings.${name}.maxLifetimeSeconds`,
          message: "must be from 30 to 300",
        });
      } else binding.maxLifetimeSeconds = maxLifetimeSeconds;
    }
  }
}

function bindingRequired(
  _type: InstallableAppBindingType,
  record: Record<string, unknown>,
  path: string,
  issues: InstallableAppValidationIssue[],
): boolean {
  return booleanField(record, "required", path, issues);
}

export function parseInstallableAppObject(input: unknown): InstallableApp {
  const issues: InstallableAppValidationIssue[] = [];
  if (!isRecord(input)) {
    throw new InstallableAppValidationError([
      { path: "$", message: "must be an object" },
    ]);
  }
  unknownKeys(input, "$", [
    "apiVersion",
    "kind",
    "metadata",
    "source",
    "entry",
    "runtime",
    "bindings",
    "install",
    "permissions",
    "upgrade",
    "compatibility",
  ], issues);

  if (input.apiVersion !== INSTALLABLE_APP_API_VERSION) {
    issues.push({
      path: "apiVersion",
      message: `must be ${INSTALLABLE_APP_API_VERSION}`,
    });
  }
  if (input.kind !== INSTALLABLE_APP_KIND) {
    issues.push({ path: "kind", message: `must be ${INSTALLABLE_APP_KIND}` });
  }

  const metadata = requiredRecord(input, "metadata", issues);
  unknownKeys(metadata, "metadata", [
    "id",
    "name",
    "description",
    "publisher",
    "homepage",
    "signingKeyFingerprint",
  ], issues);
  const id = stringField(input, "metadata.id", issues);
  if (id && !reverseDomainPattern.test(id)) {
    issues.push({
      path: "metadata.id",
      message: "must be a reverse-domain identifier",
    });
  }
  assertLength(id, "metadata.id", 1, 200, issues);
  const name = stringField(input, "metadata.name", issues);
  assertLength(name, "metadata.name", 1, 80, issues);
  const description = stringField(input, "metadata.description", issues);
  assertLength(description, "metadata.description", 1, 500, issues);
  const publisher = stringField(input, "metadata.publisher", issues);
  if (publisher && !publisherPattern.test(publisher)) {
    issues.push({
      path: "metadata.publisher",
      message: "must be a publisher slug",
    });
  }
  const homepage = stringField(input, "metadata.homepage", issues);
  if (homepage) assertHttpsUrl(homepage, "metadata.homepage", issues);
  const signingKeyFingerprint = optionalStringField(
    metadata,
    "signingKeyFingerprint",
    "metadata.signingKeyFingerprint",
    issues,
  );
  if (
    signingKeyFingerprint &&
    !/^SHA256:[A-Za-z0-9+/=_-]+$/.test(signingKeyFingerprint)
  ) {
    issues.push({
      path: "metadata.signingKeyFingerprint",
      message: "must start with SHA256:",
    });
  }

  const source = requiredRecord(input, "source", issues);
  unknownKeys(source, "source", ["git", "ref", "commit"], issues);
  const git = stringField(input, "source.git", issues);
  if (git && !git.startsWith("https://") && !/^git@[^:]+:.+/.test(git)) {
    issues.push({
      path: "source.git",
      message: "must be an https URL or git@host:path URL",
    });
  }
  const ref = stringField(input, "source.ref", issues);
  if (ref) validateSourceRef(ref, issues);
  const commit = optionalStringField(source, "commit", "source.commit", issues);
  if (commit && !fullCommitPattern.test(commit)) {
    issues.push({ path: "source.commit", message: "must be a 40-char SHA" });
  }

  const entry = requiredRecord(input, "entry", issues);
  unknownKeys(entry, "entry", ["manifest"], issues);
  const manifest = stringField(input, "entry.manifest", issues);
  if (manifest) validateRelativePath(manifest, "entry.manifest", issues);

  const runtime = requiredRecord(input, "runtime", issues);
  unknownKeys(runtime, "runtime", ["modes"], issues);
  const modes = validateUniqueStringArray(
    runtime.modes,
    "runtime.modes",
    INSTALLABLE_APP_RUNTIME_MODES,
    1,
    3,
    issues,
  ) as InstallableAppRuntimeMode[];

  const bindings = parseBindings(input, issues);
  const install = requiredRecord(input, "install", issues);
  unknownKeys(install, "install", [
    "healthcheckPath",
    "postInstallLaunchPath",
  ], issues);
  const healthcheckPath = stringField(input, "install.healthcheckPath", issues);
  if (healthcheckPath && !pathPattern.test(healthcheckPath)) {
    issues.push({
      path: "install.healthcheckPath",
      message: "must be a slash-prefixed path without query",
    });
  }
  const postInstallLaunchPath = stringField(
    input,
    "install.postInstallLaunchPath",
    issues,
  );
  if (postInstallLaunchPath && !pathPattern.test(postInstallLaunchPath)) {
    issues.push({
      path: "install.postInstallLaunchPath",
      message: "must be a slash-prefixed path without query",
    });
  }

  const permissions = requiredRecord(input, "permissions", issues);
  unknownKeys(permissions, "permissions", ["requested"], issues);
  const requested = validateUniqueStringArray(
    permissions.requested,
    "permissions.requested",
    INSTALLABLE_APP_PERMISSIONS,
    0,
    32,
    issues,
  ) as InstallableAppPermission[];

  const upgrade = parseUpgrade(input.upgrade, issues);
  const compatibility = parseCompatibility(input.compatibility, issues);

  if (issues.length > 0) throw new InstallableAppValidationError(issues);
  return {
    apiVersion: INSTALLABLE_APP_API_VERSION,
    kind: INSTALLABLE_APP_KIND,
    metadata: {
      id,
      name,
      description,
      publisher,
      homepage,
      ...(signingKeyFingerprint ? { signingKeyFingerprint } : {}),
    },
    source: {
      git,
      ref,
      ...(commit ? { commit } : {}),
    },
    entry: { manifest },
    runtime: { modes },
    bindings,
    install: { healthcheckPath, postInstallLaunchPath },
    permissions: { requested },
    ...(upgrade ? { upgrade } : {}),
    ...(compatibility ? { compatibility } : {}),
  };
}

function parseUpgrade(
  value: unknown,
  issues: InstallableAppValidationIssue[],
): InstallableApp["upgrade"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push({ path: "upgrade", message: "must be an object" });
    return undefined;
  }
  unknownKeys(value, "upgrade", ["policy"], issues);
  const policyRaw = value.policy;
  if (!isRecord(policyRaw)) {
    issues.push({ path: "upgrade.policy", message: "must be an object" });
    return undefined;
  }
  const policy = policyRaw;
  unknownKeys(
    policy,
    "upgrade.policy",
    ["securityPatch", "minor", "major"],
    issues,
  );
  const parsed: Record<string, InstallableAppUpgradePolicy> = {};
  for (const key of ["securityPatch", "minor", "major"]) {
    const raw = policy[key];
    if (raw === undefined) continue;
    if (!UPGRADE_POLICIES.includes(raw as InstallableAppUpgradePolicy)) {
      issues.push({
        path: `upgrade.policy.${key}`,
        message: "is not supported",
      });
      continue;
    }
    parsed[key] = raw as InstallableAppUpgradePolicy;
  }
  return { policy: parsed };
}

function parseCompatibility(
  value: unknown,
  issues: InstallableAppValidationIssue[],
): InstallableApp["compatibility"] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push({ path: "compatibility", message: "must be an object" });
    return undefined;
  }
  unknownKeys(value, "compatibility", ["takosumi-git", "kernel"], issues);
  const takosumiGit = optionalStringField(
    value,
    "takosumi-git",
    "compatibility.takosumi-git",
    issues,
  );
  const kernel = optionalStringField(
    value,
    "kernel",
    "compatibility.kernel",
    issues,
  );
  return {
    ...(takosumiGit ? { "takosumi-git": takosumiGit } : {}),
    ...(kernel ? { kernel } : {}),
  };
}

export function parseInstallableAppYaml(text: string): InstallableApp {
  return parseInstallableAppObject(parseYaml(text));
}

export function digestText(text: string): `sha256:${string}` {
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
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const canonical = canonicalize((value as Record<string, unknown>)[key]);
      if (canonical !== undefined) output[key] = canonical;
    }
    return output;
  }
  return value;
}

export function isPinnedSource(app: InstallableApp): boolean {
  return !!app.source.commit || fullCommitPattern.test(app.source.ref) ||
    app.source.ref.startsWith("refs/tags/") ||
    semverTagPattern.test(app.source.ref) ||
    releaseTagPattern.test(app.source.ref);
}

export function buildInstallPreview(
  app: InstallableApp,
  options: {
    readonly appManifestDigest?: string;
    readonly compiledManifestDigest?: string;
    readonly compatibilityWarnings?: readonly string[];
    readonly now?: Date;
  } = {},
): InstallPreview {
  const bindings = Object.entries(app.bindings).map(([name, binding]) => ({
    name,
    type: binding.type,
    required: binding.required,
    ...(binding.redirectPaths ? { redirectPaths: binding.redirectPaths } : {}),
  })).sort((a, b) => a.name.localeCompare(b.name));
  const meteredBindingCount =
    bindings.filter((binding) =>
      binding.type === "database.postgres@v1" ||
      binding.type === "object-store.s3-compatible@v1" ||
      binding.type === "domain.http@v1"
    ).length;
  const requirements: Record<string, string> = {};
  if (app.compatibility?.["takosumi-git"]) {
    requirements["takosumi-git"] = app.compatibility["takosumi-git"];
  }
  if (app.compatibility?.kernel) requirements.kernel = app.compatibility.kernel;
  const permissionDigest = digestJson({
    bindingKinds: bindings.map((binding) => binding.type).sort(),
    grants: [...app.permissions.requested].sort(),
  });
  const risk = installPreviewRisk({
    verifiedPublisher: !!app.metadata.signingKeyFingerprint,
    pinnedSource: isPinnedSource(app),
    requiredMeteredBindingCount: bindings.filter((binding) =>
      binding.required &&
      (binding.type === "database.postgres@v1" ||
        binding.type === "object-store.s3-compatible@v1" ||
        binding.type === "domain.http@v1")
    ).length,
  });
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
  const previewId = `preview_${
    digestJson({
      appId: app.metadata.id,
      source: app.source,
      bindings,
      permissions: app.permissions.requested,
      appManifestDigest: options.appManifestDigest,
      compiledManifestDigest: options.compiledManifestDigest,
    }).slice("sha256:".length, "sha256:".length + 24)
  }` as const;
  return {
    kind: "takosumi-git.install-preview@v1",
    previewId,
    expiresAt,
    app: {
      id: app.metadata.id,
      name: app.metadata.name,
      description: app.metadata.description,
      homepage: app.metadata.homepage,
    },
    publisher: {
      id: app.metadata.publisher,
      verified: !!app.metadata.signingKeyFingerprint,
      ...(app.metadata.signingKeyFingerprint
        ? { signingKeyFingerprint: app.metadata.signingKeyFingerprint }
        : {}),
    },
    source: {
      git: app.source.git,
      ref: app.source.ref,
      ...(app.source.commit ? { commit: app.source.commit } : {}),
      pinned: isPinnedSource(app),
      ...(options.appManifestDigest
        ? { appManifestDigest: options.appManifestDigest }
        : {}),
      ...(options.compiledManifestDigest
        ? { compiledManifestDigest: options.compiledManifestDigest }
        : {}),
      manifestPath: app.entry.manifest,
    },
    runtime: { modes: app.runtime.modes },
    bindings,
    permissions: { requested: app.permissions.requested },
    permissionDigest,
    cost: {
      estimate: "unknown",
      meteredBindingCount,
      note:
        "Cost is provider-specific until AppInstallation binding resolution runs.",
    },
    risk,
    approvalRequired: risk.level !== "low" || meteredBindingCount > 0,
    compatibility: {
      requirements,
      warnings: options.compatibilityWarnings ?? [],
    },
  };
}

function installPreviewRisk(input: {
  readonly verifiedPublisher: boolean;
  readonly pinnedSource: boolean;
  readonly requiredMeteredBindingCount: number;
}): InstallPreview["risk"] {
  const reasons: string[] = [];
  if (!input.verifiedPublisher) reasons.push("publisher is not verified");
  if (!input.pinnedSource) {
    reasons.push("source is not pinned to an immutable ref");
  }
  if (input.requiredMeteredBindingCount > 0) {
    reasons.push(
      `${input.requiredMeteredBindingCount} required metered binding(s) need provider approval`,
    );
  }
  const level = !input.verifiedPublisher || !input.pinnedSource
    ? "high"
    : input.requiredMeteredBindingCount > 0
    ? "medium"
    : "low";
  return { level, reasons };
}

function renderHumanPreview(preview: InstallPreview): string {
  const lines = [
    "takosumi-git install preview",
    `app: ${preview.app.name} (${preview.app.id})`,
    `publisher: ${preview.publisher.id} (${
      preview.publisher.verified ? "verified" : "unverified"
    })`,
    `preview: ${preview.previewId} expires ${preview.expiresAt}`,
    `source: ${preview.source.git} @ ${preview.source.ref}`,
    `entry manifest: ${preview.source.manifestPath}${
      preview.source.compiledManifestDigest
        ? ` (${preview.source.compiledManifestDigest})`
        : ""
    }`,
    `runtime: ${preview.runtime.modes.join(", ")}`,
    "bindings:",
    ...preview.bindings.map((binding) =>
      `  - ${binding.name}: ${binding.type} ${
        binding.required ? "required" : "optional"
      }${
        binding.redirectPaths
          ? ` redirects=${binding.redirectPaths.join(",")}`
          : ""
      }`
    ),
    "permissions:",
    ...(preview.permissions.requested.length > 0
      ? preview.permissions.requested.map((permission) => `  - ${permission}`)
      : ["  - none"]),
    `cost: ${preview.cost.estimate} (${preview.cost.meteredBindingCount} metered binding(s))`,
    `risk: ${preview.risk.level}${
      preview.approvalRequired ? " (approval required)" : ""
    }`,
  ];
  if (preview.source.appManifestDigest) {
    lines.push(`app manifest: ${preview.source.appManifestDigest}`);
  }
  if (preview.compatibility.warnings.length > 0) {
    lines.push("warnings:");
    for (const warning of preview.compatibility.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

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

async function compileInstallWorkflowRefs(input: {
  readonly compiled: CompiledInstallManifest;
  readonly projectRoot: string;
  readonly workflowsDir: string;
  readonly executorFactory?: (projectRoot: string) => StepExecutor;
}): Promise<CompiledInstallManifest> {
  const manifest = structuredClone(input.compiled.manifest);
  const entries = installWorkflowResourceEntries(manifest);
  const executorFactory = input.executorFactory ??
    ((projectRoot: string) => defaultInstallStepExecutor(projectRoot));

  for (const entry of entries) {
    const workflowPath = join(input.workflowsDir, entry.workflowRef.file);
    const workflow = parseYaml(await Deno.readTextFile(workflowPath));
    if (
      !isRecord(workflow) ||
      !Array.isArray((workflow as unknown as { jobs: unknown }).jobs)
    ) {
      throw new Error(
        `workflow file ${workflowPath} is missing a 'jobs' array`,
      );
    }
    const stepStdouts: string[] = [];
    const baseExecutor = executorFactory(input.projectRoot);
    const wrappedExecutor: StepExecutor = async (run, context) => {
      const outcome = await baseExecutor(run, context);
      stepStdouts.push(outcome.stdout);
      return outcome;
    };
    const result = await runWorkflow({
      file: workflow as unknown as WorkflowFile,
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

function defaultInstallStepExecutor(cwd: string): StepExecutor {
  return async (run, _context): Promise<StepOutcome> => {
    const command = new Deno.Command("bash", {
      args: ["-lc", run],
      cwd,
      clearEnv: true,
      env: installWorkflowSandboxEnv(),
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await command.output();
    const out = new TextDecoder().decode(stdout);
    const err = new TextDecoder().decode(stderr);
    return {
      stdout: err.length > 0 ? `${out}\n[stderr]\n${err}` : out,
      exitCode: code,
    };
  };
}

function installWorkflowSandboxEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
  };
  for (const key of workflowEnvAllowlist) {
    if (key === "PATH") continue;
    const value = Deno.env.get(key);
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function tryRead(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

export interface ParsedInstallArgs {
  readonly subcommand: "preview" | "apply";
  readonly cwd: string;
  readonly appPath: string;
  readonly appPathSpec?: string;
  readonly manifestPath?: string;
  readonly manifestPathSpec?: string;
  readonly json: boolean;
  readonly sourceGitUrl?: string;
  readonly sourceRef?: string;
  readonly accountsUrl?: string;
  readonly token?: string;
  readonly accountId?: string;
  readonly spaceId?: string;
  readonly createdBySubject?: string;
  readonly mode?: InstallableAppRuntimeMode;
  readonly sourceCommit?: string;
  readonly runtimeBaseUrl?: string;
  readonly endpoint?: string;
  readonly deployToken?: string;
}

export interface InstallSourceCheckout {
  readonly root: string;
  readonly commit: string;
  cleanup(): Promise<void>;
}

export interface InstallSourceCheckoutRequest {
  readonly gitUrl: string;
  readonly ref: string;
}

export type InstallSourceCheckoutFactory = (
  request: InstallSourceCheckoutRequest,
) => Promise<InstallSourceCheckout>;

export function parseInstallArgs(
  args: readonly string[],
  env: { get(key: string): string | undefined } = Deno.env,
): ParsedInstallArgs {
  const [first, ...tail] = args;
  if (
    !first || first === "help" || first === "-h" ||
    first === "--help"
  ) {
    throw new InstallHelpRequested();
  }
  const hasExplicitSubcommand = first === "preview" || first === "apply";
  const subcommand = hasExplicitSubcommand ? first : "apply";
  const rest = hasExplicitSubcommand ? tail : args;
  if (subcommand !== "preview" && subcommand !== "apply") {
    throw new Error(`unknown install command '${subcommand}'`);
  }
  rejectRemovedServiceResolverOptions(rest);
  const flags = parseArgs(rest as string[], {
    string: [
      "cwd",
      "app",
      "manifest",
      "git-url",
      "ref",
      "accounts-url",
      "token",
      "account-id",
      "space",
      "space-id",
      "subject",
      "mode",
      "source-commit",
      "runtime-base-url",
      "endpoint",
      "deploy-token",
    ],
    boolean: ["json"],
    default: {
      cwd: ".",
      app: DEFAULT_APP_PATH,
      json: false,
    },
  });
  const positional = (flags._ ?? []).map((value) => String(value));
  if (positional.length > 1) {
    throw new Error("install accepts at most one Git URL argument");
  }
  if (positional.length === 1 && typeof flags["git-url"] === "string") {
    throw new Error("pass either <git-url> or --git-url, not both");
  }
  const sourceGitUrl = (flags["git-url"] as string | undefined) ??
    positional[0];
  const sourceRef = (flags.ref as string | undefined) ??
    (sourceGitUrl ? env.get("TAKOSUMI_INSTALL_REF") : undefined);
  const cwd = resolve(flags.cwd as string);
  const app = flags.app as string;
  const manifest = flags.manifest as string | undefined;
  const mode = flags.mode === undefined
    ? undefined
    : parseRuntimeMode(flags.mode);
  const accountsUrl = (flags["accounts-url"] as string | undefined) ??
    env.get("TAKOSUMI_ACCOUNTS_URL");
  const token = (flags.token as string | undefined) ??
    env.get("TAKOSUMI_ACCOUNTS_TOKEN") ?? env.get("TAKOS_TOKEN");
  const accountId = (flags["account-id"] as string | undefined) ??
    env.get("TAKOS_ACCOUNT_ID");
  const spaceId = (flags["space-id"] as string | undefined) ??
    (flags.space as string | undefined) ?? env.get("TAKOS_SPACE_ID");
  const createdBySubject = (flags.subject as string | undefined) ??
    env.get("TAKOSUMI_SUBJECT") ?? env.get("TAKOS_SUBJECT");
  const sourceCommit = (flags["source-commit"] as string | undefined) ??
    env.get("TAKOSUMI_SOURCE_COMMIT");
  const runtimeBaseUrl = parseRuntimeBaseUrl(
    (flags["runtime-base-url"] as string | undefined) ??
      env.get("TAKOSUMI_RUNTIME_BASE_URL"),
  );
  const endpoint = (flags.endpoint as string | undefined) ??
    env.get("TAKOSUMI_ENDPOINT");
  const deployToken = endpoint
    ? (flags["deploy-token"] as string | undefined) ??
      env.get("TAKOSUMI_DEPLOY_TOKEN") ?? env.get("TAKOSUMI_TOKEN")
    : (flags["deploy-token"] as string | undefined);
  if (sourceCommit && !fullCommitPattern.test(sourceCommit)) {
    throw new Error("--source-commit must be a 40-char SHA");
  }
  if (sourceGitUrl) {
    validateInstallGitUrl(sourceGitUrl);
    if (!sourceRef) {
      throw new Error(
        "Git URL install requires --ref (or TAKOSUMI_INSTALL_REF)",
      );
    }
    validateInstallSourceRef(sourceRef);
    validateGitInstallPathOption("--app", app);
    if (manifest) validateGitInstallPathOption("--manifest", manifest);
  } else if (sourceRef) {
    throw new Error("--ref requires a Git URL source");
  }
  if (subcommand === "apply") {
    if (!accountsUrl) {
      throw new Error("missing --accounts-url (or TAKOSUMI_ACCOUNTS_URL)");
    }
    if (!accountId) {
      throw new Error("missing --account-id (or TAKOS_ACCOUNT_ID)");
    }
    if (!spaceId) {
      throw new Error("missing --space-id/--space (or TAKOS_SPACE_ID)");
    }
    if (!createdBySubject) {
      throw new Error("missing --subject (or TAKOSUMI_SUBJECT/TAKOS_SUBJECT)");
    }
    if (endpoint && !deployToken) {
      throw new Error(
        "missing --deploy-token (or TAKOSUMI_DEPLOY_TOKEN/TAKOSUMI_TOKEN)",
      );
    }
    if (deployToken && !endpoint) {
      throw new Error("missing --endpoint (or TAKOSUMI_ENDPOINT)");
    }
  }
  return {
    subcommand,
    cwd,
    appPathSpec: app,
    appPath: isAbsolute(app) ? app : join(cwd, app),
    ...(manifest ? { manifestPathSpec: manifest } : {}),
    manifestPath: typeof manifest === "string"
      ? isAbsolute(manifest) ? manifest : join(cwd, manifest)
      : undefined,
    json: Boolean(flags.json),
    ...(sourceGitUrl ? { sourceGitUrl } : {}),
    ...(sourceRef ? { sourceRef } : {}),
    ...(accountsUrl ? { accountsUrl } : {}),
    ...(token ? { token } : {}),
    ...(accountId ? { accountId } : {}),
    ...(spaceId ? { spaceId } : {}),
    ...(createdBySubject ? { createdBySubject } : {}),
    ...(mode ? { mode } : {}),
    ...(sourceCommit ? { sourceCommit } : {}),
    ...(runtimeBaseUrl ? { runtimeBaseUrl } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(deployToken ? { deployToken } : {}),
  };
}

function rejectRemovedServiceResolverOptions(args: readonly string[]): void {
  if (
    args.some((arg) =>
      arg === "--service-resolver-url" ||
      arg.startsWith("--service-resolver-url=") ||
      arg === "--service-resolver-public-key" ||
      arg.startsWith("--service-resolver-public-key=")
    )
  ) {
    throw new Error(
      "service resolver options were removed; manifests must not declare service imports or serviceResolvers",
    );
  }
}

function parseRuntimeMode(value: unknown): InstallableAppRuntimeMode {
  if (
    typeof value === "string" &&
    INSTALLABLE_APP_RUNTIME_MODES.includes(value as InstallableAppRuntimeMode)
  ) {
    return value as InstallableAppRuntimeMode;
  }
  throw new Error(
    `--mode must be one of ${INSTALLABLE_APP_RUNTIME_MODES.join("|")}`,
  );
}

function validateInstallGitUrl(value: string): void {
  if (!value.startsWith("https://") && !/^git@[^:]+:.+/.test(value)) {
    throw new Error("Git URL must be an https URL or git@host:path URL");
  }
}

function validateInstallSourceRef(value: string): void {
  const issues: InstallableAppValidationIssue[] = [];
  validateSourceRef(value, issues);
  if (issues.length > 0) {
    throw new Error(`--ref ${issues.map((issue) => issue.message).join("; ")}`);
  }
}

function validateGitInstallPathOption(flag: string, value: string): void {
  if (isAbsolute(value) || value.split("/").includes("..")) {
    throw new Error(
      `${flag} must be repo-relative without .. when installing from Git URL`,
    );
  }
}

function parseRuntimeBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1"))
    ) {
      throw new Error("unsupported protocol");
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error(
      "--runtime-base-url must be an https URL or localhost http URL",
    );
  }
}

export class InstallHelpRequested extends Error {
  constructor() {
    super("help requested");
    this.name = "InstallHelpRequested";
  }
}

const INSTALL_HELP_TEXT = `takosumi-git install

USAGE:
  takosumi-git install [<git-url>] [options]
  takosumi-git install preview [<git-url>] [options]
  takosumi-git install apply [<git-url>] [options]

DEFAULT ACTION:
  Without an explicit subcommand, install behaves like \`install apply\`.

PREVIEW OPTIONS:
  --cwd <dir>        project root (default .)
  --app <path>       InstallableApp YAML (default .takosumi/app.yml)
  --manifest <path>  kernel manifest path override
  --git-url <url>    Git source URL (or positional <git-url>)
  --ref <ref>        immutable tag/ref/full SHA for Git URL install
  --json             print preview JSON

APPLY OPTIONS:
  --accounts-url <url>  Takosumi Accounts URL (or TAKOSUMI_ACCOUNTS_URL)
  --token <token>       bearer token (or TAKOSUMI_ACCOUNTS_TOKEN/TAKOS_TOKEN)
  --account-id <id>     ledger account id (or TAKOS_ACCOUNT_ID)
  --space-id <id>       target space id (or --space / TAKOS_SPACE_ID)
  --subject <tsub_...>  installer subject (or TAKOSUMI_SUBJECT/TAKOS_SUBJECT)
  --mode <mode>         shared-cell | dedicated | self-hosted
  --source-commit <sha> resolved 40-char source commit pin
  --runtime-base-url <url>
                        app runtime base URL for OIDC redirect materialization
  --endpoint <url>      takosumi kernel endpoint for deploy (or TAKOSUMI_ENDPOINT)
  --deploy-token <tok>  kernel deploy token (or TAKOSUMI_DEPLOY_TOKEN/TAKOSUMI_TOKEN)
`;

interface InstallContext {
  readonly app: InstallableApp;
  readonly preview: InstallPreview;
  readonly compiledManifest?: CompiledInstallManifest;
}

type LoadInstallContextOptions =
  & Pick<
    ParsedInstallArgs,
    | "cwd"
    | "appPath"
    | "appPathSpec"
    | "manifestPath"
    | "manifestPathSpec"
    | "sourceGitUrl"
    | "sourceRef"
  >
  & {
    readonly checkoutSource?: InstallSourceCheckoutFactory;
    readonly compileWorkflows?: boolean;
    readonly executorFactory?: (projectRoot: string) => StepExecutor;
  };

async function loadInstallContext(
  options: LoadInstallContextOptions,
): Promise<InstallContext> {
  const sourceCheckout = await maybeCheckoutInstallSource(options);
  try {
    const repoRoot = sourceCheckout?.root ?? options.cwd ??
      dirname(dirname(options.appPath));
    const appPath = sourceCheckout
      ? join(repoRoot, options.appPathSpec ?? DEFAULT_APP_PATH)
      : options.appPath;
    const appText = await Deno.readTextFile(appPath);
    let app = parseInstallableAppYaml(appText);
    if (sourceCheckout && options.sourceGitUrl && options.sourceRef) {
      app = appWithCheckedOutSource(app, {
        gitUrl: options.sourceGitUrl,
        ref: options.sourceRef,
        commit: sourceCheckout.commit,
      });
    }
    const manifestPath = sourceCheckout
      ? options.manifestPathSpec
        ? join(repoRoot, options.manifestPathSpec)
        : join(repoRoot, app.entry.manifest)
      : options.manifestPath ??
        (isAbsolute(app.entry.manifest)
          ? app.entry.manifest
          : join(repoRoot, app.entry.manifest));
    const manifestText = await tryRead(manifestPath);
    const compiledManifest = manifestText
      ? options.compileWorkflows
        ? await compileInstallWorkflowRefs({
          compiled: compileInstallManifest(app, manifestText, {
            allowInstallerPlaceholders: true,
          }),
          projectRoot: repoRoot,
          workflowsDir: join(repoRoot, ".takosumi", "workflows"),
          executorFactory: options.executorFactory,
        })
        : compileInstallManifest(app, manifestText)
      : undefined;
    const warnings = manifestText
      ? []
      : [`entry manifest not found at ${manifestPath}`];
    return {
      app,
      ...(compiledManifest ? { compiledManifest } : {}),
      preview: buildInstallPreview(app, {
        appManifestDigest: digestText(appText),
        ...(compiledManifest
          ? { compiledManifestDigest: compiledManifest.digest }
          : {}),
        compatibilityWarnings: warnings,
      }),
    };
  } finally {
    await sourceCheckout?.cleanup();
  }
}

async function maybeCheckoutInstallSource(
  options: LoadInstallContextOptions,
): Promise<InstallSourceCheckout | undefined> {
  if (!options.sourceGitUrl) return undefined;
  if (!options.sourceRef) {
    throw new Error("Git URL install requires --ref");
  }
  return await (options.checkoutSource ?? checkoutGitSource)({
    gitUrl: options.sourceGitUrl,
    ref: options.sourceRef,
  });
}

function appWithCheckedOutSource(
  app: InstallableApp,
  source: {
    readonly gitUrl: string;
    readonly ref: string;
    readonly commit: string;
  },
): InstallableApp {
  if (normalizeGitUrl(app.source.git) !== normalizeGitUrl(source.gitUrl)) {
    throw new Error(
      `.takosumi/app.yml source.git (${app.source.git}) does not match requested Git URL (${source.gitUrl})`,
    );
  }
  if (app.source.ref !== source.ref) {
    throw new Error(
      `.takosumi/app.yml source.ref (${app.source.ref}) does not match requested ref (${source.ref})`,
    );
  }
  if (app.source.commit && app.source.commit !== source.commit) {
    throw new Error(
      `.takosumi/app.yml source.commit (${app.source.commit}) does not match checked-out commit (${source.commit})`,
    );
  }
  return {
    ...app,
    source: {
      ...app.source,
      commit: source.commit,
    },
  };
}

function normalizeGitUrl(value: string): string {
  return value.replace(/\/+$/, "").replace(/\.git$/, "");
}

async function checkoutGitSource(
  request: InstallSourceCheckoutRequest,
): Promise<InstallSourceCheckout> {
  const root = await Deno.makeTempDir({ prefix: "takosumi-git-install-" });
  try {
    await runGit(["init"], root);
    await runGit(["remote", "add", "origin", request.gitUrl], root);
    await runGit(["fetch", "--depth", "1", "origin", request.ref], root);
    await runGit(["checkout", "--detach", "FETCH_HEAD"], root);
    const commit = (await runGit(["rev-parse", "HEAD"], root)).trim();
    if (!fullCommitPattern.test(commit)) {
      throw new Error(`git resolved invalid commit '${commit}'`);
    }
    return {
      root,
      commit,
      cleanup: () => Deno.remove(root, { recursive: true }),
    };
  } catch (error) {
    await Deno.remove(root, { recursive: true }).catch(() => {});
    throw error;
  }
}

async function runGit(args: readonly string[], cwd: string): Promise<string> {
  const command = new Deno.Command("git", {
    args: args as string[],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const stdout = new TextDecoder().decode(output.stdout);
  if (output.success) return stdout;
  const stderr = new TextDecoder().decode(output.stderr).trim();
  throw new Error(
    `git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`,
  );
}

export async function previewInstall(
  options: ParsedInstallArgs & {
    readonly checkoutSource?: InstallSourceCheckoutFactory;
  },
): Promise<InstallPreview> {
  return (await loadInstallContext(options)).preview;
}

export interface InstallApplyResult {
  readonly preview: InstallPreview;
  readonly request: Record<string, unknown>;
  readonly accounts: AccountsInstallResponseSummary;
  readonly response: {
    readonly status: number;
    readonly body: unknown;
  };
  readonly deployment?: DeployResponse;
  readonly statusTransition?: {
    readonly status: number;
    readonly body: unknown;
  };
}

export interface AccountsInstallResponseSummary {
  readonly installationId?: string;
  readonly runtimeBinding?: Record<string, unknown>;
  readonly bindings: readonly Record<string, unknown>[];
  readonly oidcClient?: Record<string, unknown>;
  readonly oidcClientSecret?: string;
  readonly bindingEnv?: Record<string, string>;
  readonly launchTokenConfig?: Record<string, unknown>;
}

function appBindingCreateRequests(
  app: InstallableApp,
): Record<string, unknown>[] {
  return Object.entries(app.bindings).map(([name, binding]) => ({
    name,
    kind: binding.type,
    configRef:
      `takosumi-git://installable-app/${app.metadata.id}/bindings/${name}/${
        digestJson(binding)
      }`,
    declaration: binding,
    secretRefs: [],
  })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function installOidcClientCreateRequests(
  app: InstallableApp,
  runtimeBaseUrl: string | undefined,
): InstallOidcClientCreateRequest[] {
  if (!runtimeBaseUrl) return [];
  const namespacePath = "operator.identity.oidc";
  return Object.entries(app.bindings)
    .filter(([, binding]) => binding.type === "identity.oidc@v1")
    .map(([name, binding]) => {
      const redirectPaths = binding.redirectPaths ?? [];
      const tokenEndpointAuthMethod = oidcClientAuthMethodForAccounts(
        binding.tokenEndpointAuthMethod,
      );
      return {
        binding: name,
        namespacePath,
        redirectUris: redirectPaths.map((path) =>
          absoluteUrl(runtimeBaseUrl, path)
        ),
        allowedScopes: binding.allowedScopes ?? ["openid"],
        subjectMode: "pairwise" as const,
        ...(tokenEndpointAuthMethod ? { tokenEndpointAuthMethod } : {}),
      };
    })
    .sort((a, b) => a.binding.localeCompare(b.binding));
}

function oidcClientAuthMethodForAccounts(
  method: InstallableAppBinding["tokenEndpointAuthMethod"],
): InstallOidcClientCreateRequest["tokenEndpointAuthMethod"] | undefined {
  if (
    method === "client_secret_basic" || method === "client_secret_post"
  ) {
    return method;
  }
  if (method === "private_key_jwt") {
    throw new Error(
      "identity.oidc@v1 tokenEndpointAuthMethod private_key_jwt is not supported by Takosumi Accounts install materialization yet",
    );
  }
  return undefined;
}

export async function applyInstall(
  options: ParsedInstallArgs & {
    readonly subcommand: "apply";
    readonly accountsUrl: string;
    readonly accountId: string;
    readonly spaceId: string;
    readonly createdBySubject: string;
    readonly checkoutSource?: InstallSourceCheckoutFactory;
    readonly executorFactory?: (projectRoot: string) => StepExecutor;
    readonly fetch?: typeof fetch;
  },
): Promise<InstallApplyResult> {
  const { app, preview, compiledManifest } = await loadInstallContext({
    ...options,
    compileWorkflows: Boolean(options.endpoint),
  });
  const mode = options.mode ?? app.runtime.modes[0];
  if (!app.runtime.modes.includes(mode)) {
    throw new Error(`mode ${mode} is not supported by ${app.metadata.id}`);
  }
  if (
    options.sourceCommit && app.source.commit &&
    options.sourceCommit !== app.source.commit
  ) {
    throw new Error(
      `--source-commit (${options.sourceCommit}) does not match resolved source commit (${app.source.commit})`,
    );
  }
  const sourceCommit = options.sourceCommit ?? app.source.commit ??
    (fullCommitPattern.test(app.source.ref) ? app.source.ref : undefined);
  if (!sourceCommit) {
    throw new Error(
      "source.commit is required for install apply; pin the ref before creating AppInstallation",
    );
  }
  const oidcClients = installOidcClientCreateRequests(
    app,
    options.runtimeBaseUrl,
  );
  const request = {
    accountId: options.accountId,
    spaceId: options.spaceId,
    appId: app.metadata.id,
    source: {
      gitUrl: app.source.git,
      ref: app.source.ref,
      commit: sourceCommit,
      appManifestDigest: preview.source.appManifestDigest,
      ...(preview.source.compiledManifestDigest
        ? { compiledManifestDigest: preview.source.compiledManifestDigest }
        : {}),
    },
    mode,
    createdBySubject: options.createdBySubject,
    ...(oidcClients.length > 0 ? { oidcClients } : {}),
    bindings: appBindingCreateRequests(app),
    grants: app.permissions.requested.map((capability) => ({
      capability,
      scope: {
        type: "single-installation",
        appId: app.metadata.id,
      },
    })),
  };
  const deployEndpoint = options.endpoint;
  const deployToken = options.deployToken;
  if (deployEndpoint && !deployToken) {
    throw new Error(
      "missing --deploy-token (or TAKOSUMI_DEPLOY_TOKEN/TAKOSUMI_TOKEN)",
    );
  }
  if (deployEndpoint) {
    buildInstallDeployRequest(compiledManifest);
  }
  const response = await (options.fetch ?? fetch)(
    `${normalizeBaseUrl(options.accountsUrl)}/v1/installations`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify(request),
    },
  );
  const body = await readResponseBody(response);
  if (response.status >= 400) {
    throw new InstallApplyError(response.status, body);
  }
  let accounts = readAccountsInstallResponse(body);
  let deployment: DeployResponse | undefined;
  let statusTransition:
    | { readonly status: number; readonly body: unknown }
    | undefined;
  if (deployEndpoint) {
    if (!deployEndpoint || !deployToken) {
      throw new Error("kernel deploy endpoint and token are required");
    }
    const installationId = accounts.installationId;
    if (!installationId) {
      throw new Error(
        "accounts response missing installation id for deploy status transition",
      );
    }
    const launchTokenConfig = appRequiresLaunchTokenConfig(app)
      ? await fetchLaunchTokenConfig({
        accountsUrl: options.accountsUrl,
        token: options.token,
        installationId,
        fetch: options.fetch,
      })
      : undefined;
    if (launchTokenConfig) {
      accounts = { ...accounts, launchTokenConfig };
    }
    assertRequiredLaunchTokenConfig(app, accounts);
    assertRequiredProviderBindingsMaterialized(app, accounts);
    const deployRequest = buildInstallDeployRequest(
      compiledManifest,
      {
        app,
        accounts,
        accountId: options.accountId,
        spaceId: options.spaceId,
        runtimeBaseUrl: options.runtimeBaseUrl,
      },
    );
    try {
      deployment = await postDeployment({
        endpoint: deployEndpoint,
        token: deployToken,
        fetch: options.fetch,
        idempotencyKey:
          `takosumi-git-install:${app.metadata.id}:${sourceCommit}:${compiledManifest?.digest}`,
      }, deployRequest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      statusTransition = await patchInstallationStatus({
        accountsUrl: options.accountsUrl,
        token: options.token,
        installationId,
        status: "failed",
        reason: `kernel deploy failed: ${message}`,
        fetch: options.fetch,
      });
      throw error;
    }
    statusTransition = await patchInstallationStatus({
      accountsUrl: options.accountsUrl,
      token: options.token,
      installationId,
      status: deployment.status >= 400 ? "failed" : "ready",
      reason: `kernel deploy HTTP ${deployment.status}`,
      fetch: options.fetch,
    });
  }
  return {
    preview,
    request,
    accounts,
    response: {
      status: response.status,
      body,
    },
    ...(deployment ? { deployment } : {}),
    ...(statusTransition ? { statusTransition } : {}),
  };
}

async function patchInstallationStatus(input: {
  readonly accountsUrl: string;
  readonly token?: string;
  readonly installationId: string;
  readonly status: "ready" | "failed";
  readonly reason: string;
  readonly fetch?: typeof fetch;
}): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await (input.fetch ?? fetch)(
    `${normalizeBaseUrl(input.accountsUrl)}/v1/installations/${
      encodeURIComponent(input.installationId)
    }/status`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      },
      body: JSON.stringify({
        status: input.status,
        reason: input.reason,
      }),
    },
  );
  const body = await readResponseBody(response);
  if (response.status >= 400) {
    throw new InstallApplyError(response.status, body);
  }
  return { status: response.status, body };
}

async function fetchLaunchTokenConfig(input: {
  readonly accountsUrl: string;
  readonly token?: string;
  readonly installationId: string;
  readonly fetch?: typeof fetch;
}): Promise<Record<string, unknown>> {
  const response = await (input.fetch ?? fetch)(
    `${normalizeBaseUrl(input.accountsUrl)}/v1/installations/${
      encodeURIComponent(input.installationId)
    }/launch-token`,
    {
      method: "GET",
      headers: {
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      },
    },
  );
  const body = await readResponseBody(response);
  if (response.status >= 400) {
    throw new InstallApplyError(response.status, body);
  }
  return isRecord(body) ? body : {};
}

function appRequiresLaunchTokenConfig(app: InstallableApp): boolean {
  return Object.values(app.bindings).some((binding) =>
    binding.type === "install-launch-token@v1" && binding.required
  );
}

function assertRequiredLaunchTokenConfig(
  app: InstallableApp,
  accounts: AccountsInstallResponseSummary,
): void {
  const missing: string[] = [];
  for (const [name, binding] of Object.entries(app.bindings)) {
    if (binding.type !== "install-launch-token@v1" || !binding.required) {
      continue;
    }
    const record = accounts.bindings.find((entry) =>
      stringProperty(entry, "name", "name") === name
    );
    const configRef = record
      ? stringProperty(record, "config_ref", "configRef")
      : undefined;
    if (!configRef || configRef.startsWith("takosumi-git://")) {
      missing.push(`${name}:install-launch-token@v1:configRef`);
    }
    const launchEnv = isRecord(accounts.launchTokenConfig?.env)
      ? accounts.launchTokenConfig.env
      : {};
    for (
      const envKey of [
        "INSTALL_LAUNCH_PUBLIC_KEY",
        "INSTALL_LAUNCH_AUDIENCE",
        "INSTALL_LAUNCH_ISSUER",
      ]
    ) {
      if (!hasEnvKey(launchEnv, envKey)) {
        missing.push(`${name}:install-launch-token@v1:${envKey}`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `required launch token config is missing: ${missing.join(", ")}`,
    );
  }
}

function assertRequiredProviderBindingsMaterialized(
  app: InstallableApp,
  accounts: AccountsInstallResponseSummary,
): void {
  const accountsBindings = new Map(
    accounts.bindings
      .map((binding) => {
        const name = stringProperty(binding, "name", "name");
        return name ? [name, binding] as const : undefined;
      })
      .filter((entry): entry is readonly [string, Record<string, unknown>] =>
        entry !== undefined
      ),
  );
  const missing: string[] = [];
  for (const [name, binding] of Object.entries(app.bindings)) {
    if (!binding.required || !isProviderBackedBinding(binding.type)) continue;
    const record = accountsBindings.get(name);
    const configRef = record
      ? stringProperty(record, "config_ref", "configRef")
      : undefined;
    if (!configRef || configRef.startsWith("takosumi-git://")) {
      missing.push(`${name}:${binding.type}:configRef`);
    }
    for (const envKey of requiredBindingEnvKeys(binding.type)) {
      if (!hasEnvKey(accounts.bindingEnv ?? {}, envKey)) {
        missing.push(`${name}:${binding.type}:${envKey}`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `required AppBinding materialization is missing: ${missing.join(", ")}`,
    );
  }
}

function isProviderBackedBinding(type: InstallableAppBindingType): boolean {
  return type === "database.postgres@v1" ||
    type === "object-store.s3-compatible@v1" ||
    type === "domain.http@v1" ||
    type === "deploy-intent.gitops@v1";
}

function requiredBindingEnvKeys(
  type: InstallableAppBindingType,
): readonly string[] {
  if (type === "database.postgres@v1") return ["DATABASE_URL"];
  if (type === "object-store.s3-compatible@v1") {
    return [
      "BLOB_ENDPOINT",
      "BLOB_BUCKET",
      "BLOB_ACCESS_KEY",
      "BLOB_SECRET_KEY",
    ];
  }
  if (type === "deploy-intent.gitops@v1") {
    return [
      "DEPLOY_INTENT_DRIVER",
      "DEPLOY_INTENT_REMOTE",
      "DEPLOY_INTENT_TOKEN",
    ];
  }
  return [];
}

function buildInstallDeployRequest(
  compiledManifest: CompiledInstallManifest | undefined,
  materialization?: {
    readonly app: InstallableApp;
    readonly accounts: AccountsInstallResponseSummary;
    readonly accountId?: string;
    readonly spaceId?: string;
    readonly runtimeBaseUrl?: string;
  },
): { readonly mode: "apply"; readonly manifest: ManifestEnvelope } {
  if (!compiledManifest) {
    throw new Error("entry manifest is required for install apply deploy");
  }
  const manifest = structuredClone(compiledManifest.manifest);
  assertNoForbiddenKernelManifestFields(manifest);
  if (materialization) {
    applyAccountsPlaceholders({
      manifest,
      app: materialization.app,
      accounts: materialization.accounts,
      accountId: materialization.accountId,
      spaceId: materialization.spaceId,
      runtimeBaseUrl: materialization.runtimeBaseUrl,
    });
    applyAccountsRuntimeEnv({
      manifest,
      app: materialization.app,
      accounts: materialization.accounts,
      runtimeBaseUrl: materialization.runtimeBaseUrl,
    });
    assertNoInstallerPlaceholders(manifest);
  }
  return {
    mode: "apply",
    manifest: manifest as unknown as ManifestEnvelope,
  };
}

function applyAccountsPlaceholders(input: {
  manifest: Record<string, unknown>;
  app: InstallableApp;
  accounts: AccountsInstallResponseSummary;
  accountId?: string;
  spaceId?: string;
  runtimeBaseUrl?: string;
}): void {
  replaceInstallerPlaceholders(input.manifest, "$", input);
}

function replaceInstallerPlaceholders(
  value: unknown,
  path: string,
  context: {
    app: InstallableApp;
    accounts: AccountsInstallResponseSummary;
    accountId?: string;
    spaceId?: string;
    runtimeBaseUrl?: string;
  },
): unknown {
  if (typeof value === "string") {
    const matches = [...value.matchAll(installerPlaceholderGlobalPattern)];
    if (matches.length === 0) return value;
    if (matches.length === 1 && matches[0][0] === value) {
      return resolveInstallerPlaceholder(matches[0], path, context);
    }
    return value.replace(
      installerPlaceholderGlobalPattern,
      (...args: unknown[]) => {
        const match = args as [string, string, string, ...unknown[]];
        const resolved = resolveInstallerPlaceholder(match, path, context);
        if (typeof resolved === "string") return resolved;
        if (typeof resolved === "number" || typeof resolved === "boolean") {
          return String(resolved);
        }
        throw new Error(
          `entry manifest contains non-scalar installer placeholder at ${path}: ${
            match[0]
          }`,
        );
      },
    );
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      value[index] = replaceInstallerPlaceholders(
        entry,
        `${path}[${index}]`,
        context,
      );
    }
    return value;
  }
  if (!isRecord(value)) return value;
  for (const [key, entry] of Object.entries(value)) {
    value[key] = replaceInstallerPlaceholders(entry, `${path}.${key}`, context);
  }
  return value;
}

function resolveInstallerPlaceholder(
  match: readonly unknown[],
  path: string,
  context: {
    app: InstallableApp;
    accounts: AccountsInstallResponseSummary;
    accountId?: string;
    spaceId?: string;
    runtimeBaseUrl?: string;
  },
): unknown {
  const placeholder = String(match[0]);
  const namespace = String(match[1]);
  const keyPath = String(match[2]);
  if (namespace === "imports") {
    throw new Error(
      `entry manifest contains removed imports placeholder at ${path}: ${placeholder}`,
    );
  }
  if (namespace === "refs") {
    throw new Error(
      `entry manifest contains legacy refs placeholder at ${path}: ${placeholder}`,
    );
  }
  if (namespace === "installation") {
    return resolveInstallationPlaceholder(keyPath, placeholder, context);
  }
  if (namespace === "bindings" || namespace === "secrets") {
    const dot = keyPath.indexOf(".");
    const bindingName = dot === -1 ? keyPath : keyPath.slice(0, dot);
    const bindingKey = dot === -1 ? "" : keyPath.slice(dot + 1);
    return resolveBindingPlaceholder({
      ...context,
      bindingName,
      bindingKey,
      secret: namespace === "secrets",
      placeholder,
      path,
    });
  }
  throw new Error(
    `entry manifest contains unresolved installer placeholder at ${path}: ${placeholder}`,
  );
}

function resolveInstallationPlaceholder(
  keyPath: string,
  placeholder: string,
  context: {
    accounts: AccountsInstallResponseSummary;
    accountId?: string;
    spaceId?: string;
    runtimeBaseUrl?: string;
  },
): unknown {
  const values: Record<string, unknown> = {
    id: context.accounts.installationId,
    installationId: context.accounts.installationId,
    accountId: context.accountId,
    spaceId: context.spaceId,
    baseUrl: context.runtimeBaseUrl
      ? normalizeBaseUrl(context.runtimeBaseUrl)
      : undefined,
  };
  return requiredPlaceholderValue(values[keyPath], placeholder);
}

function resolveBindingPlaceholder(input: {
  app: InstallableApp;
  accounts: AccountsInstallResponseSummary;
  runtimeBaseUrl?: string;
  bindingName: string;
  bindingKey: string;
  secret: boolean;
  placeholder: string;
  path: string;
}): unknown {
  const binding = input.app.bindings[input.bindingName];
  if (!binding) {
    throw new Error(
      `entry manifest references unknown binding at ${input.path}: ${input.placeholder}`,
    );
  }
  const materialized = bindingRecordForName(input.accounts, input.bindingName);
  if (
    binding.required &&
    (!materialized ||
      (stringProperty(materialized, "config_ref", "configRef") ?? "")
        .startsWith("takosumi-git://"))
  ) {
    throw new Error(
      `entry manifest references unmaterialized binding at ${input.path}: ${input.placeholder}`,
    );
  }
  const values = input.secret
    ? secretPlaceholderValues(binding.type, input)
    : bindingPlaceholderValues(binding.type, input);
  return requiredPlaceholderValue(values[input.bindingKey], input.placeholder);
}

function bindingPlaceholderValues(
  type: InstallableAppBindingType,
  input: {
    accounts: AccountsInstallResponseSummary;
    runtimeBaseUrl?: string;
    bindingName: string;
  },
): Record<string, unknown> {
  if (type === "identity.oidc@v1") {
    const oidcClient = input.accounts.oidcClient ?? {};
    const redirectUris = stringArrayProperty(
      oidcClient,
      "redirect_uris",
      "redirectUris",
    );
    return {
      issuerUrl: stringProperty(oidcClient, "issuer_url", "issuerUrl"),
      clientId: stringProperty(oidcClient, "client_id", "clientId"),
      redirectUri: redirectUris[0],
      redirectUris,
      ...indexedValues("redirectUris", redirectUris),
    };
  }
  if (type === "database.postgres@v1") {
    return postgresPlaceholderValues(input.accounts.bindingEnv?.DATABASE_URL);
  }
  if (type === "object-store.s3-compatible@v1") {
    const env = input.accounts.bindingEnv ?? {};
    return {
      endpoint: env.BLOB_ENDPOINT,
      bucket: env.BLOB_BUCKET,
      accessKey: env.BLOB_ACCESS_KEY,
      region: env.BLOB_REGION,
    };
  }
  if (type === "domain.http@v1") {
    const url = input.runtimeBaseUrl
      ? normalizeBaseUrl(input.runtimeBaseUrl)
      : undefined;
    return {
      hostname: url ? new URL(url).hostname : undefined,
      url,
    };
  }
  if (type === "deploy-intent.gitops@v1") {
    const env = input.accounts.bindingEnv ?? {};
    const binding = bindingRecordForName(input.accounts, input.bindingName) ??
      {};
    return {
      driver: env.DEPLOY_INTENT_DRIVER ?? "gitops",
      remote: env.DEPLOY_INTENT_REMOTE,
      branch: stringProperty(binding, "branch", "branch"),
      writePathPrefix: stringProperty(
        binding,
        "write_path_prefix",
        "writePathPrefix",
      ),
    };
  }
  if (type === "install-launch-token@v1") {
    const launchConfig = input.accounts.launchTokenConfig ?? {};
    const env = isRecord(launchConfig.env) ? launchConfig.env : {};
    return {
      publicKey: stringFromUnknown(env.INSTALL_LAUNCH_PUBLIC_KEY),
      audience: stringFromUnknown(env.INSTALL_LAUNCH_AUDIENCE) ??
        stringProperty(launchConfig, "audience", "audience"),
      issuer: stringFromUnknown(env.INSTALL_LAUNCH_ISSUER) ??
        stringProperty(launchConfig, "issuer", "issuer"),
      algorithm: stringProperty(launchConfig, "algorithm", "algorithm") ??
        "RS256",
      kid: stringProperty(launchConfig, "kid", "kid"),
      consumePath: input.accounts.installationId
        ? `/v1/installations/${input.accounts.installationId}/launch-token/consume`
        : undefined,
    };
  }
  return {};
}

function secretPlaceholderValues(
  type: InstallableAppBindingType,
  input: { accounts: AccountsInstallResponseSummary },
): Record<string, unknown> {
  if (type === "identity.oidc@v1") {
    return { clientSecret: input.accounts.oidcClientSecret };
  }
  if (type === "database.postgres@v1") {
    return postgresPlaceholderValues(input.accounts.bindingEnv?.DATABASE_URL);
  }
  if (type === "object-store.s3-compatible@v1") {
    return { secretKey: input.accounts.bindingEnv?.BLOB_SECRET_KEY };
  }
  if (type === "deploy-intent.gitops@v1") {
    return { token: input.accounts.bindingEnv?.DEPLOY_INTENT_TOKEN };
  }
  return {};
}

function postgresPlaceholderValues(
  urlValue: string | undefined,
): Record<string, unknown> {
  if (!urlValue) return {};
  try {
    const url = new URL(urlValue);
    return {
      host: url.hostname,
      port: url.port || "5432",
      database: decodeURIComponent(url.pathname.replace(/^\//, "")),
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      sslMode: url.searchParams.get("sslmode") ?? "require",
      url: urlValue,
    };
  } catch {
    return { url: urlValue };
  }
}

function bindingRecordForName(
  accounts: AccountsInstallResponseSummary,
  name: string,
): Record<string, unknown> | undefined {
  return accounts.bindings.find((entry) =>
    stringProperty(entry, "name", "name") === name
  );
}

function indexedValues(
  prefix: string,
  values: readonly unknown[],
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  values.forEach((value, index) => {
    output[`${prefix}[${index}]`] = value;
  });
  return output;
}

function requiredPlaceholderValue(
  value: unknown,
  placeholder: string,
): unknown {
  if (value === undefined || value === null || value === "") {
    throw new Error(
      `entry manifest contains unresolved installer placeholder: ${placeholder}`,
    );
  }
  return value;
}

function applyAccountsRuntimeEnv(input: {
  manifest: Record<string, unknown>;
  app: InstallableApp;
  accounts: AccountsInstallResponseSummary;
  runtimeBaseUrl?: string;
}): void {
  const env = accountsRuntimeEnv(input);
  if (Object.keys(env).length === 0) return;

  const resources = input.manifest.resources;
  if (Array.isArray(resources)) {
    for (const [index, resource] of resources.entries()) {
      if (!isRecord(resource) || !isInstallRuntimeResource(resource)) continue;
      if (!isRecord(resource.spec)) {
        throw new Error(`manifest.resources[${index}].spec must be an object`);
      }
      injectMissingEnv(resource.spec, env, `manifest.resources[${index}].spec`);
    }
  }

  const compute = input.manifest.compute;
  if (isRecord(compute)) {
    for (const [name, component] of Object.entries(compute)) {
      if (!isRecord(component)) continue;
      injectMissingEnv(component, env, `manifest.compute.${name}`);
    }
  }
}

function accountsRuntimeEnv(input: {
  app: InstallableApp;
  accounts: AccountsInstallResponseSummary;
  runtimeBaseUrl?: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.accounts.bindingEnv ?? {})) {
    env[key] = value;
  }
  if (input.accounts.installationId) {
    env.TAKOS_INSTALLATION_ID = input.accounts.installationId;
  }
  if (input.runtimeBaseUrl) {
    env.BASE_URL = normalizeBaseUrl(input.runtimeBaseUrl);
  }

  if (appHasBindingType(input.app, "identity.oidc@v1")) {
    const oidcClient = input.accounts.oidcClient;
    if (oidcClient) {
      const issuerUrl = stringProperty(oidcClient, "issuer_url", "issuerUrl");
      const clientId = stringProperty(oidcClient, "client_id", "clientId");
      const redirectUris = stringArrayProperty(
        oidcClient,
        "redirect_uris",
        "redirectUris",
      );
      if (issuerUrl) env.OIDC_ISSUER_URL = issuerUrl;
      if (clientId) env.OIDC_CLIENT_ID = clientId;
      if (redirectUris[0]) env.OIDC_REDIRECT_URI = redirectUris[0];
      if (input.accounts.oidcClientSecret) {
        env.OIDC_CLIENT_SECRET = input.accounts.oidcClientSecret;
      }
    }
  }

  if (appHasBindingType(input.app, "install-launch-token@v1")) {
    const launchEnv = isRecord(input.accounts.launchTokenConfig?.env)
      ? input.accounts.launchTokenConfig.env
      : {};
    for (
      const key of [
        "INSTALL_LAUNCH_PUBLIC_KEY",
        "INSTALL_LAUNCH_AUDIENCE",
        "INSTALL_LAUNCH_ISSUER",
      ]
    ) {
      const value = launchEnv[key];
      if (typeof value === "string" && value.length > 0) env[key] = value;
    }
  }

  return env;
}

function appHasBindingType(
  app: InstallableApp,
  type: InstallableAppBindingType,
): boolean {
  return Object.values(app.bindings).some((binding) => binding.type === type);
}

function isInstallRuntimeResource(resource: Record<string, unknown>): boolean {
  const shape = resource.shape;
  return typeof shape === "string" &&
    (shape.startsWith("web-service@") || shape.startsWith("worker@"));
}

function injectMissingEnv(
  target: Record<string, unknown>,
  values: Record<string, string>,
  path: string,
): void {
  const rawEnv = target.env;
  if (rawEnv !== undefined && !isRecord(rawEnv)) {
    throw new Error(`${path}.env must be an object`);
  }
  const env = rawEnv ?? {};
  for (const [key, value] of Object.entries(values)) {
    if (!hasEnvKey(env, key)) env[key] = value;
  }
  target.env = env;
}

function hasEnvKey(env: Record<string, unknown>, key: string): boolean {
  const normalized = key.toUpperCase();
  return Object.keys(env).some((existing) =>
    existing.toUpperCase() === normalized
  );
}

export class InstallApplyError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`Takosumi Accounts returned HTTP ${status}`);
    this.name = "InstallApplyError";
  }
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function absoluteUrl(baseUrl: string, path: string): string {
  const base = `${normalizeBaseUrl(baseUrl)}/`;
  return new URL(path.replace(/^\/+/, ""), base).toString();
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function runInstallCli(args: readonly string[]): Promise<number> {
  let parsed: ParsedInstallArgs;
  try {
    parsed = parseInstallArgs(args);
  } catch (error) {
    if (error instanceof InstallHelpRequested) {
      Deno.stdout.writeSync(new TextEncoder().encode(INSTALL_HELP_TEXT));
      return 0;
    }
    Deno.stderr.writeSync(
      new TextEncoder().encode(
        `takosumi-git install: ${(error as Error).message}\n`,
      ),
    );
    return 64;
  }

  try {
    const result = parsed.subcommand === "apply"
      ? await applyInstall(
        parsed as ParsedInstallArgs & {
          readonly subcommand: "apply";
          readonly accountsUrl: string;
          readonly accountId: string;
          readonly spaceId: string;
          readonly createdBySubject: string;
        },
      )
      : await previewInstall(parsed);
    const text = parsed.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : parsed.subcommand === "apply"
      ? renderApplyResult(result as InstallApplyResult)
      : renderHumanPreview(result as InstallPreview);
    Deno.stdout.writeSync(new TextEncoder().encode(text));
    if (parsed.subcommand === "apply") {
      const deployment = (result as InstallApplyResult).deployment;
      if (deployment && deployment.status >= 400) return 1;
    }
    return 0;
  } catch (error) {
    Deno.stderr.writeSync(
      new TextEncoder().encode(
        `takosumi-git install: ${(error as Error).message}\n`,
      ),
    );
    return error instanceof InstallableAppValidationError ? 64 : 1;
  }
}

function renderApplyResult(result: InstallApplyResult): string {
  const installationId = result.accounts.installationId ?? "(unknown)";
  const runtimeBinding = renderRuntimeBindingSummary(
    result.accounts.runtimeBinding,
  );
  return [
    "takosumi-git install apply",
    `app: ${result.preview.app.name} (${result.preview.app.id})`,
    `installation: ${installationId}`,
    ...(runtimeBinding ? [`runtime: ${runtimeBinding}`] : []),
    `accounts response: HTTP ${result.response.status}`,
    ...(result.deployment
      ? [`kernel response: HTTP ${result.deployment.status}`]
      : []),
    ...(result.statusTransition
      ? [`status response: HTTP ${result.statusTransition.status}`]
      : []),
    "",
  ].join("\n");
}

function readAccountsInstallResponse(
  body: unknown,
): AccountsInstallResponseSummary {
  const record = isRecord(body) ? body : {};
  const bindings = Array.isArray(record.bindings)
    ? record.bindings.filter(isRecord)
    : [];
  const oidcClient = isRecord(record.oidc_client)
    ? record.oidc_client
    : isRecord(record.oidcClient)
    ? record.oidcClient
    : undefined;
  const oidcClientSecret = stringProperty(
    record,
    "oidc_client_secret",
    "oidcClientSecret",
  );
  const bindingEnv = stringRecordProperty(record, "binding_env", "bindingEnv");
  const runtimeBinding = isRecord(record.runtime_binding)
    ? record.runtime_binding
    : isRecord(record.runtimeBinding)
    ? record.runtimeBinding
    : undefined;
  return {
    ...(readInstallationId(body)
      ? { installationId: readInstallationId(body) }
      : {}),
    ...(runtimeBinding ? { runtimeBinding } : {}),
    bindings,
    ...(oidcClient ? { oidcClient } : {}),
    ...(oidcClientSecret ? { oidcClientSecret } : {}),
    ...(bindingEnv ? { bindingEnv } : {}),
  };
}

function renderRuntimeBindingSummary(
  runtimeBinding: Record<string, unknown> | undefined,
): string | undefined {
  if (!runtimeBinding) return undefined;
  const targetType = stringProperty(
    runtimeBinding,
    "target_type",
    "targetType",
  );
  const targetId = stringProperty(runtimeBinding, "target_id", "targetId");
  if (!targetType && !targetId) return undefined;
  return [targetType, targetId].filter(Boolean).join(" ");
}

function readInstallationId(body: unknown): string | undefined {
  const record = isRecord(body) ? body : {};
  const installation = isRecord(record.installation) ? record.installation : {};
  return typeof installation.id === "string"
    ? installation.id
    : typeof installation.installation_id === "string"
    ? installation.installation_id
    : undefined;
}

function stringProperty(
  record: Record<string, unknown>,
  snakeKey: string,
  camelKey: string,
): string | undefined {
  const value = record[snakeKey] ?? record[camelKey];
  return stringFromUnknown(value);
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayProperty(
  record: Record<string, unknown>,
  snakeKey: string,
  camelKey: string,
): readonly string[] {
  const value = record[snakeKey] ?? record[camelKey];
  return Array.isArray(value)
    ? value.filter((entry): entry is string =>
      typeof entry === "string" && entry.length > 0
    )
    : [];
}

function stringRecordProperty(
  record: Record<string, unknown>,
  snakeKey: string,
  camelKey: string,
): Record<string, string> | undefined {
  const value = record[snakeKey] ?? record[camelKey];
  if (!isRecord(value)) return undefined;
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && entry.length > 0) output[key] = entry;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}
