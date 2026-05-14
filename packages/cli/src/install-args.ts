/**
 * `takosumi-git install` CLI argument parsing.
 *
 * Translates raw `argv` plus environment variables into a `ParsedInstallArgs`
 * record consumed by preview/apply flows, validates flag combinations, and
 * surfaces the help text. Has no I/O beyond reading the provided env.
 */

import { parseArgs } from "@std/cli/parse-args";
import { isAbsolute, join, resolve } from "@std/path";
import {
  fullCommitPattern,
  INSTALLABLE_APP_RUNTIME_MODES,
  type InstallableAppRuntimeMode,
  type InstallableAppValidationIssue,
  pathPattern,
  validateSourceRef,
} from "./install-parse.ts";

export const DEFAULT_APP_PATH = ".takosumi/app.yml";

export interface ParsedInstallArgs {
  readonly subcommand: "preview" | "apply";
  readonly cwd: string;
  readonly appPath: string;
  readonly appPathSpec?: string;
  readonly manifestPath?: string;
  readonly manifestPathSpec?: string;
  readonly json: boolean;
  readonly sourceGitUrl?: string;
  readonly sourceRef?: string;
  readonly accountsUrl?: string;
  readonly token?: string;
  readonly accountId?: string;
  readonly spaceId?: string;
  readonly createdBySubject?: string;
  readonly mode?: InstallableAppRuntimeMode;
  readonly sourceCommit?: string;
  readonly runtimeBaseUrl?: string;
  readonly launchReturnTo?: string;
  readonly confirmPreviewId?: string;
  readonly confirmPermissionDigest?: `sha256:${string}`;
  readonly costAck?: boolean;
  readonly endpoint?: string;
  readonly deployToken?: string;
}

export interface InstallSourceCheckout {
  readonly root: string;
  readonly commit: string;
  cleanup(): Promise<void>;
}

export interface InstallSourceCheckoutRequest {
  readonly gitUrl: string;
  readonly ref: string;
}

export type InstallSourceCheckoutFactory = (
  request: InstallSourceCheckoutRequest,
) => Promise<InstallSourceCheckout>;

