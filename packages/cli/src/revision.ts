import { parseArgs } from "@std/cli/parse-args";
import { isAbsolute, join, resolve } from "@std/path";
import {
  type InstallPreview,
  type InstallSourceCheckoutFactory,
  previewInstall,
} from "./install.ts";

type RevisionOperation = "upgrade" | "rollback";

export interface ParsedRevisionArgs {
  readonly operation: RevisionOperation;
  readonly installationId: string;
  readonly targetRef: string;
  readonly cwd: string;
  readonly appPath: string;
  readonly appPathSpec: string;
  readonly manifestPath?: string;
  readonly manifestPathSpec?: string;
  readonly accountsUrl: string;
  readonly token?: string;
  readonly sourceGitUrl?: string;
  readonly sourceCommit?: string;
  readonly reason?: string;
  readonly apply: boolean;
  readonly json: boolean;
}

interface AccountsInstallationEnvelope {
  readonly installation: {
    readonly id: string;
    readonly app_id: string;
    readonly source: {
      readonly url: string;
      readonly ref: string;
      readonly commit: string;
    };
    readonly app_manifest_digest?: string | null;
    readonly compiled_manifest_digest?: string | null;
    readonly service_imports?: readonly unknown[];
    readonly status: string;
  };
  readonly bindings?: readonly {
    readonly name?: string;
    readonly kind?: string;
  }[];
  readonly grants?: readonly {
    readonly capability?: string;
    readonly revoked_at?: string | null;
  }[];
}

export interface RevisionPreview {
  readonly kind: "takosumi-git.install-revision-preview@v1";
  readonly operation: RevisionOperation;
  readonly installationId: string;
  readonly current: {
    readonly appId: string;
    readonly source: AccountsInstallationEnvelope["installation"]["source"];
    readonly appManifestDigest?: string | null;
    readonly compiledManifestDigest?: string | null;
    readonly status: string;
  };
  readonly next: {
    readonly appId: string;
    readonly source: {
      readonly git: string;
      readonly ref: string;
      readonly commit: string;
      readonly appManifestDigest?: string;
      readonly compiledManifestDigest?: string;
    };
    readonly serviceImports: InstallPreview["serviceImports"];
  };
  readonly diff: {
    readonly manifest: {
      readonly changed: boolean;
      readonly from?: string | null;
      readonly to?: string;
    };
    readonly permissions: {
      readonly added: readonly string[];
      readonly removed: readonly string[];
      readonly unchanged: readonly string[];
    };
    readonly bindings: {
      readonly added: readonly string[];
      readonly removed: readonly string[];
      readonly unchanged: readonly string[];
    };
  };
  readonly migrationPlan: {
    readonly status: "not-required" | "review-required" | "not-computed";
    readonly notes: readonly string[];
  };
}

export interface RevisionResult {
  readonly preview: RevisionPreview;
  readonly request?: Record<string, unknown>;
  readonly response?: {
    readonly status: number;
    readonly body: unknown;
  };
}

const DEFAULT_APP_PATH = ".takosumi/app.yml";
const fullCommitPattern = /^[0-9a-f]{40}$/;

export async function runUpgradeCli(args: readonly string[]): Promise<number> {
  return await runRevisionCli("upgrade", args);
}

export async function runRollbackCli(args: readonly string[]): Promise<number> {
  return await runRevisionCli("rollback", args);
}

async function runRevisionCli(
  operation: RevisionOperation,
  args: readonly string[],
): Promise<number> {
  let parsed: ParsedRevisionArgs;
  try {
    parsed = parseRevisionArgs(operation, args);
  } catch (error) {
    if (error instanceof RevisionHelpRequested) {
      Deno.stdout.writeSync(
        new TextEncoder().encode(revisionHelpText(operation)),
      );
      return 0;
    }
    Deno.stderr.writeSync(
      new TextEncoder().encode(
        `takosumi-git ${operation}: ${(error as Error).message}\n`,
      ),
    );
    return 64;
  }

  try {
    const result = await runRevision(parsed);
    const text = parsed.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : renderRevisionResult(result);
    Deno.stdout.writeSync(new TextEncoder().encode(text));
    if (result.response && result.response.status >= 400) return 1;
    return 0;
  } catch (error) {
    Deno.stderr.writeSync(
      new TextEncoder().encode(
        `takosumi-git ${operation}: ${(error as Error).message}\n`,
      ),
    );
    return 1;
  }
}

