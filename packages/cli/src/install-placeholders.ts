/**
 * Installer placeholder materialization for `takosumi-git install apply`.
 *
 * Resolves `${installation.*}` / `${bindings.*}` / `${secrets.*}` /
 * `${refs.*}` placeholders against the AppInstallation response from
 * Takosumi Accounts, and injects standard runtime env (DATABASE_URL,
 * OIDC_*, BASE_URL, INSTALL_LAUNCH_*) into the compiled deploy manifest's
 * web-service / worker resources and `compute.*` entries.
 *
 * Extracted from install-apply.ts (Wave 6 follow-up). Behaviour is
 * unchanged — install-apply.ts wires `applyAccountsPlaceholders` and
 * `applyAccountsRuntimeEnv` into `buildInstallDeployRequest` exactly as
 * before.
 */

import {
  type InstallableApp,
  type InstallableAppBindingType,
  isRecord,
} from "./install-parse.ts";
import { installerPlaceholderGlobalPattern } from "./install-compile.ts";
import type { AccountsInstallResponseSummary } from "./install-apply-types.ts";
import {
  bindingRecordForName,
  hasEnvKey,
  normalizeBaseUrl,
  numberProperty,
  stringArrayProperty,
  stringFromUnknown,
  stringProperty,
} from "./install-apply-helpers.ts";
import {
  installLaunchOpaqueEnvKeys,
  installLaunchOpaquePassThroughEnvKeys,
  launchTokenConfigEnv,
} from "./install-launch-token.ts";

export function applyAccountsPlaceholders(input: {
  manifest: Record<string, unknown>;
  app: InstallableApp;
  accounts: AccountsInstallResponseSummary;
  accountId?: string;
  spaceId?: string;
  runtimeBaseUrl?: string;
}): void {
  replaceInstallerPlaceholders(input.manifest, "$", input);
}

function replaceInstallerPlaceholders(
  value: unknown,
  path: string,
  context: {
    app: InstallableApp;
    accounts: AccountsInstallResponseSummary;
    accountId?: string;
    spaceId?: string;
    runtimeBaseUrl?: string;
  },
): unknown {
  if (typeof value === "string") {
    const matches = [...value.matchAll(installerPlaceholderGlobalPattern)];
    if (matches.length === 0) return value;
    if (matches.length === 1 && matches[0][0] === value) {
      return resolveInstallerPlaceholder(matches[0], path, context);
    }
    return value.replace(
      installerPlaceholderGlobalPattern,
      (...args: unknown[]) => {
        const match = args as [string, string, string, ...unknown[]];
        const resolved = resolveInstallerPlaceholder(match, path, context);
        if (typeof resolved === "string") return resolved;
        if (typeof resolved === "number" || typeof resolved === "boolean") {
          return String(resolved);
        }
        throw new Error(
          `entry manifest contains non-scalar installer placeholder at ${path}: ${
            match[0]
          }`,
        );
      },
    );
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      value[index] = replaceInstallerPlaceholders(
        entry,
        `${path}[${index}]`,
        context,
      );
    }
    return value;
  }
  if (!isRecord(value)) return value;
  for (const [key, entry] of Object.entries(value)) {
    value[key] = replaceInstallerPlaceholders(entry, `${path}.${key}`, context);
  }
  return value;
}

function resolveInstallerPlaceholder(
  match: readonly unknown[],
  path: string,
  context: {
    app: InstallableApp;
    accounts: AccountsInstallResponseSummary;
    accountId?: string;
    spaceId?: string;
    runtimeBaseUrl?: string;
  },
): unknown {
  const placeholder = String(match[0]);
  const namespace = String(match[1]);
  const keyPath = String(match[2]);
  if (namespace === "imports") {
    throw new Error(
      `entry manifest contains removed imports placeholder at ${path}: ${placeholder}`,
    );
  }
  if (namespace === "installation") {
    return resolveInstallationPlaceholder(keyPath, placeholder, context);
  }
  if (namespace === "refs") {
    const dot = keyPath.indexOf(".");
    const bindingName = dot === -1 ? keyPath : keyPath.slice(0, dot);
    const bindingKey = dot === -1 ? "" : keyPath.slice(dot + 1);
    return resolveBindingRefPlaceholder({
      ...context,
      bindingName,
      bindingKey,
      placeholder,
      path,
    });
  }
  if (namespace === "bindings" || namespace === "secrets") {
    const dot = keyPath.indexOf(".");
    const bindingName = dot === -1 ? keyPath : keyPath.slice(0, dot);
    const bindingKey = dot === -1 ? "" : keyPath.slice(dot + 1);
    return resolveBindingPlaceholder({
      ...context,
      bindingName,
      bindingKey,
      secret: namespace === "secrets",
      placeholder,
      path,
    });
  }
  throw new Error(
    `entry manifest contains unresolved installer placeholder at ${path}: ${placeholder}`,
  );
}