export function parseInstallArgs(
  args: readonly string[],
  env: { get(key: string): string | undefined } = Deno.env,
): ParsedInstallArgs {
  const [first, ...tail] = args;
  if (
    !first || first === "help" || first === "-h" ||
    first === "--help"
  ) {
    throw new InstallHelpRequested();
  }
  const hasExplicitSubcommand = first === "preview" || first === "apply";
  const subcommand = hasExplicitSubcommand ? first : "apply";
  const rest = hasExplicitSubcommand ? tail : args;
  if (subcommand !== "preview" && subcommand !== "apply") {
    throw new Error(`unknown install command '${subcommand}'`);
  }
  rejectRemovedServiceResolverOptions(rest);
  const flags = parseArgs(rest as string[], {
    string: [
      "cwd",
      "app",
      "manifest",
      "git-url",
      "ref",
      "accounts-url",
      "token",
      "account-id",
      "space",
      "space-id",
      "subject",
      "mode",
      "source-commit",
      "runtime-base-url",
      "launch-return-to",
      "preview-id",
      "permission-digest",
      "endpoint",
      "deploy-token",
    ],
    boolean: ["json", "cost-ack"],
    default: {
      cwd: ".",
      app: DEFAULT_APP_PATH,
      json: false,
      "cost-ack": false,
    },
  });
  const positional = (flags._ ?? []).map((value) => String(value));
  if (positional.length > 1) {
    throw new Error("install accepts at most one Git URL argument");
  }
  if (positional.length === 1 && typeof flags["git-url"] === "string") {
    throw new Error("pass either <git-url> or --git-url, not both");
  }
  const sourceGitUrl = (flags["git-url"] as string | undefined) ??
    positional[0];
  const sourceRef = (flags.ref as string | undefined) ??
    (sourceGitUrl ? env.get("TAKOSUMI_INSTALL_REF") : undefined);
  const cwd = resolve(flags.cwd as string);
  const app = flags.app as string;
  const manifest = flags.manifest as string | undefined;
  const mode = flags.mode === undefined
    ? undefined
    : parseRuntimeMode(flags.mode);
  const accountsUrl = (flags["accounts-url"] as string | undefined) ??
    env.get("TAKOSUMI_ACCOUNTS_URL");
  const token = (flags.token as string | undefined) ??
    env.get("TAKOSUMI_ACCOUNTS_TOKEN") ?? env.get("TAKOS_TOKEN");
  const accountId = (flags["account-id"] as string | undefined) ??
    env.get("TAKOS_ACCOUNT_ID");
  const spaceId = (flags["space-id"] as string | undefined) ??
    (flags.space as string | undefined) ?? env.get("TAKOS_SPACE_ID");
  const createdBySubject = (flags.subject as string | undefined) ??
    env.get("TAKOSUMI_SUBJECT") ?? env.get("TAKOS_SUBJECT");
  const sourceCommit = (flags["source-commit"] as string | undefined) ??
    env.get("TAKOSUMI_SOURCE_COMMIT");
  const runtimeBaseUrl = parseRuntimeBaseUrl(
    (flags["runtime-base-url"] as string | undefined) ??
      env.get("TAKOSUMI_RUNTIME_BASE_URL"),
  );
  const launchReturnTo = parseLaunchReturnTo(
    (flags["launch-return-to"] as string | undefined) ??
      env.get("TAKOSUMI_INSTALL_LAUNCH_RETURN_TO"),
  );
  const confirmPreviewId = flags["preview-id"] as string | undefined;
  const confirmPermissionDigest = flags["permission-digest"] as
    | string
    | undefined;
  const endpoint = (flags.endpoint as string | undefined) ??
    env.get("TAKOSUMI_ENDPOINT");
  const deployToken = endpoint
    ? (flags["deploy-token"] as string | undefined) ??
      env.get("TAKOSUMI_DEPLOY_TOKEN") ?? env.get("TAKOSUMI_TOKEN")
    : (flags["deploy-token"] as string | undefined);
  if (sourceCommit && !fullCommitPattern.test(sourceCommit)) {
    throw new Error("--source-commit must be a 40-char SHA");
  }
  if (confirmPreviewId && !/^preview_[0-9a-f]{24}$/.test(confirmPreviewId)) {
    throw new Error("--preview-id must be preview_<24-hex>");
  }
  if (
    confirmPermissionDigest &&
    !/^sha256:[0-9a-f]{64}$/.test(confirmPermissionDigest)
  ) {
    throw new Error("--permission-digest must be sha256:<64-hex>");
  }
  if (sourceGitUrl) {
    validateInstallGitUrl(sourceGitUrl);
    if (!sourceRef) {
      throw new Error(
        "Git URL install requires --ref (or TAKOSUMI_INSTALL_REF)",
      );
    }
    validateInstallSourceRef(sourceRef);
    validateGitInstallPathOption("--app", app);
    if (manifest) validateGitInstallPathOption("--manifest", manifest);
  } else if (sourceRef) {
    throw new Error("--ref requires a Git URL source");
  }
  if (subcommand === "apply") {
    if (!accountsUrl) {
      throw new Error("missing --accounts-url (or TAKOSUMI_ACCOUNTS_URL)");
    }
    if (!accountId) {
      throw new Error("missing --account-id (or TAKOS_ACCOUNT_ID)");
    }
    if (!spaceId) {
      throw new Error("missing --space-id/--space (or TAKOS_SPACE_ID)");
    }
    if (!createdBySubject) {
      throw new Error("missing --subject (or TAKOSUMI_SUBJECT/TAKOS_SUBJECT)");
    }
    if (endpoint && !deployToken) {
      throw new Error(
        "missing --deploy-token (or TAKOSUMI_DEPLOY_TOKEN/TAKOSUMI_TOKEN)",
      );
    }
    if (deployToken && !endpoint) {
      throw new Error("missing --endpoint (or TAKOSUMI_ENDPOINT)");
    }
  }
  return {
    subcommand,
    cwd,
    appPathSpec: app,
    appPath: isAbsolute(app) ? app : join(cwd, app),
    ...(manifest ? { manifestPathSpec: manifest } : {}),
    manifestPath: typeof manifest === "string"
      ? isAbsolute(manifest) ? manifest : join(cwd, manifest)
      : undefined,
    json: Boolean(flags.json),
    ...(sourceGitUrl ? { sourceGitUrl } : {}),
    ...(sourceRef ? { sourceRef } : {}),
    ...(accountsUrl ? { accountsUrl } : {}),
    ...(token ? { token } : {}),
    ...(accountId ? { accountId } : {}),
    ...(spaceId ? { spaceId } : {}),
    ...(createdBySubject ? { createdBySubject } : {}),
    ...(mode ? { mode } : {}),
    ...(sourceCommit ? { sourceCommit } : {}),
    ...(runtimeBaseUrl ? { runtimeBaseUrl } : {}),
    ...(launchReturnTo ? { launchReturnTo } : {}),
    ...(confirmPreviewId ? { confirmPreviewId } : {}),
    ...(confirmPermissionDigest
      ? {
        confirmPermissionDigest: confirmPermissionDigest as `sha256:${string}`,
      }
      : {}),
    costAck: Boolean(flags["cost-ack"]),
    ...(endpoint ? { endpoint } : {}),
    ...(deployToken ? { deployToken } : {}),
  };
}