export function parseRevisionArgs(
  operation: RevisionOperation,
  args: readonly string[],
  env: { get(key: string): string | undefined } = Deno.env,
): ParsedRevisionArgs {
  const [first] = args;
  if (!first || first === "help" || first === "-h" || first === "--help") {
    throw new RevisionHelpRequested();
  }
  const flags = parseArgs(args as string[], {
    string: [
      "ref",
      "to",
      "cwd",
      "app",
      "manifest",
      "git-url",
      "accounts-url",
      "token",
      "source-commit",
      "reason",
    ],
    boolean: ["apply", "json"],
    default: {
      cwd: ".",
      app: DEFAULT_APP_PATH,
      apply: false,
      json: false,
    },
  });
  const positional = (flags._ ?? []).map((value) => String(value));
  if (positional.length !== 1) {
    throw new Error(`${operation} requires exactly one installation id`);
  }
  const targetRef = operation === "upgrade"
    ? flags.ref as string | undefined
    : (flags.to as string | undefined) ?? flags.ref as string | undefined;
  if (!targetRef) {
    throw new Error(
      operation === "upgrade" ? "missing --ref" : "missing --to",
    );
  }
  const sourceCommit = (flags["source-commit"] as string | undefined) ??
    env.get("TAKOSUMI_SOURCE_COMMIT");
  if (sourceCommit && !fullCommitPattern.test(sourceCommit)) {
    throw new Error("--source-commit must be a 40-char SHA");
  }
  const accountsUrl = (flags["accounts-url"] as string | undefined) ??
    env.get("TAKOSUMI_ACCOUNTS_URL");
  if (!accountsUrl) {
    throw new Error("missing --accounts-url (or TAKOSUMI_ACCOUNTS_URL)");
  }
  const token = (flags.token as string | undefined) ??
    env.get("TAKOSUMI_ACCOUNTS_TOKEN") ?? env.get("TAKOS_TOKEN");
  const cwd = resolve(flags.cwd as string);
  const app = flags.app as string;
  const manifest = flags.manifest as string | undefined;
  return {
    operation,
    installationId: positional[0],
    targetRef,
    cwd,
    appPathSpec: app,
    appPath: isAbsolute(app) ? app : join(cwd, app),
    ...(manifest ? { manifestPathSpec: manifest } : {}),
    ...(manifest
      ? { manifestPath: isAbsolute(manifest) ? manifest : join(cwd, manifest) }
      : {}),
    accountsUrl,
    ...(token ? { token } : {}),
    ...(flags["git-url"] ? { sourceGitUrl: String(flags["git-url"]) } : {}),
    ...(sourceCommit ? { sourceCommit } : {}),
    ...(flags.reason ? { reason: String(flags.reason) } : {}),
    apply: Boolean(flags.apply),
    json: Boolean(flags.json),
  };
}

export async function runRevision(
  options: ParsedRevisionArgs & {
    readonly fetch?: typeof fetch;
    readonly checkoutSource?: InstallSourceCheckoutFactory;
  },
): Promise<RevisionResult> {
  const fetchImpl = options.fetch ?? fetch;
  const current = await fetchInstallation({
    accountsUrl: options.accountsUrl,
    token: options.token,
    installationId: options.installationId,
    fetch: fetchImpl,
  });
  const sourceGitUrl = options.sourceGitUrl ?? current.installation.source.url;
  const next = await previewInstall({
    subcommand: "preview",
    cwd: options.cwd,
    appPath: options.appPath,
    appPathSpec: options.appPathSpec,
    ...(options.manifestPath ? { manifestPath: options.manifestPath } : {}),
    ...(options.manifestPathSpec
      ? { manifestPathSpec: options.manifestPathSpec }
      : {}),
    json: true,
    sourceGitUrl,
    sourceRef: options.targetRef,
    checkoutSource: options.checkoutSource,
  });
  const preview = buildRevisionPreview({
    operation: options.operation,
    installationId: options.installationId,
    current,
    next,
    sourceCommit: options.sourceCommit,
  });
  if (!options.apply) return { preview };

  const request = buildRevisionRequest({
    preview,
    reason: options.reason,
  });
  const response = await fetchImpl(
    `${normalizeBaseUrl(options.accountsUrl)}/v1/installations/${
      encodeURIComponent(options.installationId)
    }/${options.operation}`,
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
    throw new RevisionApplyError(options.operation, response.status, body);
  }
  return {
    preview,
    request,
    response: {
      status: response.status,
      body,
    },
  };
}

