/**
 * `takosumi-git install` `.takosumi/app.yml` parsing and validation.
 *
 * Pure structural validator: produces an `InstallableApp` value object from
 * untrusted YAML/object input or throws `InstallableAppValidationError`. Has
 * no I/O, no network, no manifest compilation.
 */

import { parse as parseYaml } from "@std/yaml";
import { isAbsolute } from "@std/path";

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

export const reverseDomainPattern = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
export const publisherPattern = /^[a-z0-9]([a-z0-9-]{0,78}[a-z0-9])?$/;
export const bindingNamePattern = /^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$/;
export const pathPattern = /^\/[^?#]{0,199}$/;
export const fullCommitPattern = /^[0-9a-f]{40}$/;
export const semverTagPattern = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
export const releaseTagPattern = /^release[/-][0-9][0-9A-Za-z._-]*$/;
export const mutableRefs = new Set([
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

export function isRecord(value: unknown): value is Record<string, unknown> {
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

export function validateSourceRef(
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
    const binding: BindingBuilder = {
      type: type as InstallableAppBindingType,
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
    bindings[name] = binding;
  }
  return bindings;
}

// Mutable counterpart of `InstallableAppBinding` used as the builder during
// parsing. Strip `readonly` so `parseBindingSpecificFields` can populate
// fields after they pass per-field validation.
type BindingBuilder = {
  -readonly [K in keyof InstallableAppBinding]: InstallableAppBinding[K];
};

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
  binding: BindingBuilder,
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
      const method = String(raw.tokenEndpointAuthMethod);
      if (
        method === "client_secret_basic" ||
        method === "client_secret_post" ||
        method === "private_key_jwt"
      ) {
        binding.tokenEndpointAuthMethod = method;
      } else {
        issues.push({
          path: `bindings.${name}.tokenEndpointAuthMethod`,
          message: "is not supported",
        });
      }
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
    const planValue = String(raw.plan);
    if (!postgresPlans.has(planValue)) {
      issues.push({
        path: `bindings.${name}.plan`,
        message: "must be nano, small, medium, large, or xlarge",
      });
    } else binding.plan = planValue;
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
    const planValue = String(raw.plan);
    if (!objectStorePlans.has(planValue)) {
      issues.push({
        path: `bindings.${name}.plan`,
        message: "must be standard, infrequent-access, or archive",
      });
    } else binding.plan = planValue;
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
    if (raw.hostname === "auto") {
      binding.hostname = "auto";
    } else if (
      isRecord(raw.hostname) && typeof raw.hostname.custom === "string" &&
      raw.hostname.custom.length > 0
    ) {
      binding.hostname = { custom: raw.hostname.custom };
    } else {
      issues.push({
        path: `bindings.${name}.hostname`,
        message: "must be auto or { custom: string }",
      });
    }
    if (raw.tlsMode !== undefined) {
      const mode = String(raw.tlsMode);
      if (mode === "auto" || mode === "managed" || mode === "byo") {
        binding.tlsMode = mode;
      } else {
        issues.push({
          path: `bindings.${name}.tlsMode`,
          message: "must be auto, managed, or byo",
        });
      }
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

export function parseInstallableAppYaml(text: string): InstallableApp {
  return parseInstallableAppObject(parseYaml(text));
}
