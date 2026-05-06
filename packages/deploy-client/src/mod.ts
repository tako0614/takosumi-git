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
}

export interface DeployClientOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
}

export interface DeployResponse {
  readonly status: number;
  readonly body: unknown;
}

export async function postDeployment(
  options: DeployClientOptions,
  request: DeployRequest,
): Promise<DeployResponse> {
  const fetchImpl = options.fetch ?? fetch;
  const url = new URL("/v1/deployments", options.endpoint).toString();
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${options.token}`,
    },
    body: JSON.stringify(request),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}