function buildRevisionPreview(input: {
  readonly operation: RevisionOperation;
  readonly installationId: string;
  readonly current: AccountsInstallationEnvelope;
  readonly next: InstallPreview;
  readonly sourceCommit?: string;
}): RevisionPreview {
  const sourceCommit = input.sourceCommit ?? input.next.source.commit ??
    (fullCommitPattern.test(input.next.source.ref)
      ? input.next.source.ref
      : undefined);
  if (!sourceCommit) {
    throw new Error(
      `${input.operation} requires a resolved source commit; use a Git URL ref that can be checked out or pass --source-commit`,
    );
  }
  const currentPermissions = new Set(
    (input.current.grants ?? [])
      .filter((grant) => !grant.revoked_at)
      .map((grant) => grant.capability)
      .filter((capability): capability is string => !!capability),
  );
  const nextPermissions = new Set(input.next.permissions.requested);
  const currentBindings = new Set(
    (input.current.bindings ?? [])
      .map((binding) =>
        binding.name && binding.kind ? `${binding.name}:${binding.kind}` : ""
      )
      .filter((value) => value.length > 0),
  );
  const nextBindings = new Set(
    input.next.bindings.map((binding) => `${binding.name}:${binding.type}`),
  );
  const bindingDiff = diffSets(currentBindings, nextBindings);
  const permissionDiff = diffSets(currentPermissions, nextPermissions);
  const manifestChanged =
    (input.current.installation.compiled_manifest_digest ?? undefined) !==
      input.next.source.compiledManifestDigest;
  return {
    kind: "takosumi-git.install-revision-preview@v1",
    operation: input.operation,
    installationId: input.installationId,
    current: {
      appId: input.current.installation.app_id,
      source: input.current.installation.source,
      appManifestDigest: input.current.installation.app_manifest_digest,
      compiledManifestDigest:
        input.current.installation.compiled_manifest_digest,
      status: input.current.installation.status,
    },
    next: {
      appId: input.next.app.id,
      source: {
        git: input.next.source.git,
        ref: input.next.source.ref,
        commit: sourceCommit,
        ...(input.next.source.appManifestDigest
          ? { appManifestDigest: input.next.source.appManifestDigest }
          : {}),
        ...(input.next.source.compiledManifestDigest
          ? { compiledManifestDigest: input.next.source.compiledManifestDigest }
          : {}),
      },
      serviceImports: input.next.serviceImports,
    },
    diff: {
      manifest: {
        changed: manifestChanged,
        from: input.current.installation.compiled_manifest_digest,
        ...(input.next.source.compiledManifestDigest
          ? { to: input.next.source.compiledManifestDigest }
          : {}),
      },
      permissions: permissionDiff,
      bindings: bindingDiff,
    },
    migrationPlan: buildMigrationPlan(input.next, bindingDiff),
  };
}

