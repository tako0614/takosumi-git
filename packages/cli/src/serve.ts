/**
 * `takosumi-git serve` implementation.
 *
 * Receives git webhooks, verifies provider signatures, deduplicates delivery
 * IDs, and dispatches `takosumi-git push`.
 */

import { parseArgs } from "@std/cli/parse-args";
import type { WorkflowEvent } from "@takos/takosumi-git-workflow-contract";
import { eventFromGitPush } from "@takos/takosumi-git-source";
import { type ArtifactContract, parseArtifactContract, push } from "./push.ts";

export type WebhookProvider = "github" | "gitlab" | "gitea";

export interface ServeOptions {
  readonly host: string;
  readonly port: number;
  readonly endpoint: string;
  readonly token: string;
  readonly manifestPath: string;
  readonly workflowsDir: string;
  readonly webhookSecret: string;
  readonly artifactContract: ArtifactContract;
  readonly rateLimit: number;
  readonly rateLimitWindowMs: number;
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

function headerValue(headers: Headers, name: string): string {
  return headers.get(name) ?? "";
}

function providerFromPath(pathname: string): WebhookProvider | null {
  const match = pathname.match(/^\/webhooks\/(github|gitlab|gitea)$/);
  return match ? match[1] as WebhookProvider : null;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function hmacSha256Hex(
  secret: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return bytesToHex(new Uint8Array(signature));
}

function signatureHeader(provider: WebhookProvider, headers: Headers): string {
  switch (provider) {
    case "github":
      return headerValue(headers, "x-hub-signature-256");
    case "gitea":
      return headerValue(headers, "x-gitea-signature-256") ||
        headerValue(headers, "x-hub-signature-256");
    case "gitlab":
      return headerValue(headers, "x-gitlab-signature-256");
  }
}

export async function verifyWebhookSignature(
  provider: WebhookProvider,
  secret: string,
  headers: Headers,
  body: string,
): Promise<boolean> {
  if (!secret) return false;
  const rawSignature = signatureHeader(provider, headers);
  const hex = rawSignature.startsWith("sha256=")
    ? rawSignature.slice("sha256=".length)
    : rawSignature;
  const actual = hexToBytes(hex);
  if (!actual) return false;
  const expected = hexToBytes(await hmacSha256Hex(secret, body));
  return !!expected && timingSafeEqual(actual, expected);
}

function deliveryId(
  provider: WebhookProvider,
  headers: Headers,
  body: unknown,
): string {
  const explicit = provider === "github"
    ? headerValue(headers, "x-github-delivery")
    : provider === "gitea"
    ? headerValue(headers, "x-gitea-delivery")
    : headerValue(headers, "x-gitlab-event-uuid");
  if (explicit) return `${provider}:${explicit}`;
  if (isRecord(body)) {
    const after = typeof body.after === "string" ? body.after : "";
    const ref = typeof body.ref === "string" ? body.ref : "";
    if (after || ref) return `${provider}:${ref}:${after}`;
  }
  return `${provider}:unknown:${Date.now()}`;
}

function normalizeWebhookEvent(
  provider: WebhookProvider,
  headers: Headers,
  body: unknown,
): WorkflowEvent {
  if (!isRecord(body)) {
    return {
      kind: "webhook",
      source: provider,
      payload: { body },
    };
  }
  const ref = typeof body.ref === "string" ? body.ref : "";
  const commit = typeof body.after === "string"
    ? body.after
    : typeof body.checkout_sha === "string"
    ? body.checkout_sha
    : "";
  const repository = isRecord(body.repository) ? body.repository : {};
  const repo = typeof repository.full_name === "string"
    ? repository.full_name
    : typeof repository.path_with_namespace === "string"
    ? repository.path_with_namespace
    : typeof repository.name === "string"
    ? repository.name
    : provider;
  const pusher = isRecord(body.pusher) && typeof body.pusher.name === "string"
    ? body.pusher.name
    : isRecord(body.user) && typeof body.user.username === "string"
    ? body.user.username
    : undefined;
  const event = eventFromGitPush({ repo, ref, commit, pusher });
  return {
    ...event,
    payload: {
      ...event.payload,
      provider,
      delivery: deliveryId(provider, headers, body),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

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

function json(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, { status });
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
  const flags = parseArgs(args as string[], {
    string: [
      "host",
      "port",
      "endpoint",
      "token",
      "manifest",
      "workflows-dir",
      "webhook-secret",
      "artifact-contract",
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
  if (!endpoint) throw new Error("missing --endpoint (or TAKOSUMI_ENDPOINT)");
  if (!token) throw new Error("missing --token (or TAKOSUMI_TOKEN)");
  if (!webhookSecret) {
    throw new Error(
      "missing --webhook-secret (or TAKOSUMI_GIT_WEBHOOK_SECRET)",
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
    artifactContract: parseArtifactContract(flags["artifact-contract"]),
    rateLimit: parsePositiveInt(flags["rate-limit"], "--rate-limit"),
    rateLimitWindowMs: parsePositiveInt(
      flags["rate-limit-window-ms"],
      "--rate-limit-window-ms",
    ),
  };
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
