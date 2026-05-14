/**
 * Webhook signature verification helpers for `takosumi-git serve`.
 *
 * Provider-specific HMAC verification, event header parsing, and delivery ID
 * extraction live here so the HTTP entry point can stay focused on routing.
 */

import type { WorkflowEvent } from "@takos/takosumi-git-workflow-contract";
import { eventFromGitPush } from "@takos/takosumi-git-source";

export type WebhookProvider = "github" | "gitlab" | "gitea";

export function headerValue(headers: Headers, name: string): string {
  return headers.get(name) ?? "";
}

export function providerFromPath(pathname: string): WebhookProvider | null {
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

function webhookEventHeader(
  provider: WebhookProvider,
  headers: Headers,
): string {
  switch (provider) {
    case "github":
      return headerValue(headers, "x-github-event");
    case "gitea":
      return headerValue(headers, "x-gitea-event") ||
        headerValue(headers, "x-github-event");
    case "gitlab":
      return headerValue(headers, "x-gitlab-event");
  }
}

export function isPushWebhookEvent(
  provider: WebhookProvider,
  headers: Headers,
): boolean {
  const event = webhookEventHeader(provider, headers).trim().toLowerCase();
  if (!event) return true;
  switch (provider) {
    case "github":
    case "gitea":
      return event === "push";
    case "gitlab":
      return event === "push hook" || event === "tag push hook";
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

export function deliveryId(
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

export function normalizeWebhookEvent(
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
