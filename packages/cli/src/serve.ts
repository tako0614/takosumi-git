/**
 * `takosumi-git serve` implementation.
 *
 * Receives git webhooks, verifies provider signatures, deduplicates delivery
 * IDs, and dispatches `takosumi-git push`.
 */

import { parseArgs } from "@std/cli/parse-args";
import { dirname, join } from "@std/path";
import type { WorkflowEvent } from "@takos/takosumi-git-workflow-contract";
import {
  handleInstallApplyRequest,
  handleInstallPreviewRequest,
  handleInstallRevisionRequest,
} from "./install_handlers.ts";
import { applyInstall, type InstallSourceCheckoutFactory } from "./install.ts";
import { type ArtifactContract, parseArtifactContract, push } from "./push.ts";
import {
  deliveryId,
  isPushWebhookEvent,
  isRecord,
  normalizeWebhookEvent,
  providerFromPath,
  verifyWebhookSignature,
  type WebhookProvider,
} from "./webhook_signature.ts";
export { hmacSha256Hex, type WebhookProvider } from "./webhook_signature.ts";
import {
  fullCommitPattern,
  hasBearerToken,
  jsonResponse as json,
  parseOptionalRuntimeBaseUrl,
  pathFromSpec,
} from "./serve_helpers.ts";

export type WebhookMode = "push" | "install";

export interface ServeOptions {
  readonly host: string;
  readonly port: number;
  readonly endpoint: string;
  readonly token: string;
  readonly manifestPath: string;
  readonly workflowsDir: string;
  readonly webhookSecret: string;
  readonly artifactContract: ArtifactContract;
  readonly accountsUrl?: string;
  readonly accountsToken?: string;
  readonly accountId?: string;
  readonly spaceId?: string;
  readonly subject?: string;
  readonly webhookMode?: WebhookMode;
  readonly runtimeBaseUrl?: string;
  readonly deployToken?: string;
  readonly rateLimit: number;
  readonly rateLimitWindowMs: number;
  readonly installPreviewCheckoutSource?: InstallSourceCheckoutFactory;
  readonly installApplyFetch?: typeof fetch;
  readonly waitForDispatch?: boolean;
  readonly dispatch?: WebhookDispatch;
}

export interface ParsedServeArgs extends ServeOptions {}

export interface WebhookDispatchJob {
  readonly id: string;
  readonly provider: WebhookProvider;
  readonly event: WorkflowEvent;
}

export type WebhookDispatch = (job: WebhookDispatchJob) => Promise<void>;

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8788;
const DEFAULT_MANIFEST = ".takosumi/manifest.yml";
const DEFAULT_WORKFLOWS_DIR = ".takosumi/workflows";
const DEFAULT_RATE_LIMIT = 60;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

class InMemoryRateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #hits = new Map<string, number[]>();

  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  allow(key: string, now = Date.now()): boolean {
    const cutoff = now - this.#windowMs;
    const hits = (this.#hits.get(key) ?? []).filter((hit) => hit > cutoff);
    if (hits.length >= this.#limit) {
      this.#hits.set(key, hits);
      return false;
    }
    hits.push(now);
    this.#hits.set(key, hits);
    return true;
  }
}

class InMemoryWebhookQueue {
  readonly #seen = new Set<string>();
  readonly #queue: WebhookDispatchJob[] = [];
  #running = false;

  enqueue(job: WebhookDispatchJob): "queued" | "duplicate" {
    if (this.#seen.has(job.id)) return "duplicate";
    this.#seen.add(job.id);
    this.#queue.push(job);
    return "queued";
  }

  async drain(dispatch: WebhookDispatch): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#queue.length > 0) {
        const job = this.#queue.shift()!;
        await dispatch(job);
      }
    } finally {
      this.#running = false;
    }
  }
}

function rateLimitKey(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "direct";
}

