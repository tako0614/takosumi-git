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

export interface ManifestEnvelope {
  readonly apiVersion: "1.0";
  readonly kind: "Manifest";
  readonly metadata?: { name?: string; labels?: Record<string, string> };
  readonly template?: {
    readonly template: string;
    readonly inputs?: Record<string, unknown>;
  };
  readonly resources?: ReadonlyArray<{
    readonly shape: string;
    readonly name: string;
    readonly provider: string;
    readonly spec: unknown;
    readonly requires?: readonly string[];
    readonly metadata?: Record<string, unknown>;
  }>;
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
  const requestInit: RequestInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${options.token}`,
      "x-idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(request),
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
