import { parseArgs } from "@std/cli/parse-args";
import { resolve } from "@std/path";

const ACCOUNTS_INSTALLATIONS_IMPORT_PATH = "/v1/installations/import";
const ACCOUNTS_INSTALLATION_EXPORT_BUNDLE_KIND =
  "takosumi.accounts.installation-export-bundle@v1";
const INSTALL_IMPORT_MODES = ["dedicated", "self-hosted"] as const;

type InstallImportMode = typeof INSTALL_IMPORT_MODES[number];

export interface ParsedImportArgs {
  readonly bundlePath: string;
  readonly accountsUrl: string;
  readonly token?: string;
  readonly targetIssuer?: string;
  readonly accountId: string;
  readonly spaceId: string;
  readonly createdBySubject: string;
  readonly targetInstallationId?: string;
  readonly mode?: InstallImportMode;
  readonly idempotencyKey?: string;
  readonly identities?: readonly string[];
  readonly json: boolean;
}

export interface ImportApplyResult {
  readonly bundlePath: string;
  readonly request: Record<string, unknown>;
  readonly ignoredDataEntries?: readonly string[];
  readonly accounts: ImportAccountsResponseSummary;
  readonly importPlan?: Record<string, unknown>;
  readonly response: {
    readonly status: number;
    readonly body: unknown;
  };
}

export interface ImportAccountsResponseSummary {
  readonly installationId?: string;
  readonly runtimeBinding?: Record<string, unknown>;
  readonly bindings: readonly Record<string, unknown>[];
  readonly oidcClient?: Record<string, unknown>;
}