function buildRevisionRequest(input: {
  readonly preview: RevisionPreview;
  readonly reason?: string;
}): Record<string, unknown> {
  return {
    appId: input.preview.next.appId,
    source: {
      gitUrl: input.preview.next.source.git,
      ref: input.preview.next.source.ref,
      commit: input.preview.next.source.commit,
      appManifestDigest: input.preview.next.source.appManifestDigest,
      compiledManifestDigest: input.preview.next.source.compiledManifestDigest,
    },
    serviceImports: input.preview.next.serviceImports,
    bindings: input.preview.diff.bindings.added.map((entry) => {
      const [name, kind] = entry.split(":");
      return {
        name,
        kind,
        configRef:
          `takosumi-git://installable-app/${input.preview.next.appId}/bindings/${name}`,
        secretRefs: [],
      };
    }),
    grants: input.preview.diff.permissions.added.map((capability) => ({
      capability,
      scope: {
        type: "single-installation",
        appId: input.preview.next.appId,
      },
    })),
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

function diffSets(
  current: ReadonlySet<string>,
  next: ReadonlySet<string>,
): { added: string[]; removed: string[]; unchanged: string[] } {
  const added = [...next].filter((value) => !current.has(value)).sort();
  const removed = [...current].filter((value) => !next.has(value)).sort();
  const unchanged = [...next].filter((value) => current.has(value)).sort();
  return { added, removed, unchanged };
}

function buildMigrationPlan(
  next: InstallPreview,
  bindingDiff: { added: readonly string[]; removed: readonly string[] },
): RevisionPreview["migrationPlan"] {
  const migrationSensitive = [...bindingDiff.added, ...bindingDiff.removed]
    .some((entry) =>
      entry.includes(":database.postgres@v1") ||
      entry.includes(":object-store.s3-compatible@v1")
    );
  if (migrationSensitive) {
    return {
      status: "review-required",
      notes: [
        "database or object-store binding changes require provider migration review",
      ],
    };
  }
  if (!next.source.compiledManifestDigest) {
    return {
      status: "not-computed",
      notes: ["entry manifest digest is unavailable"],
    };
  }
  return {
    status: "not-required",
    notes: ["no binding-level migration detected"],
  };
}

async function fetchInstallation(input: {
  readonly accountsUrl: string;
  readonly token?: string;
  readonly installationId: string;
  readonly fetch: typeof fetch;
}): Promise<AccountsInstallationEnvelope> {
  const response = await input.fetch(
    `${normalizeBaseUrl(input.accountsUrl)}/v1/installations/${
      encodeURIComponent(input.installationId)
    }`,
    {
      headers: {
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      },
    },
  );
  const body = await readResponseBody(response);
  if (response.status >= 400) {
    throw new RevisionApplyError("fetch", response.status, body);
  }
  return body as AccountsInstallationEnvelope;
}

function renderRevisionResult(result: RevisionResult): string {
  const preview = result.preview;
  const lines = [
    `takosumi-git ${preview.operation} preview`,
    `installation: ${preview.installationId}`,
    `current: ${preview.current.source.ref} (${preview.current.source.commit})`,
    `next: ${preview.next.source.ref} (${preview.next.source.commit})`,
    `manifest: ${preview.diff.manifest.changed ? "changed" : "unchanged"}`,
    `permissions: +${preview.diff.permissions.added.length} -${preview.diff.permissions.removed.length}`,
    `bindings: +${preview.diff.bindings.added.length} -${preview.diff.bindings.removed.length}`,
    `migration: ${preview.migrationPlan.status}`,
  ];
  for (const note of preview.migrationPlan.notes) {
    lines.push(`  - ${note}`);
  }
  if (result.response) {
    lines.push(`accounts response: HTTP ${result.response.status}`);
  } else {
    lines.push("accounts response: not applied (pass --apply to mutate)");
  }
  return `${lines.join("\n")}\n`;
}

function revisionHelpText(operation: RevisionOperation): string {
  const targetFlag = operation === "upgrade" ? "--ref <ref>" : "--to <ref>";
  return `takosumi-git ${operation}

USAGE:
  takosumi-git ${operation} <installation-id> ${targetFlag} [options]

OPTIONS:
  ${targetFlag}             immutable tag/ref/full SHA target
  --accounts-url <url>   Takosumi Accounts URL (or TAKOSUMI_ACCOUNTS_URL)
  --token <token>        bearer token (or TAKOSUMI_ACCOUNTS_TOKEN/TAKOS_TOKEN)
  --git-url <url>        source Git URL override (default: current installation)
  --cwd <dir>            project root for local app metadata (default .)
  --app <path>           InstallableApp YAML (default .takosumi/app.yml)
  --manifest <path>      kernel manifest path override
  --source-commit <sha>  resolved 40-char source commit pin
  --reason <text>        ledger event reason
  --apply                POST the revision to Takosumi Accounts
  --json                 print JSON
`;
}

class RevisionHelpRequested extends Error {
  constructor() {
    super("help requested");
    this.name = "RevisionHelpRequested";
  }
}

class RevisionApplyError extends Error {
  constructor(
    operation: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Takosumi Accounts ${operation} returned HTTP ${status}`);
    this.name = "RevisionApplyError";
  }
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
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