export function createServeHandler(
  options: ServeOptions,
): (request: Request) => Promise<Response> {
  const queue = new InMemoryWebhookQueue();
  const limiter = new InMemoryRateLimiter(
    options.rateLimit,
    options.rateLimitWindowMs,
  );
  const dispatch = options.dispatch ?? defaultDispatch(options);

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "takosumi-git-serve" }, 200);
    }
    if (request.method === "POST" && url.pathname === "/v1/install/preview") {
      if (!limiter.allow(rateLimitKey(request))) {
        return json({ error: "rate_limited" }, 429);
      }
      return await handleInstallPreviewRequest(
        request,
        options.installPreviewCheckoutSource,
      );
    }
    if (request.method === "POST" && url.pathname === "/v1/install/apply") {
      if (!limiter.allow(rateLimitKey(request))) {
        return json({ error: "rate_limited" }, 429);
      }
      if (!hasBearerToken(request, options.token)) {
        return json({ error: "unauthorized" }, 401);
      }
      return await handleInstallApplyRequest(request, options);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/v1/install/revision/preview"
    ) {
      if (!limiter.allow(rateLimitKey(request))) {
        return json({ error: "rate_limited" }, 429);
      }
      if (!hasBearerToken(request, options.token)) {
        return json({ error: "unauthorized" }, 401);
      }
      return await handleInstallRevisionRequest(request, options, false);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/v1/install/revision/apply"
    ) {
      if (!limiter.allow(rateLimitKey(request))) {
        return json({ error: "rate_limited" }, 429);
      }
      if (!hasBearerToken(request, options.token)) {
        return json({ error: "unauthorized" }, 401);
      }
      return await handleInstallRevisionRequest(request, options, true);
    }
    if (request.method !== "POST") return json({ error: "not_found" }, 404);
    const provider = providerFromPath(url.pathname);
    if (!provider) return json({ error: "not_found" }, 404);
    if (!limiter.allow(rateLimitKey(request))) {
      return json({ error: "rate_limited" }, 429);
    }

    const rawBody = await request.text();
    const verified = await verifyWebhookSignature(
      provider,
      options.webhookSecret,
      request.headers,
      rawBody,
    );
    if (!verified) return json({ error: "invalid_signature" }, 401);

    if (!isPushWebhookEvent(provider, request.headers)) {
      return json({
        ok: true,
        queued: false,
        ignored: true,
        reason: "unsupported_event",
      }, 202);
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const id = deliveryId(provider, request.headers, body);
    const status = queue.enqueue({
      id,
      provider,
      event: normalizeWebhookEvent(provider, request.headers, body),
    });
    if (status === "duplicate") {
      return json({ ok: true, queued: false, duplicate: true }, 202);
    }

    const drain = queue.drain(dispatch);
    if (options.waitForDispatch ?? false) await drain;
    else {
      drain.catch((error) => {
        console.error(
          `takosumi-git serve dispatch failed: ${(error as Error).message}`,
        );
      });
    }
    return json({ ok: true, queued: true, duplicate: false }, 202);
  };
}

function defaultDispatch(options: ServeOptions): WebhookDispatch {
  return async (job) => {
    if ((options.webhookMode ?? "push") === "install") {
      await dispatchInstallWebhook(options, job);
      return;
    }
    await push({
      endpoint: options.endpoint,
      token: options.token,
      manifestPath: options.manifestPath,
      workflowsDir: options.workflowsDir,
      mode: "apply",
      dryRun: false,
      artifactContract: options.artifactContract,
      event: job.event,
    });
  };
}

async function dispatchInstallWebhook(
  options: ServeOptions,
  job: WebhookDispatchJob,
): Promise<void> {
  if (
    !options.accountsUrl || !options.accountsToken || !options.accountId ||
    !options.spaceId || !options.subject
  ) {
    throw new Error(
      "webhook install mode requires accounts URL, accounts token, account id, space id, and subject",
    );
  }
  const cwd = Deno.cwd();
  const manifestPath = pathFromSpec(cwd, options.manifestPath);
  const projectRoot = dirname(dirname(manifestPath));
  const sourceCommit = eventCommit(job.event);
  await applyInstall({
    subcommand: "apply",
    cwd: projectRoot,
    appPath: join(projectRoot, ".takosumi", "app.yml"),
    manifestPath,
    json: true,
    accountsUrl: options.accountsUrl,
    token: options.accountsToken,
    accountId: options.accountId,
    spaceId: options.spaceId,
    createdBySubject: options.subject,
    ...(sourceCommit ? { sourceCommit } : {}),
    ...(options.runtimeBaseUrl
      ? { runtimeBaseUrl: options.runtimeBaseUrl }
      : {}),
    endpoint: options.endpoint,
    deployToken: options.deployToken ?? options.token,
    ...(options.installApplyFetch ? { fetch: options.installApplyFetch } : {}),
  });
}

function eventCommit(event: WorkflowEvent): string | undefined {
  const commit = isRecord(event.payload)
    ? typeof event.payload.commit === "string" ? event.payload.commit : ""
    : "";
  return fullCommitPattern.test(commit) ? commit : undefined;
}

function parseWebhookMode(value: string): WebhookMode {
  if (value === "push" || value === "install") return value;
  throw new Error("--webhook-mode must be push or install");
}