function resolveInstallationPlaceholder(
  keyPath: string,
  placeholder: string,
  context: {
    accounts: AccountsInstallResponseSummary;
    accountId?: string;
    spaceId?: string;
    runtimeBaseUrl?: string;
  },
): unknown {
  const values: Record<string, unknown> = {
    id: context.accounts.installationId,
    installationId: context.accounts.installationId,
    accountId: context.accountId,
    spaceId: context.spaceId,
    baseUrl: context.runtimeBaseUrl
      ? normalizeBaseUrl(context.runtimeBaseUrl)
      : undefined,
  };
  return requiredPlaceholderValue(values[keyPath], placeholder);
}

function resolveBindingPlaceholder(input: {
  app: InstallableApp;
  accounts: AccountsInstallResponseSummary;
  runtimeBaseUrl?: string;
  bindingName: string;
  bindingKey: string;
  secret: boolean;
  placeholder: string;
  path: string;
}): unknown {
  const binding = input.app.bindings[input.bindingName];
  if (!binding) {
    throw new Error(
      `entry manifest references unknown binding at ${input.path}: ${input.placeholder}`,
    );
  }
  const materialized = bindingRecordForName(input.accounts, input.bindingName);
  if (
    binding.required &&
    (!materialized ||
      (stringProperty(materialized, "config_ref", "configRef") ?? "")
        .startsWith("takosumi-git://"))
  ) {
    throw new Error(
      `entry manifest references unmaterialized binding at ${input.path}: ${input.placeholder}`,
    );
  }
  const values = input.secret
    ? secretPlaceholderValues(binding.type, input)
    : bindingPlaceholderValues(binding.type, input);
  return requiredPlaceholderValue(values[input.bindingKey], input.placeholder);
}

function resolveBindingRefPlaceholder(input: {
  app: InstallableApp;
  accounts: AccountsInstallResponseSummary;
  bindingName: string;
  bindingKey: string;
  placeholder: string;
  path: string;
}): unknown {
  const binding = input.app.bindings[input.bindingName];
  if (!binding) {
    throw new Error(
      `entry manifest references unknown binding at ${input.path}: ${input.placeholder}`,
    );
  }
  const materialized = bindingRecordForName(input.accounts, input.bindingName);
  if (!materialized) {
    throw new Error(
      `entry manifest references unmaterialized binding at ${input.path}: ${input.placeholder}`,
    );
  }
  const configRef = stringProperty(materialized, "config_ref", "configRef");
  if (!configRef || configRef.startsWith("takosumi-git://")) {
    throw new Error(
      `entry manifest references unmaterialized binding at ${input.path}: ${input.placeholder}`,
    );
  }
  const secretRefs = stringArrayProperty(
    materialized,
    "secret_refs",
    "secretRefs",
  );
  const values: Record<string, unknown> = {
    id: stringProperty(materialized, "id", "id"),
    installationId: stringProperty(
      materialized,
      "installation_id",
      "installationId",
    ),
    name: stringProperty(materialized, "name", "name"),
    kind: stringProperty(materialized, "kind", "kind"),
    configRef,
    config_ref: configRef,
    secretRefs,
    secret_refs: secretRefs,
    ...indexedValues("secretRefs", secretRefs),
    ...indexedValues("secret_refs", secretRefs),
  };
  return requiredPlaceholderValue(values[input.bindingKey], input.placeholder);
}

