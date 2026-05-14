/**
 * Shared helpers for `takosumi-git serve` HTTP handlers.
 *
 * These are split from `serve.ts` and the install/revision handlers so that
 * body parsing, source-commit normalization, and runtime-base-url validation
 * can be reused without circular imports.
 */

import { isAbsolute, join } from "@std/path";
import {
  INSTALLABLE_APP_RUNTIME_MODES,
  type InstallableAppRuntimeMode,
} from "./install.ts";

export const fullCommitPattern = /^[0-9a-f]{40}$/;

export function optionalBodyString(
  body: Record<string, unknown>,
  key: string,
  alternateKey?: string,
): string | undefined {
  const value = body[key] ?? (alternateKey ? body[alternateKey] : undefined);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function optionalBodyBoolean(
  body: Record<string, unknown>,
  key: string,
  alternateKey?: string,
): boolean | undefined {
  const value = body[key] ?? (alternateKey ? body[alternateKey] : undefined);
  return typeof value === "boolean" ? value : undefined;
}

export function hasBearerToken(request: Request, token: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${token}`;
}

export function parseOptionalSourceCommit(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  if (!fullCommitPattern.test(value)) {
    throw new Error("sourceCommit must be a 40-char SHA");
  }
  return value;
}

export function parseOptionalBodyMode(
  body: Record<string, unknown>,
): InstallableAppRuntimeMode | undefined {
  const value = optionalBodyString(body, "mode");
  if (!value) return undefined;
  if (
    INSTALLABLE_APP_RUNTIME_MODES.includes(value as InstallableAppRuntimeMode)
  ) {
    return value as InstallableAppRuntimeMode;
  }
  throw new Error(
    `mode must be one of ${INSTALLABLE_APP_RUNTIME_MODES.join("|")}`,
  );
}

export function parseOptionalRuntimeBaseUrl(
  value: string | undefined,
): string | undefined {
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
      "runtimeBaseUrl must be an https URL or localhost http URL",
    );
  }
}

export function pathFromSpec(cwd: string, spec: string): string {
  return isAbsolute(spec) ? spec : join(cwd, spec);
}

export function jsonResponse(body: object, status: number): Response {
  return Response.json(body, { status });
}
