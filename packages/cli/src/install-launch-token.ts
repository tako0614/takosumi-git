/**
 * Install launch-token plumbing for `takosumi-git install apply`.
 *
 * Wraps the Accounts-side launch-token config GET/POST endpoints and the
 * assertion / redirect-URI hydration that surrounds them. Extracted from
 * install-apply.ts (Wave 6 follow-up) — behaviour is unchanged.
 */

import {
  type InstallableApp,
  type InstallableAppBindingType,
  isRecord,
} from "./install-parse.ts";
import {
  type AccountsInstallResponseSummary,
  InstallApplyError,
} from "./install-apply-types.ts";
import {
  absoluteUrl,
  hasNonEmptyEnvKey,
  normalizeBaseUrl,
  readResponseBody,
  stringProperty,
} from "./install-apply-helpers.ts";

// Required env keys that takosumi-git verifies are present in the Accounts
// launch-token config response. The app at runtime composes `redirect_uri`
// locally from `ACCOUNTS_BASE_URL` + `INSTALL_LAUNCH_CONSUME_PATH` (or its
// own runtime base URL), so `INSTALL_LAUNCH_REDIRECT_URI` is NOT a required
// Accounts-side field — see takosumi-git/docs/reference/binding-catalog.md §6.
export const installLaunchOpaqueEnvKeys = [
  "ACCOUNTS_BASE_URL",
  "INSTALL_LAUNCH_INSTALLATION_ID",
  "INSTALL_LAUNCH_CONSUME_PATH",
] as const;

// Optional env keys takosumi-git will pass through if Accounts (or local
// hydration with a runtime base URL) populates them. Apps may also derive
// these at runtime, so absence is not a hard failure.
export const installLaunchOpaquePassThroughEnvKeys = [
  "INSTALL_LAUNCH_REDIRECT_URI",
] as const;

const LAUNCH_TOKEN_BINDING_TYPE: InstallableAppBindingType =
  "install-launch-token@v1";

export function launchRedirectUri(
  runtimeBaseUrl: string,
  postInstallLaunchPath: string,
  launchReturnTo?: string,
): string {
  const url = new URL(absoluteUrl(runtimeBaseUrl, postInstallLaunchPath));
  if (launchReturnTo) url.searchParams.set("return_to", launchReturnTo);
  return url.toString();
}

export function withResolvedLaunchRedirectUri(
  config: Record<string, unknown>,
  input: {
    readonly runtimeBaseUrl?: string;
    readonly postInstallLaunchPath: string;
    readonly launchReturnTo?: string;
  },
): Record<string, unknown> {
  const env = isRecord(config.env) ? { ...config.env } : {};
  if (!hasNonEmptyEnvKey(env, "INSTALL_LAUNCH_REDIRECT_URI")) {
    if (!input.runtimeBaseUrl) return { ...config, env };
    const consumePath = stringProperty(config, "consume_path", "consumePath") ??
      input.postInstallLaunchPath;
    const redirectUri = launchRedirectUri(
      input.runtimeBaseUrl,
      consumePath,
      input.launchReturnTo,
    );
    env.INSTALL_LAUNCH_REDIRECT_URI = redirectUri;
    return {
      ...config,
      redirect_uri: redirectUri,
      redirectUri,
      env,
    };
  }
  return { ...config, env };
}

export async function fetchLaunchTokenConfig(input: {
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

export async function issueInstallLaunchToken(input: {
  readonly accountsUrl: string;
  readonly token?: string;
  readonly installationId: string;
  readonly redirectUri: string;
  readonly fetch?: typeof fetch;
}): Promise<Record<string, unknown>> {
  const response = await (input.fetch ?? fetch)(
    `${normalizeBaseUrl(input.accountsUrl)}/v1/installations/${
      encodeURIComponent(input.installationId)
    }/launch-token`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      },
      body: JSON.stringify({
        purpose: "install-bootstrap",
        ttlSeconds: 120,
        redirectUri: input.redirectUri,
      }),
    },
  );
  const body = await readResponseBody(response);
  if (response.status >= 400) {
    throw new InstallApplyError(response.status, body);
  }
  return isRecord(body) ? body : {};
}

export function appRequiresLaunchTokenConfig(app: InstallableApp): boolean {
  return Object.values(app.bindings).some((binding) =>
    binding.type === LAUNCH_TOKEN_BINDING_TYPE && binding.required
  );
}

export function launchTokenConfigEnv(
  accounts: AccountsInstallResponseSummary,
): Record<string, unknown> {
  const launchConfig = accounts.launchTokenConfig;
  return launchConfig && isRecord(launchConfig.env) ? launchConfig.env : {};
}

export function assertRequiredLaunchTokenConfig(
  app: InstallableApp,
  accounts: AccountsInstallResponseSummary,
): void {
  const missing: string[] = [];
  for (const [name, binding] of Object.entries(app.bindings)) {
    if (binding.type !== LAUNCH_TOKEN_BINDING_TYPE || !binding.required) {
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
    const launchEnv = launchTokenConfigEnv(accounts);
    for (const envKey of installLaunchOpaqueEnvKeys) {
      if (!hasNonEmptyEnvKey(launchEnv, envKey)) {
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