function bindingPlaceholderValues(
  type: InstallableAppBindingType,
  input: {
    accounts: AccountsInstallResponseSummary;
    runtimeBaseUrl?: string;
    bindingName: string;
  },
): Record<string, unknown> {
  if (type === "identity.oidc@v1") {
    const oidcClient = input.accounts.oidcClient ?? {};
    const redirectUris = stringArrayProperty(
      oidcClient,
      "redirect_uris",
      "redirectUris",
    );
    return {
      issuerUrl: stringProperty(oidcClient, "issuer_url", "issuerUrl"),
      clientId: stringProperty(oidcClient, "client_id", "clientId"),
      redirectUri: redirectUris[0],
      redirectUris,
      ...indexedValues("redirectUris", redirectUris),
    };
  }
  if (type === "database.postgres@v1") {
    return postgresPlaceholderValues(input.accounts.bindingEnv?.DATABASE_URL);
  }
  if (type === "object-store.s3-compatible@v1") {
    const env = input.accounts.bindingEnv ?? {};
    return {
      endpoint: env.BLOB_ENDPOINT,
      bucket: env.BLOB_BUCKET,
      accessKey: env.BLOB_ACCESS_KEY,
      region: env.BLOB_REGION,
    };
  }
  if (type === "domain.http@v1") {
    const url = input.runtimeBaseUrl
      ? normalizeBaseUrl(input.runtimeBaseUrl)
      : undefined;
    return {
      hostname: url ? new URL(url).hostname : undefined,
      url,
    };
  }
  if (type === "deploy-intent.gitops@v1") {
    const env = input.accounts.bindingEnv ?? {};
    const binding = bindingRecordForName(input.accounts, input.bindingName) ??
      {};
    return {
      driver: env.DEPLOY_INTENT_DRIVER ?? "gitops",
      remote: env.DEPLOY_INTENT_REMOTE,
      branch: stringProperty(binding, "branch", "branch"),
      writePathPrefix: stringProperty(
        binding,
        "write_path_prefix",
        "writePathPrefix",
      ),
    };
  }
  if (type === "install-launch-token@v1") {
    const launchConfig = input.accounts.launchTokenConfig ?? {};
    const env = launchTokenConfigEnv(input.accounts);
    return {
      accountsBaseUrl: stringFromUnknown(env.ACCOUNTS_BASE_URL) ??
        stringProperty(launchConfig, "accounts_base_url", "accountsBaseUrl"),
      installationId: stringFromUnknown(env.INSTALL_LAUNCH_INSTALLATION_ID) ??
        stringProperty(launchConfig, "installation_id", "installationId") ??
        input.accounts.installationId,
      redirectUri: stringFromUnknown(env.INSTALL_LAUNCH_REDIRECT_URI) ??
        stringProperty(launchConfig, "redirect_uri", "redirectUri"),
      consumePath: stringFromUnknown(env.INSTALL_LAUNCH_CONSUME_PATH) ??
        stringProperty(launchConfig, "consume_path", "consumePath"),
      maxLifetimeSeconds: numberProperty(
        launchConfig,
        "max_lifetime_seconds",
        "maxLifetimeSeconds",
      ),
    };
  }
  return {};
}

function secretPlaceholderValues(
  type: InstallableAppBindingType,
  input: { accounts: AccountsInstallResponseSummary },
): Record<string, unknown> {
  if (type === "identity.oidc@v1") {
    return { clientSecret: input.accounts.oidcClientSecret };
  }
  if (type === "database.postgres@v1") {
    return postgresPlaceholderValues(input.accounts.bindingEnv?.DATABASE_URL);
  }
  if (type === "object-store.s3-compatible@v1") {
    return { secretKey: input.accounts.bindingEnv?.BLOB_SECRET_KEY };
  }
  if (type === "deploy-intent.gitops@v1") {
    return { token: input.accounts.bindingEnv?.DEPLOY_INTENT_TOKEN };
  }
  return {};
}