function rejectRemovedServiceResolverOptions(args: readonly string[]): void {
  if (
    args.some((arg) =>
      arg === "--service-resolver-url" ||
      arg.startsWith("--service-resolver-url=") ||
      arg === "--service-resolver-public-key" ||
      arg.startsWith("--service-resolver-public-key=")
    )
  ) {
    throw new Error(
      "service resolver options were removed; manifests must not declare service imports or serviceResolvers",
    );
  }
}

function parseRuntimeMode(value: unknown): InstallableAppRuntimeMode {
  if (
    typeof value === "string" &&
    INSTALLABLE_APP_RUNTIME_MODES.includes(value as InstallableAppRuntimeMode)
  ) {
    return value as InstallableAppRuntimeMode;
  }
  throw new Error(
    `--mode must be one of ${INSTALLABLE_APP_RUNTIME_MODES.join("|")}`,
  );
}

function validateInstallGitUrl(value: string): void {
  if (!value.startsWith("https://") && !/^git@[^:]+:.+/.test(value)) {
    throw new Error("Git URL must be an https URL or git@host:path URL");
  }
}

function validateInstallSourceRef(value: string): void {
  const issues: InstallableAppValidationIssue[] = [];
  validateSourceRef(value, issues);
  if (issues.length > 0) {
    throw new Error(`--ref ${issues.map((issue) => issue.message).join("; ")}`);
  }
}

function validateGitInstallPathOption(flag: string, value: string): void {
  if (isAbsolute(value) || value.split("/").includes("..")) {
    throw new Error(
      `${flag} must be repo-relative without .. when installing from Git URL`,
    );
  }
}

function parseRuntimeBaseUrl(value: string | undefined): string | undefined {
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
      "--runtime-base-url must be an https URL or localhost http URL",
    );
  }
}

function parseLaunchReturnTo(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!pathPattern.test(value)) {
    throw new Error(
      "--launch-return-to must be a slash-prefixed path without query",
    );
  }
  return value;
}

export class InstallHelpRequested extends Error {
  constructor() {
    super("help requested");
    this.name = "InstallHelpRequested";
  }
}

export const INSTALL_HELP_TEXT = `takosumi-git install

USAGE:
  takosumi-git install [<git-url>] [options]
  takosumi-git install preview [<git-url>] [options]
  takosumi-git install apply [<git-url>] [options]

DEFAULT ACTION:
  Without an explicit subcommand, install behaves like \`install apply\`.

PREVIEW OPTIONS:
  --cwd <dir>        project root (default .)
  --app <path>       InstallableApp YAML (default .takosumi/app.yml)
  --manifest <path>  kernel manifest path override
  --git-url <url>    Git source URL (or positional <git-url>)
  --ref <ref>        immutable tag/ref/full SHA for Git URL install
  --json             print preview JSON

APPLY OPTIONS:
  --accounts-url <url>  Takosumi Accounts URL (or TAKOSUMI_ACCOUNTS_URL)
  --token <token>       bearer token (or TAKOSUMI_ACCOUNTS_TOKEN/TAKOS_TOKEN)
  --account-id <id>     ledger account id (or TAKOS_ACCOUNT_ID)
  --space-id <id>       target space id (or --space / TAKOS_SPACE_ID)
  --subject <tsub_...>  installer subject (or TAKOSUMI_SUBJECT/TAKOS_SUBJECT)
  --mode <mode>         shared-cell | dedicated | self-hosted (default: first runtime.modes entry)
  --source-commit <sha> resolved 40-char source commit pin
  --runtime-base-url <url>
                        app runtime base URL for OIDC redirect materialization
  --launch-return-to <path>
                        app path to open after launch token session creation
  --preview-id <id>     preview id being approved; must match recomputed preview
  --permission-digest <sha256:...>
                        permission digest being approved; must match recomputed preview
  --cost-ack            acknowledge provider-specific metered binding cost
  --endpoint <url>      takosumi kernel endpoint for deploy (or TAKOSUMI_ENDPOINT)
  --deploy-token <tok>  kernel deploy token (or TAKOSUMI_DEPLOY_TOKEN/TAKOSUMI_TOKEN)
`;