export function parseImportArgs(
  args: readonly string[],
  env: { get(key: string): string | undefined } = Deno.env,
): ParsedImportArgs {
  const [first] = args;
  if (!first || first === "help" || first === "-h" || first === "--help") {
    throw new ImportHelpRequested();
  }
  const flags = parseArgs(args as string[], {
    string: [
      "accounts-url",
      "to",
      "token",
      "target-issuer",
      "auth-issuer",
      "account-id",
      "space",
      "space-id",
      "subject",
      "target-installation-id",
      "installation-id",
      "mode",
      "idempotency-key",
      "identity",
    ],
    boolean: ["json"],
    default: {
      json: false,
    },
  });
  const positional = (flags._ ?? []).map((value) => String(value));
  if (positional.length !== 1) {
    throw new Error("import requires exactly one export bundle path");
  }
  const bundlePath = resolve(positional[0]);
  const accountsUrl = (flags["accounts-url"] as string | undefined) ??
    (flags.to as string | undefined) ?? env.get("TAKOSUMI_ACCOUNTS_URL");
  const token = (flags.token as string | undefined) ??
    env.get("TAKOSUMI_ACCOUNTS_TOKEN") ?? env.get("TAKOS_TOKEN");
  const accountId = (flags["account-id"] as string | undefined) ??
    env.get("TAKOS_ACCOUNT_ID");
  const spaceId = (flags["space-id"] as string | undefined) ??
    (flags.space as string | undefined) ?? env.get("TAKOS_SPACE_ID");
  const createdBySubject = (flags.subject as string | undefined) ??
    env.get("TAKOSUMI_SUBJECT") ?? env.get("TAKOS_SUBJECT");
  const targetIssuer = (flags["target-issuer"] as string | undefined) ??
    (flags["auth-issuer"] as string | undefined);
  const targetInstallationId =
    (flags["target-installation-id"] as string | undefined) ??
      (flags["installation-id"] as string | undefined);
  const mode = flags.mode === undefined
    ? undefined
    : parseImportMode(flags.mode);
  const identities = parseIdentityPaths(flags.identity);
  if (!accountsUrl) {
    throw new Error("missing --to/--accounts-url (or TAKOSUMI_ACCOUNTS_URL)");
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
  return {
    bundlePath,
    accountsUrl,
    ...(token ? { token } : {}),
    ...(targetIssuer ? { targetIssuer } : {}),
    accountId,
    spaceId,
    createdBySubject,
    ...(targetInstallationId ? { targetInstallationId } : {}),
    ...(mode ? { mode } : {}),
    ...(flags["idempotency-key"]
      ? { idempotencyKey: String(flags["idempotency-key"]) }
      : {}),
    ...(identities.length > 0 ? { identities } : {}),
    json: Boolean(flags.json),
  };
}

export async function applyImport(
  options: ParsedImportArgs & {
    readonly fetch?: typeof fetch;
    readonly ageExecutable?: string;
  },
): Promise<ImportApplyResult> {
  const exportInput = await readExportBundleInput(options.bundlePath, {
    identities: options.identities ?? [],
    ageExecutable: options.ageExecutable,
  });
  const bundle = exportInput.bundle;
  const request = {
    bundle,
    targetAccountId: options.accountId,
    targetSpaceId: options.spaceId,
    createdBySubject: options.createdBySubject,
    ...(options.targetIssuer ? { targetIssuer: options.targetIssuer } : {}),
    ...(options.targetInstallationId
      ? { targetInstallationId: options.targetInstallationId }
      : {}),
    ...(options.mode ? { mode: options.mode } : {}),
  };
  const response = await (options.fetch ?? fetch)(
    `${
      normalizeBaseUrl(options.accountsUrl)
    }${ACCOUNTS_INSTALLATIONS_IMPORT_PATH}`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(options.idempotencyKey
          ? { "idempotency-key": options.idempotencyKey }
          : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify(request),
    },
  );
  const body = await readResponseBody(response);
  if (response.status >= 400) {
    throw new ImportApplyError(response.status, body);
  }
  return {
    bundlePath: options.bundlePath,
    request,
    ...(exportInput.dataEntries.length > 0
      ? { ignoredDataEntries: exportInput.dataEntries }
      : {}),
    accounts: readImportAccountsResponse(body),
    ...(readImportPlan(body) ? { importPlan: readImportPlan(body) } : {}),
    response: {
      status: response.status,
      body,
    },
  };
}

export async function runImportCli(args: readonly string[]): Promise<number> {
  let parsed: ParsedImportArgs;
  try {
    parsed = parseImportArgs(args);
  } catch (error) {
    if (error instanceof ImportHelpRequested) {
      Deno.stdout.writeSync(new TextEncoder().encode(IMPORT_HELP_TEXT));
      return 0;
    }
    Deno.stderr.writeSync(
      new TextEncoder().encode(
        `takosumi-git import: ${(error as Error).message}\n`,
      ),
    );
    return 64;
  }

  try {
    const result = await applyImport(parsed);
    const text = parsed.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : renderImportResult(result);
    Deno.stdout.writeSync(new TextEncoder().encode(text));
    return 0;
  } catch (error) {
    Deno.stderr.writeSync(
      new TextEncoder().encode(
        `takosumi-git import: ${(error as Error).message}\n`,
      ),
    );
    return 1;
  }
}

export class ImportHelpRequested extends Error {
  constructor() {
    super("help requested");
    this.name = "ImportHelpRequested";
  }
}

export class ImportApplyError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Takosumi Accounts import returned HTTP ${status}`);
    this.name = "ImportApplyError";
  }
}

const IMPORT_HELP_TEXT = `takosumi-git import

USAGE:
  takosumi-git import <bundle.json|bundle.tar.zst> --to <accounts-url> --account-id <id> --space-id <id> --subject <tsub_...>

OPTIONS:
  --to <url>                    target Takosumi Accounts URL
  --accounts-url <url>          alias for --to
  --token <token>               bearer token (or TAKOSUMI_ACCOUNTS_TOKEN/TAKOS_TOKEN)
  --account-id <id>             target account id (or TAKOS_ACCOUNT_ID)
  --space-id <id>               target space id (or --space / TAKOS_SPACE_ID)
  --subject <tsub_...>          import operator subject (or TAKOSUMI_SUBJECT/TAKOS_SUBJECT)
  --auth-issuer <url>           target OIDC issuer for imported bindings
  --target-issuer <url>         alias for --auth-issuer
  --installation-id <id>        target installation id
  --target-installation-id <id> alias for --installation-id
  --mode <mode>                 dedicated | self-hosted
  --idempotency-key <key>       idempotency key for future-compatible retries
  --identity <path[,path]>      age identity file(s) for .tar.zst.age bundles
  --json                        print JSON
`;

function parseImportMode(value: unknown): InstallImportMode {
  if (
    typeof value === "string" &&
    INSTALL_IMPORT_MODES.includes(value as InstallImportMode)
  ) {
    return value as InstallImportMode;
  }
  throw new Error(`--mode must be one of ${INSTALL_IMPORT_MODES.join("|")}`);
}

function parseIdentityPaths(value: unknown): readonly string[] {
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value.join(",") : String(value);
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean).map((
    entry,
  ) => resolve(entry));
}

interface ReadExportBundleInputResult {
  readonly bundle: Record<string, unknown>;
  readonly dataEntries: readonly string[];
}

async function readExportBundleInput(
  path: string,
  options: {
    readonly identities?: readonly string[];
    readonly ageExecutable?: string;
  } = {},
): Promise<ReadExportBundleInputResult> {
  if (path.endsWith(".age")) {
    const result = await readAgeEncryptedTarZstBundle(path, options);
    return {
      bundle: parseExportBundleJsonText(result.bundleJson),
      dataEntries: result.dataEntries,
    };
  }
  if (path.endsWith(".tar.zst")) {
    const result = await readTarZstBundle(path);
    return {
      bundle: parseExportBundleJsonText(result.bundleJson),
      dataEntries: result.dataEntries,
    };
  }
  return {
    bundle: parseExportBundleJsonText(await Deno.readTextFile(path)),
    dataEntries: [],
  };
}

async function readAgeEncryptedTarZstBundle(
  path: string,
  options: {
    readonly identities?: readonly string[];
    readonly ageExecutable?: string;
  },
): Promise<{ bundleJson: string; dataEntries: readonly string[] }> {
  const identities = options.identities ?? [];
  if (identities.length === 0) {
    throw new Error("encrypted export bundle import requires --identity");
  }
  const clearPath = await Deno.makeTempFile({
    prefix: "takosumi-git-import-",
    suffix: ".tar.zst",
  });
  try {
    const output = await new Deno.Command(options.ageExecutable ?? "age", {
      args: [
        "-d",
        ...identities.flatMap((identity) => ["-i", identity]),
        "-o",
        clearPath,
        path,
      ],
    }).output();
    if (!output.success) {
      const stderr = new TextDecoder().decode(output.stderr).trim();
      throw new Error(
        `failed to decrypt export bundle${stderr ? `: ${stderr}` : ""}`,
      );
    }
    return await readTarZstBundle(clearPath);
  } finally {
    await Deno.remove(clearPath).catch(() => {});
  }
}

async function readTarZstBundle(
  path: string,
): Promise<{ bundleJson: string; dataEntries: readonly string[] }> {
  return {
    bundleJson: await readTarZstBundleJson(path),
    dataEntries: await readTarZstDataEntries(path),
  };
}

async function readTarZstBundleJson(path: string): Promise<string> {
  const candidates = ["takos-export/bundle.json", "bundle.json"];
  const errors: string[] = [];
  for (const candidate of candidates) {
    const output = await new Deno.Command("tar", {
      args: [
        "--use-compress-program=zstd",
        "-xOf",
        path,
        candidate,
      ],
    }).output();
    if (output.success) return new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr).trim();
    if (stderr) errors.push(`${candidate}: ${stderr}`);
  }
  throw new Error(
    `failed to read export bundle JSON from tar.zst: ${errors.join("; ")}`,
  );
}

async function readTarZstDataEntries(path: string): Promise<readonly string[]> {
  const output = await new Deno.Command("tar", {
    args: [
      "--use-compress-program=zstd",
      "-tf",
      path,
    ],
  }).output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr).trim();
    throw new Error(
      `failed to list export bundle archive${stderr ? `: ${stderr}` : ""}`,
    );
  }
  const entries = new TextDecoder().decode(output.stdout).split(/\r?\n/)
    .map((entry) => entry.replace(/^\.\//, "").trim())
    .filter(Boolean);
  return entries.filter((entry) =>
    entry.startsWith("takos-export/data/") &&
    !entry.endsWith("/") &&
    entry !== "takos-export/data/README.md"
  ).sort((a, b) => a.localeCompare(b));
}

function parseExportBundleJsonText(text: string): Record<string, unknown> {
  try {
    return parseExportBundleJson(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`invalid export bundle JSON: ${error.message}`);
    }
    throw error;
  }
}

function parseExportBundleJson(parsed: unknown): Record<string, unknown> {
  if (
    !isRecord(parsed) ||
    parsed.kind !== ACCOUNTS_INSTALLATION_EXPORT_BUNDLE_KIND
  ) {
    throw new Error(
      `unsupported export bundle kind: ${
        isRecord(parsed) ? String(parsed.kind) : String(parsed)
      }`,
    );
  }
  return parsed;
}

function renderImportResult(result: ImportApplyResult): string {
  const sourceIssuer = stringProperty(
    result.importPlan ?? {},
    "source_issuer",
    "sourceIssuer",
  );
  const targetIssuer = stringProperty(
    result.importPlan ?? {},
    "target_issuer",
    "targetIssuer",
  );
  return [
    "takosumi-git import",
    `bundle: ${result.bundlePath}`,
    `installation: ${result.accounts.installationId ?? "(unknown)"}`,
    ...(sourceIssuer ? [`source issuer: ${sourceIssuer}`] : []),
    ...(targetIssuer ? [`target issuer: ${targetIssuer}`] : []),
    ...(result.ignoredDataEntries?.length
      ? [
        `data restore: skipped (${result.ignoredDataEntries.length} archive data entries ignored by current import API)`,
      ]
      : []),
    `accounts response: HTTP ${result.response.status}`,
    "",
  ].join("\n");
}

function readImportAccountsResponse(
  body: unknown,
): ImportAccountsResponseSummary {
  const record = isRecord(body) ? body : {};
  const bindings = Array.isArray(record.bindings)
    ? record.bindings.filter(isRecord)
    : [];
  const oidcClient = isRecord(record.oidc_client)
    ? record.oidc_client
    : isRecord(record.oidcClient)
    ? record.oidcClient
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
  };
}

function readImportPlan(body: unknown): Record<string, unknown> | undefined {
  const record = isRecord(body) ? body : {};
  return isRecord(record.import_plan)
    ? record.import_plan
    : isRecord(record.importPlan)
    ? record.importPlan
    : undefined;
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

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringProperty(
  record: Record<string, unknown>,
  snakeKey: string,
  camelKey: string,
): string | undefined {
  const value = record[snakeKey] ?? record[camelKey];
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
