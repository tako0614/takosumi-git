/**
 * Shared internal helpers for the `install-apply` family of modules.
 *
 * These helpers were private to `install-apply.ts` until the file was split.
 * They are NOT a new abstraction — they exist only so that the extracted
 * `install-launch-token.ts` and `install-placeholders.ts` modules can share
 * the same primitives without recreating them.
 */

import { type InstallableAppBindingType, isRecord } from "./install-parse.ts";
import type { AccountsInstallResponseSummary } from "./install-apply-types.ts";

export function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function stringProperty(
  record: Record<string, unknown>,
  snakeKey: string,
  camelKey: string,
): string | undefined {
  const value = record[snakeKey] ?? record[camelKey];
  return stringFromUnknown(value);
}

export function numberProperty(
  record: Record<string, unknown>,
  snakeKey: string,
  camelKey: string,
): number | undefined {
  const value = record[snakeKey] ?? record[camelKey];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

export function stringArrayProperty(
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

export function stringRecordProperty(
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

export function bindingRecordForName(
  accounts: AccountsInstallResponseSummary,
  name: string,
): Record<string, unknown> | undefined {
  return accounts.bindings.find((entry) =>
    stringProperty(entry, "name", "name") === name
  );
}

export function isProviderBackedBinding(
  type: InstallableAppBindingType,
): boolean {
  return type === "database.postgres@v1" ||
    type === "object-store.s3-compatible@v1" ||
    type === "domain.http@v1" ||
    type === "deploy-intent.gitops@v1";
}

export function hasNonEmptyEnvKey(
  env: Record<string, unknown>,
  key: string,
): boolean {
  const normalized = key.toUpperCase();
  return Object.entries(env).some(([existing, value]) =>
    existing.toUpperCase() === normalized &&
    typeof value === "string" &&
    value.length > 0
  );
}

export function hasEnvKey(env: Record<string, unknown>, key: string): boolean {
  const normalized = key.toUpperCase();
  return Object.keys(env).some((existing) =>
    existing.toUpperCase() === normalized
  );
}

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function absoluteUrl(baseUrl: string, path: string): string {
  const base = `${normalizeBaseUrl(baseUrl)}/`;
  return new URL(path.replace(/^\/+/, ""), base).toString();
}

export async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
