/**
 * `@takos/takosumi-git-deploy-client`
 *
 * HTTP client for the takosumi kernel `POST /v1/deployments` endpoint.
 *
 * The kernel is the only contact surface; this client is the only allowed
 * way for `takosumi-git` to drive a deployment. Manifest types should come
 * from `@takos/takosumi-contract` once the workspace dependency is wired —
 * for the Phase 2 skeleton the manifest body is typed as an opaque JSON
 * object.
 */

export type DeployMode = "apply" | "plan" | "destroy";

/**
 * JSON-LD @context value as accepted by the kernel
 * (`validateManifestJsonLdContext` in `@takos/takosumi-contract`).
 * The kernel allows a non-empty string, a context object, or a non-empty
 * array whose entries are themselves strings or context objects.
 */
export type ManifestJsonLdContext =
  | string
  | Record<string, unknown>
  | ReadonlyArray<string | Record<string, unknown>>;

export interface ManifestEnvelope {
  readonly "@context"?: ManifestJsonLdContext;
  readonly apiVersion: "1.0";
  readonly kind: "Manifest";
  readonly namespace?: string;
  readonly metadata?: { name?: string; labels?: Record<string, string> };
  readonly resources?: ReadonlyArray<{
    readonly shape: string;
    readonly name: string;
    readonly provider: string;
    readonly spec: unknown;
    readonly requires?: readonly string[];
    readonly metadata?: Record<string, unknown>;
  }>;
}

/**
 * Walk a parsed-YAML value, assert the manifest discriminators, and return
 * a typed `ManifestEnvelope`. Sub-trees (metadata, resources) are passed
 * through to the kernel which owns deeper validation; this parser only
 * asserts the envelope shape so downstream code can drop
 * `as unknown as ManifestEnvelope` casts.
 *
 * `@context` is validated structurally here so a misformatted JSON-LD context
 * fails fast on the client instead of round-tripping a kernel reject. The
 * accepted shapes mirror the kernel's `validateManifestJsonLdContext`:
 * non-empty string, JSON-LD context object, or non-empty array of those.
 *
 * Note: `template` is intentionally NOT a recognized envelope key. The kernel
 * `ManifestEnvelope` (`@takos/takosumi-contract`) rejects unknown top-level
 * keys via `validateManifestEnvelope`; any client-side substitution
 * `template:` field is a takosumi-git private extension that must be resolved
 * and stripped before `postDeployment` is called. `postDeployment` also
 * defends-in-depth by stripping unknown top-level keys on the wire.
 */
export function parseManifestEnvelope(
  value: Record<string, unknown>,
  label = "manifest",
): ManifestEnvelope {
  if (value.apiVersion !== "1.0") {
    throw new Error(`${label}.apiVersion must be "1.0"`);
  }
  if (value.kind !== "Manifest") {
    throw new Error(`${label}.kind must be "Manifest"`);
  }
  const envelope: ManifestEnvelope = { apiVersion: "1.0", kind: "Manifest" };
  if (value["@context"] !== undefined) {
    assertJsonLdContext(value["@context"], label);
    Object.assign(envelope, {
      "@context": value["@context"] as ManifestJsonLdContext,
    });
  }
  if (typeof value.namespace === "string") {
    Object.assign(envelope, { namespace: value.namespace });
  }
  if (
    value.metadata !== undefined && typeof value.metadata === "object" &&
    value.metadata !== null && !Array.isArray(value.metadata)
  ) {
    Object.assign(envelope, {
      metadata: value.metadata as ManifestEnvelope["metadata"],
    });
  }
  if (Array.isArray(value.resources)) {
    Object.assign(envelope, {
      resources: value.resources as ManifestEnvelope["resources"],
    });
  }
  return envelope;
}

