/**
 * HTTP handlers for the install / revision API surface of
 * `takosumi-git serve`.
 *
 * `createServeHandler` in `serve.ts` dispatches POST routes here once
 * rate-limit and (where required) bearer auth pass.
 */

import {
  applyInstall,
  buildInstallPreview,
  compileInstallManifest,
  digestText,
  InstallableAppValidationError,
  InstallApplyError,
  type InstallSourceCheckoutFactory,
  parseInstallableAppObject,
  parseInstallableAppYaml,
  previewInstall,
} from "./install.ts";
import { runRevision } from "./revision.ts";
import { isRecord } from "./webhook_signature.ts";
import {
  jsonResponse as json,
  optionalBodyBoolean,
  optionalBodyString,
  parseOptionalBodyMode,
  parseOptionalRuntimeBaseUrl,
  parseOptionalSourceCommit,
  pathFromSpec,
} from "./serve_helpers.ts";

export interface InstallApplyHandlerOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly accountsUrl?: string;
  readonly accountsToken?: string;
  readonly accountId?: string;
  readonly spaceId?: string;
  readonly subject?: string;
  readonly runtimeBaseUrl?: string;
  readonly deployToken?: string;
  readonly installPreviewCheckoutSource?: InstallSourceCheckoutFactory;
  readonly installApplyFetch?: typeof fetch;
}

export async function handleInstallPreviewRequest(
  request: Request,
  checkoutSource?: InstallSourceCheckoutFactory,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!isRecord(body)) return json({ error: "invalid_json" }, 400);

  try {
    const gitUrl = optionalBodyString(body, "gitUrl", "git_url");
    if (gitUrl) {
      const ref = optionalBodyString(body, "ref");
      if (!ref) {
        return json({
          error: "invalid_install_preview_request",
          message: "gitUrl and ref are required",
        }, 400);
      }
      const appPath = optionalBodyString(body, "appPath", "app_path") ??
        ".takosumi/app.yml";
      const manifestPath = optionalBodyString(
        body,
        "manifestPath",
        "manifest_path",
      );
      const preview = await previewInstall({
        subcommand: "preview",
        cwd: Deno.cwd(),
        appPath,
        appPathSpec: appPath,
        ...(manifestPath
          ? { manifestPath, manifestPathSpec: manifestPath }
          : {}),
        json: true,
        sourceGitUrl: gitUrl,
        sourceRef: ref,
        ...(checkoutSource ? { checkoutSource } : {}),
      });
      return json(preview, 200);
    }

    const appYaml = typeof body.appYml === "string"
      ? body.appYml
      : typeof body.app_yml === "string"
      ? body.app_yml
      : undefined;
    const app = appYaml
      ? parseInstallableAppYaml(appYaml)
      : parseInstallableAppObject(body.app);
    const manifestYaml = typeof body.manifestYml === "string"
      ? body.manifestYml
      : typeof body.manifest_yml === "string"
      ? body.manifest_yml
      : undefined;
    const preview = buildInstallPreview(app, {
      ...(appYaml ? { appManifestDigest: digestText(appYaml) } : {}),
      ...(manifestYaml
        ? {
          compiledManifestDigest: compileInstallManifest(app, manifestYaml)
            .digest,
        }
        : {}),
    });
    return json(preview, 200);
  } catch (error) {
    if (error instanceof InstallableAppValidationError) {
      return json({
        error: "invalid_installable_app",
        issues: error.issues,
      }, 400);
    }
    return json({ error: "invalid_install_preview_request" }, 400);
  }
}