function parsePositiveInt(raw: unknown, field: string): number {
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer (got '${raw}')`);
  }
  return value;
}

export function parseServeArgs(
  args: readonly string[],
  env: { get(key: string): string | undefined } = Deno.env,
): ParsedServeArgs {
  rejectRemovedServiceResolverOptions(args);
  const flags = parseArgs(args as string[], {
    string: [
      "host",
      "port",
      "endpoint",
      "token",
      "manifest",
      "workflows-dir",
      "webhook-secret",
      "webhook-mode",
      "artifact-contract",
      "accounts-url",
      "accounts-token",
      "account-id",
      "space",
      "space-id",
      "subject",
      "runtime-base-url",
      "deploy-token",
      "rate-limit",
      "rate-limit-window-ms",
    ],
    default: {
      host: DEFAULT_HOST,
      port: String(DEFAULT_PORT),
      manifest: DEFAULT_MANIFEST,
      "workflows-dir": DEFAULT_WORKFLOWS_DIR,
      "artifact-contract": "v1",
      "rate-limit": String(DEFAULT_RATE_LIMIT),
      "rate-limit-window-ms": String(DEFAULT_RATE_LIMIT_WINDOW_MS),
    },
  });
  const endpoint = (flags.endpoint as string | undefined) ??
    env.get("TAKOSUMI_ENDPOINT") ?? "";
  const token = (flags.token as string | undefined) ??
    env.get("TAKOSUMI_TOKEN") ?? "";
  const webhookSecret = (flags["webhook-secret"] as string | undefined) ??
    env.get("TAKOSUMI_GIT_WEBHOOK_SECRET") ?? "";
  const webhookMode = parseWebhookMode(
    (flags["webhook-mode"] as string | undefined) ??
      env.get("TAKOSUMI_GIT_WEBHOOK_MODE") ?? "push",
  );
  const accountsUrl = (flags["accounts-url"] as string | undefined) ??
    env.get("TAKOSUMI_ACCOUNTS_URL");
  const accountsToken = (flags["accounts-token"] as string | undefined) ??
    env.get("TAKOSUMI_ACCOUNTS_TOKEN") ?? env.get("TAKOS_TOKEN");
  const accountId = (flags["account-id"] as string | undefined) ??
    env.get("TAKOS_ACCOUNT_ID");
  const spaceId = (flags["space-id"] as string | undefined) ??
    (flags.space as string | undefined) ?? env.get("TAKOS_SPACE_ID");
  const subject = (flags.subject as string | undefined) ??
    env.get("TAKOSUMI_SUBJECT") ?? env.get("TAKOS_SUBJECT");
  const runtimeBaseUrl = parseOptionalRuntimeBaseUrl(
    (flags["runtime-base-url"] as string | undefined) ??
      env.get("TAKOSUMI_RUNTIME_BASE_URL"),
  );
  const deployToken = (flags["deploy-token"] as string | undefined) ??
    env.get("TAKOSUMI_DEPLOY_TOKEN") ?? env.get("TAKOSUMI_TOKEN");
  if (!endpoint) throw new Error("missing --endpoint (or TAKOSUMI_ENDPOINT)");
  if (!token) throw new Error("missing --token (or TAKOSUMI_TOKEN)");
  if (!webhookSecret) {
    throw new Error(
      "missing --webhook-secret (or TAKOSUMI_GIT_WEBHOOK_SECRET)",
    );
  }
  if (
    webhookMode === "install" &&
    (!accountsUrl || !accountsToken || !accountId || !spaceId || !subject)
  ) {
    throw new Error(
      "--webhook-mode install requires --accounts-url, --accounts-token, --account-id, --space-id, and --subject",
    );
  }
  return {
    host: flags.host as string,
    port: parsePositiveInt(flags.port, "--port"),
    endpoint,
    token,
    manifestPath: flags.manifest as string,
    workflowsDir: flags["workflows-dir"] as string,
    webhookSecret,
    webhookMode,
    artifactContract: parseArtifactContract(flags["artifact-contract"]),
    ...(accountsUrl ? { accountsUrl } : {}),
    ...(accountsToken ? { accountsToken } : {}),
    ...(accountId ? { accountId } : {}),
    ...(spaceId ? { spaceId } : {}),
    ...(subject ? { subject } : {}),
    ...(runtimeBaseUrl ? { runtimeBaseUrl } : {}),
    ...(deployToken ? { deployToken } : {}),
    rateLimit: parsePositiveInt(flags["rate-limit"], "--rate-limit"),
    rateLimitWindowMs: parsePositiveInt(
      flags["rate-limit-window-ms"],
      "--rate-limit-window-ms",
    ),
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

export async function runServeCli(args: readonly string[]): Promise<number> {
  let parsed: ParsedServeArgs;
  try {
    parsed = parseServeArgs(args);
  } catch (error) {
    Deno.stderr.writeSync(
      new TextEncoder().encode(
        `takosumi-git serve: ${(error as Error).message}\n`,
      ),
    );
    return 64;
  }

  const handler = createServeHandler(parsed);
  Deno.serve({ hostname: parsed.host, port: parsed.port }, handler);
  await new Promise(() => {});
  return 0;
}
