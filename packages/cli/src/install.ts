/**
 * `takosumi-git install` command entry.
 *
 * Dispatches `takosumi-git install [preview|apply]` to the appropriate flow
 * and renders the human / JSON output. Behavior, types, and helpers live in
 * the cooperating `install-*.ts` modules; this file is the command-level
 * install barrel used by the CLI and serve handlers.
 */

import { InstallableAppValidationError } from "./install-parse.ts";
import {
  INSTALL_HELP_TEXT,
  InstallHelpRequested,
  type ParsedInstallArgs,
  parseInstallArgs,
} from "./install-args.ts";
import { type InstallPreview, renderHumanPreview } from "./install-preview.ts";
import {
  applyInstall,
  type InstallApplyResult,
  previewInstall,
  stringProperty,
} from "./install-apply.ts";

export {
  INSTALLABLE_APP_API_VERSION,
  INSTALLABLE_APP_BINDING_TYPES,
  INSTALLABLE_APP_KIND,
  INSTALLABLE_APP_PERMISSIONS,
  INSTALLABLE_APP_RUNTIME_MODES,
  type InstallableApp,
  type InstallableAppBinding,
  type InstallableAppBindingType,
  type InstallableAppPermission,
  type InstallableAppRuntimeMode,
  type InstallableAppUpgradePolicy,
  InstallableAppValidationError,
  type InstallableAppValidationIssue,
  parseInstallableAppObject,
  parseInstallableAppYaml,
} from "./install-parse.ts";

export {
  assertNoForbiddenKernelManifestFields,
  assertNoInstallerPlaceholders,
  type CompiledInstallManifest,
  compileInstallManifest,
} from "./install-compile.ts";

export {
  buildInstallPreview,
  digestText,
  type InstallPreview,
  isPinnedSource,
  type PublisherVerificationRecord,
} from "./install-preview.ts";

export {
  InstallHelpRequested,
  type InstallSourceCheckout,
  type InstallSourceCheckoutFactory,
  type InstallSourceCheckoutRequest,
  type ParsedInstallArgs,
  parseInstallArgs,
} from "./install-args.ts";

export {
  type AccountsInstallResponseSummary,
  applyInstall,
  InstallApplyError,
  type InstallApplyResult,
  type InstallOidcClientCreateRequest,
  previewInstall,
} from "./install-apply.ts";

export async function runInstallCli(args: readonly string[]): Promise<number> {
  let parsed: ParsedInstallArgs;
  try {
    parsed = parseInstallArgs(args);
  } catch (error) {
    if (error instanceof InstallHelpRequested) {
      Deno.stdout.writeSync(new TextEncoder().encode(INSTALL_HELP_TEXT));
      return 0;
    }
    Deno.stderr.writeSync(
      new TextEncoder().encode(
        `takosumi-git install: ${(error as Error).message}\n`,
      ),
    );
    return 64;
  }

  try {
    const result = parsed.subcommand === "apply"
      ? await applyInstall(
        parsed as ParsedInstallArgs & {
          readonly subcommand: "apply";
          readonly accountsUrl: string;
          readonly accountId: string;
          readonly spaceId: string;
          readonly createdBySubject: string;
        },
      )
      : await previewInstall(parsed);
    const text = parsed.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : parsed.subcommand === "apply"
      ? renderApplyResult(result as InstallApplyResult)
      : renderHumanPreview(result as InstallPreview);
    Deno.stdout.writeSync(new TextEncoder().encode(text));
    if (parsed.subcommand === "apply") {
      const deployment = (result as InstallApplyResult).deployment;
      if (deployment && deployment.status >= 400) return 1;
    }
    return 0;
  } catch (error) {
    Deno.stderr.writeSync(
      new TextEncoder().encode(
        `takosumi-git install: ${(error as Error).message}\n`,
      ),
    );
    return error instanceof InstallableAppValidationError ? 64 : 1;
  }
}

function renderApplyResult(result: InstallApplyResult): string {
  const installationId = result.accounts.installationId ?? "(unknown)";
  const runtimeBinding = renderRuntimeBindingSummary(
    result.accounts.runtimeBinding,
  );
  const launchUrl = result.launch
    ? stringProperty(result.launch, "url", "url")
    : undefined;
  return [
    "takosumi-git install apply",
    `app: ${result.preview.app.name} (${result.preview.app.id})`,
    `installation: ${installationId}`,
    ...(runtimeBinding ? [`runtime: ${runtimeBinding}`] : []),
    ...(launchUrl ? [`launch: ${launchUrl}`] : []),
    `accounts response: HTTP ${result.response.status}`,
    ...(result.deployment
      ? [`kernel response: HTTP ${result.deployment.status}`]
      : []),
    ...(result.statusTransition
      ? [`status response: HTTP ${result.statusTransition.status}`]
      : []),
    "",
  ].join("\n");
}

function renderRuntimeBindingSummary(
  runtimeBinding: Record<string, unknown> | undefined,
): string | undefined {
  if (!runtimeBinding) return undefined;
  const targetType = stringProperty(
    runtimeBinding,
    "target_type",
    "targetType",
  );
  const targetId = stringProperty(runtimeBinding, "target_id", "targetId");
  if (!targetType && !targetId) return undefined;
  return [targetType, targetId].filter(Boolean).join(" ");
}
