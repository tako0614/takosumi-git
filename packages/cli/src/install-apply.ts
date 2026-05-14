/**
 * `takosumi-git install` preview and apply orchestration.
 *
 * Loads the app context (with optional Git URL checkout), runs the preview
 * pipeline, applies the AppInstallation against Takosumi Accounts, optionally
 * submits the compiled manifest to the takosumi kernel, and patches the
 * installation status / issues launch tokens. Owns installer placeholder
 * materialization against Accounts-side binding records.
 */

import { dirname, isAbsolute, join } from "@std/path";
import {
  type DeployResponse,
  type ManifestEnvelope,
  parseManifestEnvelope,
  postDeployment,
} from "@takos/takosumi-git-deploy-client";
import type { StepExecutor } from "@takos/takosumi-git-workflow-runner";
import {
  fullCommitPattern,
  type InstallableApp,
  type InstallableAppBinding,
  type InstallableAppBindingType,
  isRecord,
  parseInstallableAppYaml,
} from "./install-parse.ts";
import {
  DEFAULT_APP_PATH,
  type InstallSourceCheckout,
  type InstallSourceCheckoutFactory,
  type InstallSourceCheckoutRequest,
  type ParsedInstallArgs,
} from "./install-args.ts";
import {
  buildInstallPreview,
  digestJson,
  digestText,
  type InstallPreview,
} from "./install-preview.ts";
import {
  assertNoForbiddenKernelManifestFields,
  assertNoInstallerPlaceholders,
  type CompiledInstallManifest,
  compileInstallManifest,
  compileInstallWorkflowRefs,
  installerPlaceholderGlobalPattern,
} from "./install-compile.ts";

export interface InstallOidcClientCreateRequest {
  readonly binding: string;
  readonly namespacePath: string;
  readonly redirectUris: readonly string[];
  readonly allowedScopes: readonly string[];
  readonly subjectMode: "pairwise";
  readonly tokenEndpointAuthMethod?:
    | "client_secret_basic"
    | "client_secret_post"
    | "none";
}

// Required env keys that takosumi-git verifies are present in the Accounts
// launch-token config response. The app at runtime composes `redirect_uri`
// locally from `ACCOUNTS_BASE_URL` + `INSTALL_LAUNCH_CONSUME_PATH` (or its
// own runtime base URL), so `INSTALL_LAUNCH_REDIRECT_URI` is NOT a required
// Accounts-side field — see takosumi-git/docs/reference/binding-catalog.md §6.
const installLaunchOpaqueEnvKeys = [
  "ACCOUNTS_BASE_URL",
  "INSTALL_LAUNCH_INSTALLATION_ID",
  "INSTALL_LAUNCH_CONSUME_PATH",
] as const;

// Optional env keys takosumi-git will pass through if Accounts (or local
// hydration with a runtime base URL) populates them. Apps may also derive
// these at runtime, so absence is not a hard failure.
const installLaunchOpaquePassThroughEnvKeys = [
  "INSTALL_LAUNCH_REDIRECT_URI",
] as const;

