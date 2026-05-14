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
} from "./install-compile.ts";
import {
  type AccountsInstallResponseSummary,
  InstallApplyError,
} from "./install-apply-types.ts";
import {
  absoluteUrl,
  hasNonEmptyEnvKey,
  isProviderBackedBinding,
  normalizeBaseUrl,
  readResponseBody,
  stringProperty,
  stringRecordProperty,
} from "./install-apply-helpers.ts";
import {
  appRequiresLaunchTokenConfig,
  assertRequiredLaunchTokenConfig,
  fetchLaunchTokenConfig,
  issueInstallLaunchToken,
  launchRedirectUri,
  withResolvedLaunchRedirectUri,
} from "./install-launch-token.ts";
import {
  appHasBindingType,
  applyAccountsPlaceholders,
  applyAccountsRuntimeEnv,
} from "./install-placeholders.ts";

export {
  type AccountsInstallResponseSummary,
  InstallApplyError,
} from "./install-apply-types.ts";
export { stringProperty } from "./install-apply-helpers.ts";

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