export async function handleInstallApplyRequest(
  request: Request,
  options: InstallApplyHandlerOptions,
): Promise<Response> {
  if (!options.accountsUrl || !options.accountsToken) {
    return json({
      error: "install_apply_not_configured",
      message:
        "configure --accounts-url and --accounts-token before using /v1/install/apply",
    }, 503);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!isRecord(body)) return json({ error: "invalid_json" }, 400);

  try {
    const gitUrl = optionalBodyString(body, "gitUrl", "git_url");
    const ref = optionalBodyString(body, "ref");
    if (!gitUrl || !ref) {
      return json({
        error: "invalid_install_apply_request",
        message: "gitUrl and ref are required",
      }, 400);
    }
    const accountId = optionalBodyString(body, "accountId", "account_id") ??
      options.accountId;
    const spaceId = optionalBodyString(body, "spaceId", "space_id") ??
      optionalBodyString(body, "space") ?? options.spaceId;
    const subject = optionalBodyString(body, "subject") ?? options.subject;
    if (!accountId || !spaceId || !subject) {
      return json({
        error: "invalid_install_apply_request",
        message: "accountId, spaceId, and subject are required",
      }, 400);
    }

    const cwd = Deno.cwd();
    const appPathSpec = optionalBodyString(body, "appPath", "app_path") ??
      ".takosumi/app.yml";
    const manifestPathSpec = optionalBodyString(
      body,
      "manifestPath",
      "manifest_path",
    );
    const mode = parseOptionalBodyMode(body);
    const sourceCommit = parseOptionalSourceCommit(
      optionalBodyString(body, "sourceCommit", "source_commit"),
    );
    const runtimeBaseUrl = parseOptionalRuntimeBaseUrl(
      optionalBodyString(body, "runtimeBaseUrl", "runtime_base_url") ??
        options.runtimeBaseUrl,
    );
    const confirmPreviewId = optionalBodyString(
      body,
      "previewId",
      "preview_id",
    );
    const confirmPermissionDigest = optionalBodyString(
      body,
      "permissionDigest",
      "permission_digest",
    );
    const costAck = optionalBodyBoolean(body, "costAck", "cost_ack");

    const result = await applyInstall({
      subcommand: "apply",
      cwd,
      appPathSpec,
      appPath: pathFromSpec(cwd, appPathSpec),
      ...(manifestPathSpec
        ? {
          manifestPathSpec,
          manifestPath: pathFromSpec(cwd, manifestPathSpec),
        }
        : {}),
      json: true,
      sourceGitUrl: gitUrl,
      sourceRef: ref,
      accountsUrl: options.accountsUrl,
      token: options.accountsToken,
      accountId,
      spaceId,
      createdBySubject: subject,
      ...(mode ? { mode } : {}),
      ...(sourceCommit ? { sourceCommit } : {}),
      ...(runtimeBaseUrl ? { runtimeBaseUrl } : {}),
      ...(confirmPreviewId ? { confirmPreviewId } : {}),
      ...(confirmPermissionDigest
        ? {
          confirmPermissionDigest:
            confirmPermissionDigest as `sha256:${string}`,
        }
        : {}),
      ...(costAck !== undefined ? { costAck } : {}),
      endpoint: options.endpoint,
      deployToken: options.deployToken ?? options.token,
      ...(options.installPreviewCheckoutSource
        ? { checkoutSource: options.installPreviewCheckoutSource }
        : {}),
      ...(options.installApplyFetch
        ? { fetch: options.installApplyFetch }
        : {}),
    });
    return json({
      ok: true,
      kind: "takosumi-git.install-apply@v1",
      ...result,
    }, 202);
  } catch (error) {
    if (error instanceof InstallableAppValidationError) {
      return json({
        error: "invalid_installable_app",
        issues: error.issues,
      }, 400);
    }
    if (error instanceof InstallApplyError) {
      return json({
        error: "install_apply_failed",
        status: error.status,
        body: error.body,
      }, 502);
    }
    return json({
      error: "invalid_install_apply_request",
      message: error instanceof Error ? error.message : String(error),
    }, 400);
  }
}

export async function handleInstallRevisionRequest(
  request: Request,
  options: InstallApplyHandlerOptions,
  apply: boolean,
): Promise<Response> {
  if (!options.accountsUrl || !options.accountsToken) {
    return json({
      error: "install_revision_not_configured",
      message:
        "configure --accounts-url and --accounts-token before using /v1/install/revision/*",
    }, 503);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!isRecord(body)) return json({ error: "invalid_json" }, 400);

  try {
    const operation = parseRevisionOperation(
      optionalBodyString(body, "operation"),
    );
    const installationId = optionalBodyString(
      body,
      "installationId",
      "installation_id",
    );
    const targetRef = operation === "upgrade"
      ? optionalBodyString(body, "ref")
      : optionalBodyString(body, "to") ?? optionalBodyString(body, "ref");
    if (!installationId || !targetRef) {
      return json({
        error: "invalid_install_revision_request",
        message: operation === "upgrade"
          ? "installationId and ref are required"
          : "installationId and to are required",
      }, 400);
    }

    const cwd = Deno.cwd();
    const appPathSpec = optionalBodyString(body, "appPath", "app_path") ??
      ".takosumi/app.yml";
    const manifestPathSpec = optionalBodyString(
      body,
      "manifestPath",
      "manifest_path",
    );
    const gitUrl = optionalBodyString(body, "gitUrl", "git_url");
    const sourceCommit = parseOptionalSourceCommit(
      optionalBodyString(body, "sourceCommit", "source_commit"),
    );
    const reason = optionalBodyString(body, "reason");

    const result = await runRevision({
      operation,
      installationId,
      targetRef,
      cwd,
      appPathSpec,
      appPath: pathFromSpec(cwd, appPathSpec),
      ...(manifestPathSpec
        ? {
          manifestPathSpec,
          manifestPath: pathFromSpec(cwd, manifestPathSpec),
        }
        : {}),
      accountsUrl: options.accountsUrl,
      token: options.accountsToken,
      ...(gitUrl ? { sourceGitUrl: gitUrl } : {}),
      ...(sourceCommit ? { sourceCommit } : {}),
      ...(reason ? { reason } : {}),
      apply,
      json: true,
      ...(options.installPreviewCheckoutSource
        ? { checkoutSource: options.installPreviewCheckoutSource }
        : {}),
      ...(options.installApplyFetch
        ? { fetch: options.installApplyFetch }
        : {}),
    });

    return json({
      ok: true,
      kind: apply
        ? "takosumi-git.install-revision-apply@v1"
        : "takosumi-git.install-revision-preview@v1",
      ...result,
    }, apply ? 202 : 200);
  } catch (error) {
    if (error instanceof InstallableAppValidationError) {
      return json({
        error: "invalid_installable_app",
        issues: error.issues,
      }, 400);
    }
    if (error instanceof Error && error.name === "RevisionApplyError") {
      const upstream = error as Error & {
        readonly status?: unknown;
        readonly body?: unknown;
      };
      return json({
        error: "install_revision_failed",
        status: typeof upstream.status === "number"
          ? upstream.status
          : undefined,
        body: upstream.body,
      }, 502);
    }
    return json({
      error: "invalid_install_revision_request",
      message: error instanceof Error ? error.message : String(error),
    }, 400);
  }
}

function parseRevisionOperation(
  value: string | undefined,
): "upgrade" | "rollback" {
  if (value === "upgrade" || value === "rollback") return value;
  throw new Error("operation must be upgrade or rollback");
}