async function tryRead(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

interface InstallContext {
  readonly app: InstallableApp;
  readonly preview: InstallPreview;
  readonly compiledManifest?: CompiledInstallManifest;
}

type LoadInstallContextOptions =
  & Pick<
    ParsedInstallArgs,
    | "cwd"
    | "appPath"
    | "appPathSpec"
    | "manifestPath"
    | "manifestPathSpec"
    | "sourceGitUrl"
    | "sourceRef"
  >
  & {
    readonly checkoutSource?: InstallSourceCheckoutFactory;
    readonly compileWorkflows?: boolean;
    readonly executorFactory?: (projectRoot: string) => StepExecutor;
  };

async function loadInstallContext(
  options: LoadInstallContextOptions,
): Promise<InstallContext> {
  const sourceCheckout = await maybeCheckoutInstallSource(options);
  try {
    const repoRoot = sourceCheckout?.root ?? options.cwd ??
      dirname(dirname(options.appPath));
    const appPath = sourceCheckout
      ? join(repoRoot, options.appPathSpec ?? DEFAULT_APP_PATH)
      : options.appPath;
    const appText = await Deno.readTextFile(appPath);
    let app = parseInstallableAppYaml(appText);
    if (sourceCheckout && options.sourceGitUrl && options.sourceRef) {
      app = appWithCheckedOutSource(app, {
        gitUrl: options.sourceGitUrl,
        ref: options.sourceRef,
        commit: sourceCheckout.commit,
      });
    }
    const manifestPath = sourceCheckout
      ? options.manifestPathSpec
        ? join(repoRoot, options.manifestPathSpec)
        : join(repoRoot, app.entry.manifest)
      : options.manifestPath ??
        (isAbsolute(app.entry.manifest)
          ? app.entry.manifest
          : join(repoRoot, app.entry.manifest));
    const manifestText = await tryRead(manifestPath);
    const compiledManifest = manifestText
      ? options.compileWorkflows
        ? await compileInstallWorkflowRefs({
          compiled: compileInstallManifest(app, manifestText, {
            allowInstallerPlaceholders: true,
          }),
          projectRoot: repoRoot,
          workflowsDir: join(repoRoot, ".takosumi", "workflows"),
          executorFactory: options.executorFactory,
        })
        : compileInstallManifest(app, manifestText)
      : undefined;
    const warnings = manifestText
      ? []
      : [`entry manifest not found at ${manifestPath}`];
    return {
      app,
      ...(compiledManifest ? { compiledManifest } : {}),
      preview: buildInstallPreview(app, {
        appManifestDigest: digestText(appText),
        ...(compiledManifest
          ? { compiledManifestDigest: compiledManifest.digest }
          : {}),
        warnings,
      }),
    };
  } finally {
    await sourceCheckout?.cleanup();
  }
}

async function maybeCheckoutInstallSource(
  options: LoadInstallContextOptions,
): Promise<InstallSourceCheckout | undefined> {
  if (!options.sourceGitUrl) return undefined;
  if (!options.sourceRef) {
    throw new Error("Git URL install requires --ref");
  }
  return await (options.checkoutSource ?? checkoutGitSource)({
    gitUrl: options.sourceGitUrl,
    ref: options.sourceRef,
  });
}

function appWithCheckedOutSource(
  app: InstallableApp,
  source: {
    readonly gitUrl: string;
    readonly ref: string;
    readonly commit: string;
  },
): InstallableApp {
  if (normalizeGitUrl(app.source.git) !== normalizeGitUrl(source.gitUrl)) {
    throw new Error(
      `.takosumi/app.yml source.git (${app.source.git}) does not match requested Git URL (${source.gitUrl})`,
    );
  }
  if (app.source.ref !== source.ref) {
    throw new Error(
      `.takosumi/app.yml source.ref (${app.source.ref}) does not match requested ref (${source.ref})`,
    );
  }
  if (app.source.commit && app.source.commit !== source.commit) {
    throw new Error(
      `.takosumi/app.yml source.commit (${app.source.commit}) does not match checked-out commit (${source.commit})`,
    );
  }
  return {
    ...app,
    source: {
      ...app.source,
      commit: source.commit,
    },
  };
}

function normalizeGitUrl(value: string): string {
  return value.replace(/\/+$/, "").replace(/\.git$/, "");
}

async function checkoutGitSource(
  request: InstallSourceCheckoutRequest,
): Promise<InstallSourceCheckout> {
  const root = await Deno.makeTempDir({ prefix: "takosumi-git-install-" });
  try {
    await runGit(["init"], root);
    await runGit(["remote", "add", "origin", request.gitUrl], root);
    await runGit(["fetch", "--depth", "1", "origin", request.ref], root);
    await runGit(["checkout", "--detach", "FETCH_HEAD"], root);
    const commit = (await runGit(["rev-parse", "HEAD"], root)).trim();
    if (!fullCommitPattern.test(commit)) {
      throw new Error(`git resolved invalid commit '${commit}'`);
    }
    return {
      root,
      commit,
      cleanup: () => Deno.remove(root, { recursive: true }),
    };
  } catch (error) {
    await Deno.remove(root, { recursive: true }).catch(() => {});
    throw error;
  }
}

async function runGit(args: readonly string[], cwd: string): Promise<string> {
  const command = new Deno.Command("git", {
    args: args as string[],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const stdout = new TextDecoder().decode(output.stdout);
  if (output.success) return stdout;
  const stderr = new TextDecoder().decode(output.stderr).trim();
  throw new Error(
    `git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`,
  );
}

export async function previewInstall(
  options: ParsedInstallArgs & {
    readonly checkoutSource?: InstallSourceCheckoutFactory;
  },
): Promise<InstallPreview> {
  return (await loadInstallContext(options)).preview;
}

export interface InstallApplyResult {
  readonly preview: InstallPreview;
  readonly request: Record<string, unknown>;
  readonly accounts: AccountsInstallResponseSummary;
  readonly response: {
    readonly status: number;
    readonly body: unknown;
  };
  readonly deployment?: DeployResponse;
  readonly statusTransition?: {
    readonly status: number;
    readonly body: unknown;
  };
  readonly launch?: Record<string, unknown>;
}

export interface AccountsInstallResponseSummary {
  readonly installationId?: string;
  readonly runtimeBinding?: Record<string, unknown>;
  readonly bindings: readonly Record<string, unknown>[];
  readonly oidcClient?: Record<string, unknown>;
  readonly oidcClientSecret?: string;
  readonly bindingEnv?: Record<string, string>;
  readonly launchTokenConfig?: Record<string, unknown>;
}

function appBindingCreateRequests(
  app: InstallableApp,
): Record<string, unknown>[] {
  return Object.entries(app.bindings).map(([name, binding]) => ({
    name,
    kind: binding.type,
    configRef:
      `takosumi-git://installable-app/${app.metadata.id}/bindings/${name}/${
        digestJson(binding)
      }`,
    declaration: binding,
    secretRefs: [],
  })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function installOidcClientCreateRequests(
  app: InstallableApp,
  runtimeBaseUrl: string | undefined,
): InstallOidcClientCreateRequest[] {
  if (!runtimeBaseUrl) return [];
  const namespacePath = "operator.identity.oidc";
  return Object.entries(app.bindings)
    .filter(([, binding]) => binding.type === "identity.oidc@v1")
    .map(([name, binding]) => {
      const redirectPaths = binding.redirectPaths ?? [];
      const tokenEndpointAuthMethod = oidcClientAuthMethodForAccounts(
        binding.tokenEndpointAuthMethod,
      );
      return {
        binding: name,
        namespacePath,
        redirectUris: redirectPaths.map((path) =>
          absoluteUrl(runtimeBaseUrl, path)
        ),
        allowedScopes: binding.allowedScopes ?? ["openid"],
        subjectMode: "pairwise" as const,
        ...(tokenEndpointAuthMethod ? { tokenEndpointAuthMethod } : {}),
      };
    })
    .sort((a, b) => a.binding.localeCompare(b.binding));
}

function oidcClientAuthMethodForAccounts(
  method: InstallableAppBinding["tokenEndpointAuthMethod"],
): InstallOidcClientCreateRequest["tokenEndpointAuthMethod"] | undefined {
  if (
    method === "client_secret_basic" || method === "client_secret_post"
  ) {
    return method;
  }
  if (method === "private_key_jwt") {
    throw new Error(
      "identity.oidc@v1 tokenEndpointAuthMethod private_key_jwt is not supported by Takosumi Accounts install materialization yet",
    );
  }
  return undefined;
}

function installConfirmRequest(
  preview: InstallPreview,
  options: Pick<
    ParsedInstallArgs,
    "confirmPreviewId" | "confirmPermissionDigest" | "costAck"
  >,
): Record<string, unknown> {
  if (
    options.confirmPreviewId &&
    options.confirmPreviewId !== preview.previewId
  ) {
    throw new Error(
      `--preview-id (${options.confirmPreviewId}) does not match current preview (${preview.previewId})`,
    );
  }
  if (
    options.confirmPermissionDigest &&
    options.confirmPermissionDigest !== preview.permissionDigest
  ) {
    throw new Error(
      `--permission-digest (${options.confirmPermissionDigest}) does not match current preview (${preview.permissionDigest})`,
    );
  }
  if (preview.cost.meteredBindingCount > 0 && options.costAck !== true) {
    throw new Error(
      "install apply requires --cost-ack when preview includes metered bindings",
    );
  }
  return {
    previewId: options.confirmPreviewId ?? preview.previewId,
    permissionDigest: options.confirmPermissionDigest ??
      preview.permissionDigest,
    costAck: options.costAck === true,
    approvalRequired: preview.approvalRequired,
    expiresAt: preview.expiresAt,
  };
}

export async function applyInstall(
  options: ParsedInstallArgs & {
    readonly subcommand: "apply";
    readonly accountsUrl: string;
    readonly accountId: string;
    readonly spaceId: string;
    readonly createdBySubject: string;
    readonly checkoutSource?: InstallSourceCheckoutFactory;
    readonly executorFactory?: (projectRoot: string) => StepExecutor;
    readonly fetch?: typeof fetch;
  },
): Promise<InstallApplyResult> {
  const { app, preview, compiledManifest } = await loadInstallContext({
    ...options,
    compileWorkflows: Boolean(options.endpoint),
  });
  const mode = options.mode ?? app.runtime.modes[0];
  if (!app.runtime.modes.includes(mode)) {
    throw new Error(`mode ${mode} is not supported by ${app.metadata.id}`);
  }
  if (
    options.sourceCommit && app.source.commit &&
    options.sourceCommit !== app.source.commit
  ) {
    throw new Error(
      `--source-commit (${options.sourceCommit}) does not match resolved source commit (${app.source.commit})`,
    );
  }
  const sourceCommit = options.sourceCommit ?? app.source.commit ??
    (fullCommitPattern.test(app.source.ref) ? app.source.ref : undefined);
  if (!sourceCommit) {
    throw new Error(
      "source.commit is required for install apply; pin the ref before creating AppInstallation",
    );
  }
  const confirm = installConfirmRequest(preview, options);
  const oidcClients = installOidcClientCreateRequests(
    app,
    options.runtimeBaseUrl,
  );
  const request = {
    accountId: options.accountId,
    spaceId: options.spaceId,
    appId: app.metadata.id,
    source: {
      gitUrl: app.source.git,
      ref: app.source.ref,
      commit: sourceCommit,
      appManifestDigest: preview.source.appManifestDigest,
      ...(preview.source.compiledManifestDigest
        ? { compiledManifestDigest: preview.source.compiledManifestDigest }
        : {}),
    },
    mode,
    createdBySubject: options.createdBySubject,
    confirm,
    ...(oidcClients.length > 0 ? { oidcClients } : {}),
    bindings: appBindingCreateRequests(app),
    grants: app.permissions.requested.map((capability) => ({
      capability,
      scope: {
        type: "single-installation",
        appId: app.metadata.id,
      },
    })),
  };
  const deployEndpoint = options.endpoint;
  const deployToken = options.deployToken;
  if (deployEndpoint && !deployToken) {
    throw new Error(
      "missing --deploy-token (or TAKOSUMI_DEPLOY_TOKEN/TAKOSUMI_TOKEN)",
    );
  }
  if (deployEndpoint) {
    buildInstallDeployRequest(compiledManifest);
  }
  const response = await (options.fetch ?? fetch)(
    `${normalizeBaseUrl(options.accountsUrl)}/v1/installations`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify(request),
    },
  );
  const body = await readResponseBody(response);
  if (response.status >= 400) {
    throw new InstallApplyError(response.status, body);
  }
  let accounts = readAccountsInstallResponse(body);
  let deployment: DeployResponse | undefined;
  let statusTransition:
    | { readonly status: number; readonly body: unknown }
    | undefined;
  let launch: Record<string, unknown> | undefined;
  if (deployEndpoint) {
    if (!deployEndpoint || !deployToken) {
      throw new Error("kernel deploy endpoint and token are required");
    }
    const installationId = accounts.installationId;
    if (!installationId) {
      throw new Error(
        "accounts response missing installation id for deploy status transition",
      );
    }
    const launchTokenConfig = appRequiresLaunchTokenConfig(app)
      ? withResolvedLaunchRedirectUri(
        await fetchLaunchTokenConfig({
          accountsUrl: options.accountsUrl,
          token: options.token,
          installationId,
          fetch: options.fetch,
        }),
        {
          runtimeBaseUrl: options.runtimeBaseUrl,
          postInstallLaunchPath: app.install.postInstallLaunchPath,
          launchReturnTo: options.launchReturnTo,
        },
      )
      : undefined;
    if (launchTokenConfig) {
      accounts = { ...accounts, launchTokenConfig };
    }
    assertRequiredLaunchTokenConfig(app, accounts);
    assertRequiredProviderBindingsMaterialized(app, accounts);
    const deployRequest = buildInstallDeployRequest(
      compiledManifest,
      {
        app,
        accounts,
        accountId: options.accountId,
        spaceId: options.spaceId,
        runtimeBaseUrl: options.runtimeBaseUrl,
      },
    );
    try {
      deployment = await postDeployment({
        endpoint: deployEndpoint,
        token: deployToken,
        fetch: options.fetch,
        idempotencyKey:
          `takosumi-git-install:${app.metadata.id}:${sourceCommit}:${compiledManifest?.digest}`,
      }, deployRequest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      statusTransition = await patchInstallationStatus({
        accountsUrl: options.accountsUrl,
        token: options.token,
        installationId,
        status: "failed",
        reason: `kernel deploy failed: ${message}`,
        fetch: options.fetch,
      });
      throw error;
    }
    statusTransition = await patchInstallationStatus({
      accountsUrl: options.accountsUrl,
      token: options.token,
      installationId,
      status: deployment.status >= 400 ? "failed" : "ready",
      reason: `kernel deploy HTTP ${deployment.status}`,
      fetch: options.fetch,
    });
    if (
      deployment.status < 400 &&
      options.runtimeBaseUrl &&
      appHasBindingType(app, "install-launch-token@v1")
    ) {
      launch = await issueInstallLaunchToken({
        accountsUrl: options.accountsUrl,
        token: options.token,
        installationId,
        redirectUri: launchRedirectUri(
          options.runtimeBaseUrl,
          app.install.postInstallLaunchPath,
          options.launchReturnTo,
        ),
        fetch: options.fetch,
      });
    }
  }
  return {
    preview,
    request,
    accounts,
    response: {
      status: response.status,
      body,
    },
    ...(deployment ? { deployment } : {}),
    ...(statusTransition ? { statusTransition } : {}),
    ...(launch ? { launch } : {}),
  };
}

function launchRedirectUri(
  runtimeBaseUrl: string,
  postInstallLaunchPath: string,
  launchReturnTo?: string,
): string {
  const url = new URL(absoluteUrl(runtimeBaseUrl, postInstallLaunchPath));
  if (launchReturnTo) url.searchParams.set("return_to", launchReturnTo);
  return url.toString();
}

function withResolvedLaunchRedirectUri(
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

async function patchInstallationStatus(input: {
  readonly accountsUrl: string;
  readonly token?: string;
  readonly installationId: string;
  readonly status: "ready" | "failed";
  readonly reason: string;
  readonly fetch?: typeof fetch;
}): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await (input.fetch ?? fetch)(
    `${normalizeBaseUrl(input.accountsUrl)}/v1/installations/${
      encodeURIComponent(input.installationId)
    }/status`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      },
      body: JSON.stringify({
        status: input.status,
        reason: input.reason,
      }),
    },
  );
  const body = await readResponseBody(response);
  if (response.status >= 400) {
    throw new InstallApplyError(response.status, body);
  }
  return { status: response.status, body };
}

async function fetchLaunchTokenConfig(input: {
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

async function issueInstallLaunchToken(input: {
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

function appRequiresLaunchTokenConfig(app: InstallableApp): boolean {
  return Object.values(app.bindings).some((binding) =>
    binding.type === "install-launch-token@v1" && binding.required
  );
}

function assertRequiredLaunchTokenConfig(
  app: InstallableApp,
  accounts: AccountsInstallResponseSummary,
): void {
  const missing: string[] = [];
  for (const [name, binding] of Object.entries(app.bindings)) {
    if (binding.type !== "install-launch-token@v1" || !binding.required) {
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

function assertRequiredProviderBindingsMaterialized(
  app: InstallableApp,
  accounts: AccountsInstallResponseSummary,
): void {
  const accountsBindings = new Map(
    accounts.bindings
      .map((binding) => {
        const name = stringProperty(binding, "name", "name");
        return name ? [name, binding] as const : undefined;
      })
      .filter((entry): entry is readonly [string, Record<string, unknown>] =>
        entry !== undefined
      ),
  );
  const missing: string[] = [];
  for (const [name, binding] of Object.entries(app.bindings)) {
    if (!binding.required || !isProviderBackedBinding(binding.type)) continue;
    const record = accountsBindings.get(name);
    const configRef = record
      ? stringProperty(record, "config_ref", "configRef")
      : undefined;
    if (!configRef || configRef.startsWith("takosumi-git://")) {
      missing.push(`${name}:${binding.type}:configRef`);
    }
    for (const envKey of requiredBindingEnvKeys(binding.type)) {
      if (!hasNonEmptyEnvKey(accounts.bindingEnv ?? {}, envKey)) {
        missing.push(`${name}:${binding.type}:${envKey}`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `required AppBinding materialization is missing: ${missing.join(", ")}`,
    );
  }
}

function isProviderBackedBinding(type: InstallableAppBindingType): boolean {
  return type === "database.postgres@v1" ||
    type === "object-store.s3-compatible@v1" ||
    type === "domain.http@v1" ||
    type === "deploy-intent.gitops@v1";
}

function requiredBindingEnvKeys(
  type: InstallableAppBindingType,
): readonly string[] {
  if (type === "database.postgres@v1") return ["DATABASE_URL"];
  if (type === "object-store.s3-compatible@v1") {
    return [
      "BLOB_ENDPOINT",
      "BLOB_BUCKET",
      "BLOB_ACCESS_KEY",
      "BLOB_SECRET_KEY",
    ];
  }
  if (type === "deploy-intent.gitops@v1") {
    return [
      "DEPLOY_INTENT_DRIVER",
      "DEPLOY_INTENT_REMOTE",
      "DEPLOY_INTENT_TOKEN",
    ];
  }
  return [];
}

function buildInstallDeployRequest(
  compiledManifest: CompiledInstallManifest | undefined,
  materialization?: {
    readonly app: InstallableApp;
    readonly accounts: AccountsInstallResponseSummary;
    readonly accountId?: string;
    readonly spaceId?: string;
    readonly runtimeBaseUrl?: string;
  },
): { readonly mode: "apply"; readonly manifest: ManifestEnvelope } {
  if (!compiledManifest) {
    throw new Error("entry manifest is required for install apply deploy");
  }
  const manifest = structuredClone(compiledManifest.manifest);
  assertNoForbiddenKernelManifestFields(manifest);
  if (materialization) {
    applyAccountsPlaceholders({
      manifest,
      app: materialization.app,
      accounts: materialization.accounts,
      accountId: materialization.accountId,
      spaceId: materialization.spaceId,
      runtimeBaseUrl: materialization.runtimeBaseUrl,
    });
    applyAccountsRuntimeEnv({
      manifest,
      app: materialization.app,
      accounts: materialization.accounts,
      runtimeBaseUrl: materialization.runtimeBaseUrl,
    });
    assertNoInstallerPlaceholders(manifest);
  }
  return {
    mode: "apply",
    manifest: parseManifestEnvelope(manifest),
  };
}

function applyAccountsPlaceholders(input: {
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

function bindingRecordForName(
  accounts: AccountsInstallResponseSummary,
  name: string,
): Record<string, unknown> | undefined {
  return accounts.bindings.find((entry) =>
    stringProperty(entry, "name", "name") === name
  );
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

function applyAccountsRuntimeEnv(input: {
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

function appHasBindingType(
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

function hasEnvKey(env: Record<string, unknown>, key: string): boolean {
  const normalized = key.toUpperCase();
  return Object.keys(env).some((existing) =>
    existing.toUpperCase() === normalized
  );
}

function hasNonEmptyEnvKey(env: Record<string, unknown>, key: string): boolean {
  const normalized = key.toUpperCase();
  return Object.entries(env).some(([existing, value]) =>
    existing.toUpperCase() === normalized &&
    typeof value === "string" &&
    value.length > 0
  );
}

function launchTokenConfigEnv(
  accounts: AccountsInstallResponseSummary,
): Record<string, unknown> {
  const launchConfig = accounts.launchTokenConfig;
  return launchConfig && isRecord(launchConfig.env) ? launchConfig.env : {};
}

export class InstallApplyError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`Takosumi Accounts returned HTTP ${status}`);
    this.name = "InstallApplyError";
  }
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function absoluteUrl(baseUrl: string, path: string): string {
  const base = `${normalizeBaseUrl(baseUrl)}/`;
  return new URL(path.replace(/^\/+/, ""), base).toString();
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function readAccountsInstallResponse(
  body: unknown,
): AccountsInstallResponseSummary {
  const record = isRecord(body) ? body : {};
  const bindings = Array.isArray(record.bindings)
    ? record.bindings.filter(isRecord)
    : [];
  const oidcClient = isRecord(record.oidc_client)
    ? record.oidc_client
    : isRecord(record.oidcClient)
    ? record.oidcClient
    : undefined;
  const oidcClientSecret = stringProperty(
    record,
    "oidc_client_secret",
    "oidcClientSecret",
  );
  const bindingEnv = stringRecordProperty(record, "binding_env", "bindingEnv");
  const launchTokenConfig = isRecord(record.launch_token_config)
    ? record.launch_token_config
    : isRecord(record.launchTokenConfig)
    ? record.launchTokenConfig
    : undefined;
  const runtimeBinding = isRecord(record.runtime_binding)
    ? record.runtime_binding
    : isRecord(record.runtimeBinding)
    ? record.runtimeBinding
    : undefined;
  return {
    ...(readInstallationId(body)
      ? { installationId: readInstallationId(body) }
      : {}),
    ...(runtimeBinding ? { runtimeBinding } : {}),
    bindings,
    ...(oidcClient ? { oidcClient } : {}),
    ...(oidcClientSecret ? { oidcClientSecret } : {}),
    ...(bindingEnv ? { bindingEnv } : {}),
    ...(launchTokenConfig ? { launchTokenConfig } : {}),
  };
}

function readInstallationId(body: unknown): string | undefined {
  const record = isRecord(body) ? body : {};
  const installation = isRecord(record.installation) ? record.installation : {};
  return typeof installation.id === "string"
    ? installation.id
    : typeof installation.installation_id === "string"
    ? installation.installation_id
    : undefined;
}

export function stringProperty(
  record: Record<string, unknown>,
  snakeKey: string,
  camelKey: string,
): string | undefined {
  const value = record[snakeKey] ?? record[camelKey];
  return stringFromUnknown(value);
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberProperty(
  record: Record<string, unknown>,
  snakeKey: string,
  camelKey: string,
): number | undefined {
  const value = record[snakeKey] ?? record[camelKey];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function stringArrayProperty(
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

function stringRecordProperty(
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