function postgresPlaceholderValues(
  urlValue: string | undefined,
): Record<string, unknown> {
  if (!urlValue) return {};
  try {
    const url = new URL(urlValue);
    return {
      host: url.hostname,
      port: url.port || "5432",
      database: decodeURIComponent(url.pathname.replace(/^\//, "")),
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      sslMode: url.searchParams.get("sslmode") ?? "require",
      url: urlValue,
    };
  } catch {
    return { url: urlValue };
  }
}

function indexedValues(
  prefix: string,
  values: readonly unknown[],
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  values.forEach((value, index) => {
    output[`${prefix}[${index}]`] = value;
  });
  return output;
}

function requiredPlaceholderValue(
  value: unknown,
  placeholder: string,
): unknown {
  if (value === undefined || value === null || value === "") {
    throw new Error(
      `entry manifest contains unresolved installer placeholder: ${placeholder}`,
    );
  }
  return value;
}

export function applyAccountsRuntimeEnv(input: {
  manifest: Record<string, unknown>;
  app: InstallableApp;
  accounts: AccountsInstallResponseSummary;
  runtimeBaseUrl?: string;
}): void {
  const env = accountsRuntimeEnv(input);
  if (Object.keys(env).length === 0) return;

  const resources = input.manifest.resources;
  if (Array.isArray(resources)) {
    for (const [index, resource] of resources.entries()) {
      if (!isRecord(resource) || !isInstallRuntimeResource(resource)) continue;
      if (!isRecord(resource.spec)) {
        throw new Error(`manifest.resources[${index}].spec must be an object`);
      }
      injectMissingEnv(resource.spec, env, `manifest.resources[${index}].spec`);
    }
  }

  const compute = input.manifest.compute;
  if (isRecord(compute)) {
    for (const [name, component] of Object.entries(compute)) {
      if (!isRecord(component)) continue;
      injectMissingEnv(component, env, `manifest.compute.${name}`);
    }
  }
}

function accountsRuntimeEnv(input: {
  app: InstallableApp;
  accounts: AccountsInstallResponseSummary;
  runtimeBaseUrl?: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.accounts.bindingEnv ?? {})) {
    env[key] = value;
  }
  if (input.accounts.installationId) {
    env.TAKOS_INSTALLATION_ID = input.accounts.installationId;
  }
  if (input.runtimeBaseUrl) {
    env.BASE_URL = normalizeBaseUrl(input.runtimeBaseUrl);
  }

  if (appHasBindingType(input.app, "identity.oidc@v1")) {
    const oidcClient = input.accounts.oidcClient;
    if (oidcClient) {
      const issuerUrl = stringProperty(oidcClient, "issuer_url", "issuerUrl");
      const clientId = stringProperty(oidcClient, "client_id", "clientId");
      const redirectUris = stringArrayProperty(
        oidcClient,
        "redirect_uris",
        "redirectUris",
      );
      if (issuerUrl) env.OIDC_ISSUER_URL = issuerUrl;
      if (clientId) env.OIDC_CLIENT_ID = clientId;
      if (redirectUris[0]) env.OIDC_REDIRECT_URI = redirectUris[0];
      if (input.accounts.oidcClientSecret) {
        env.OIDC_CLIENT_SECRET = input.accounts.oidcClientSecret;
      }
    }
  }

  if (appHasBindingType(input.app, "install-launch-token@v1")) {
    const launchEnv = launchTokenConfigEnv(input.accounts);
    for (
      const key of [
        ...installLaunchOpaqueEnvKeys,
        ...installLaunchOpaquePassThroughEnvKeys,
      ]
    ) {
      const value = launchEnv[key];
      if (typeof value === "string" && value.length > 0) env[key] = value;
    }
  }

  return env;
}

export function appHasBindingType(
  app: InstallableApp,
  type: InstallableAppBindingType,
): boolean {
  return Object.values(app.bindings).some((binding) => binding.type === type);
}

function isInstallRuntimeResource(resource: Record<string, unknown>): boolean {
  const shape = resource.shape;
  return typeof shape === "string" &&
    (shape.startsWith("web-service@") || shape.startsWith("worker@"));
}

function injectMissingEnv(
  target: Record<string, unknown>,
  values: Record<string, string>,
  path: string,
): void {
  const rawEnv = target.env;
  if (rawEnv !== undefined && !isRecord(rawEnv)) {
    throw new Error(`${path}.env must be an object`);
  }
  const env = rawEnv ?? {};
  for (const [key, value] of Object.entries(values)) {
    if (!hasEnvKey(env, key)) env[key] = value;
  }
  target.env = env;
}