function assertJsonLdContext(value: unknown, label: string): void {
  if (typeof value === "string") {
    if (value.length === 0) {
      throw new Error(`${label}["@context"] string must be non-empty`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw new Error(`${label}["@context"] array must be non-empty`);
    }
    value.forEach((entry, index) => {
      if (typeof entry === "string") {
        if (entry.length === 0) {
          throw new Error(
            `${label}["@context"][${index}] string entry must be non-empty`,
          );
        }
        return;
      }
      if (!isPlainObject(entry)) {
        throw new Error(
          `${label}["@context"][${index}] must be a non-empty string or JSON-LD context object`,
        );
      }
    });
    return;
  }
  if (isPlainObject(value)) return;
  throw new Error(
    `${label}["@context"] must be a non-empty string, JSON-LD context object, or non-empty array of those values`,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface DeployRequest {
  readonly mode: DeployMode;
  readonly manifest: ManifestEnvelope;
  /**
   * Opaque upstream provenance recorded by the Takosumi kernel WAL.
   *
   * `takosumi-git` owns workflow / git semantics. The kernel does not execute
   * or interpret workflows, but it can persist this JSON chain so operators can
   * trace a deployed artifact back to a workflow run, git commit, and step log
   * digest set.
   */
  readonly provenance?: DeploymentProvenance;
}

export interface DeploymentProvenance {
  readonly kind: "takosumi-git.deployment-provenance@v1";
  readonly workflowRunId: string;
  readonly generatedAt: string;
  readonly event?: Record<string, unknown>;
  readonly git?: {
    readonly repository?: string;
    readonly repositoryUrl?: string;
    readonly ref?: string;
    readonly commitSha?: string;
  };
  readonly resourceArtifacts: readonly DeploymentResourceArtifactProvenance[];
}

export interface DeploymentResourceArtifactProvenance {
  readonly resourceName: string;
  readonly artifactName: string;
  readonly artifactUri: string;
  readonly artifactDigest?: string;
  readonly workflow: {
    readonly file: string;
    readonly job: string;
    readonly artifact: string;
  };
  readonly stepLogs: readonly DeploymentStepLogProvenance[];
}

export interface DeploymentStepLogProvenance {
  readonly stepName: string;
  readonly exitCode: number;
  readonly stdoutDigest: `sha256:${string}`;
  readonly stdoutBytes: number;
}

export interface DeployClientOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly idempotencyKey?: string;
  readonly retry?: false | DeployRetryOptions;
}

export interface DeployRetryOptions {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly retryStatuses?: readonly number[];
  readonly sleep?: (delayMs: number) => Promise<void>;
}

export interface DeployResponse {
  readonly status: number;
  readonly body: unknown;
  readonly attempts: number;
  readonly idempotencyKey: string;
}

const DEFAULT_RETRY_STATUSES = Object.freeze([
  408,
  425,
  429,
  500,
  502,
  503,
  504,
]);

export async function postDeployment(
  options: DeployClientOptions,
  request: DeployRequest,
): Promise<DeployResponse> {
  const fetchImpl = options.fetch ?? fetch;
  const url = new URL("/v1/deployments", options.endpoint).toString();
  const idempotencyKey = options.idempotencyKey ?? newIdempotencyKey();
  const retry = normalizeRetry(options.retry);
  const wireRequest = stripUnknownManifestKeys(request);
  const requestInit: RequestInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${options.token}`,
      "x-idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(wireRequest),
  };

  let lastError: unknown;
  for (let attempt = 1; attempt <= retry.attempts; attempt++) {
    try {
      const response = await fetchImpl(url, requestInit);
      const body = await response.json().catch(() => null);
      if (
        attempt < retry.attempts &&
        retry.retryStatuses.has(response.status)
      ) {
        await retry.sleep(backoffDelay(attempt, retry));
        continue;
      }
      return {
        status: response.status,
        body,
        attempts: attempt,
        idempotencyKey,
      };
    } catch (error) {
      lastError = error;
      if (attempt >= retry.attempts) break;
      await retry.sleep(backoffDelay(attempt, retry));
    }
  }
  throw lastError;
}

interface NormalizedRetry {
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly retryStatuses: ReadonlySet<number>;
  readonly sleep: (delayMs: number) => Promise<void>;
}

function normalizeRetry(
  options: false | DeployRetryOptions | undefined,
): NormalizedRetry {
  if (options === false) {
    return {
      attempts: 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryStatuses: new Set(),
      sleep: async () => {},
    };
  }
  return {
    attempts: Math.max(1, Math.floor(options?.attempts ?? 3)),
    baseDelayMs: Math.max(0, options?.baseDelayMs ?? 250),
    maxDelayMs: Math.max(0, options?.maxDelayMs ?? 2_000),
    retryStatuses: new Set(options?.retryStatuses ?? DEFAULT_RETRY_STATUSES),
    sleep: options?.sleep ?? defaultSleep,
  };
}

function backoffDelay(attempt: number, retry: NormalizedRetry): number {
  return Math.min(
    retry.maxDelayMs,
    retry.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function newIdempotencyKey(): string {
  return `takosumi-git-${crypto.randomUUID()}`;
}

/**
 * Allowed top-level manifest envelope keys per `@takos/takosumi-contract`
 * `validateManifestEnvelope`. Any other top-level key (notably a stray
 * client-side `template:` substitution block) is stripped before the
 * manifest is serialized so we never round-trip an "unknown field" reject
 * from the kernel.
 *
 * Resource-level extensions (e.g. `workflowRef`) are the responsibility of
 * the caller; the CLI `push` command resolves and strips those before
 * passing the manifest to `postDeployment`.
 */
const KERNEL_ALLOWED_MANIFEST_KEYS: ReadonlySet<string> = new Set([
  "@context",
  "apiVersion",
  "kind",
  "namespace",
  "metadata",
  "resources",
]);

function stripUnknownManifestKeys(request: DeployRequest): DeployRequest {
  const manifest = request.manifest;
  const hasUnknown = Object.keys(manifest).some(
    (key) => !KERNEL_ALLOWED_MANIFEST_KEYS.has(key),
  );
  if (!hasUnknown) return request;
  // Rebuild the envelope from typed fields. The discriminators come from the
  // already-typed input, so no `as unknown as ManifestEnvelope` laundering is
  // needed to land back in the contract type.
  const cleaned: ManifestEnvelope = {
    apiVersion: manifest.apiVersion,
    kind: manifest.kind,
    ...(manifest["@context"] !== undefined &&
      { "@context": manifest["@context"] }),
    ...(manifest.namespace !== undefined && { namespace: manifest.namespace }),
    ...(manifest.metadata !== undefined && { metadata: manifest.metadata }),
    ...(manifest.resources !== undefined && { resources: manifest.resources }),
  };
  return { ...request, manifest: cleaned };
}
