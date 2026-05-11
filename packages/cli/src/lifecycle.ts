import { parseArgs } from "@std/cli/parse-args";
import { dirname } from "@std/path";

type LifecycleOperation = "materialize" | "export";

export interface ParsedLifecycleArgs {
  readonly operation: LifecycleOperation;
  readonly installationId: string;
  readonly accountsUrl: string;
  readonly token?: string;
  readonly idempotencyKey: string;
  readonly json: boolean;
  readonly materialize?: {
    readonly mode: "dedicated";
    readonly region: string;
    readonly plan: Record<string, unknown>;
    readonly cutover: Record<string, unknown>;
    readonly permissionDigest?: string;
  };
  readonly export?: {
    readonly includeData: boolean;
    readonly encryption: {
      readonly method: "none" | "age";
      readonly recipients: readonly string[];
    };
    readonly scope: Record<string, unknown>;
    readonly outputPath?: string;
  };
}

export interface LifecycleResult {
  readonly operation: LifecycleOperation;
  readonly request: Record<string, unknown>;
  readonly response: {
    readonly status: number;
    readonly body: unknown;
  };
  readonly download?: {
    readonly url: string;
    readonly outputPath: string;
    readonly bytes: number;
  };
}

export async function runMaterializeCli(
  args: readonly string[],
): Promise<number> {
  return await runLifecycleCli("materialize", args);
}

export async function runExportCli(args: readonly string[]): Promise<number> {
  return await runLifecycleCli("export", args);
}

async function runLifecycleCli(
  operation: LifecycleOperation,
  args: readonly string[],
): Promise<number> {
  let parsed: ParsedLifecycleArgs;
  try {
    parsed = parseLifecycleArgs(operation, args);
  } catch (error) {
    if (error instanceof LifecycleHelpRequested) {
      Deno.stdout.writeSync(
        new TextEncoder().encode(lifecycleHelpText(operation)),
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
    const result = await runLifecycle(parsed);
    const text = parsed.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : renderLifecycleResult(result);
    Deno.stdout.writeSync(new TextEncoder().encode(text));
    return result.response.status >= 400 ? 1 : 0;
  } catch (error) {
    Deno.stderr.writeSync(
      new TextEncoder().encode(
        `takosumi-git ${operation}: ${(error as Error).message}\n`,
      ),
    );
    return 1;
  }
}

export function parseLifecycleArgs(
  operation: LifecycleOperation,
  args: readonly string[],
  env: { get(key: string): string | undefined } = Deno.env,
): ParsedLifecycleArgs {
  const [first] = args;
  if (!first || first === "help" || first === "-h" || first === "--help") {
    throw new LifecycleHelpRequested();
  }
  const flags = parseArgs(args as string[], {
    string: [
      "accounts-url",
      "token",
      "idempotency-key",
      "mode",
      "region",
      "compute",
      "database",
      "object-store",
      "cutover-strategy",
      "drain-seconds",
      "permission-digest",
      "encryption-method",
      "recipient",
      "data",
      "secrets",
      "output",
    ],
    boolean: ["cost-ack", "include-data", "json"],
    default: {
      json: false,
      "include-data": false,
    },
  });
  const positional = (flags._ ?? []).map((value) => String(value));
  if (positional.length !== 1) {
    throw new Error(`${operation} requires exactly one installation id`);
  }
  const accountsUrl = (flags["accounts-url"] as string | undefined) ??
    env.get("TAKOSUMI_ACCOUNTS_URL");
  if (!accountsUrl) {
    throw new Error("missing --accounts-url (or TAKOSUMI_ACCOUNTS_URL)");
  }
  const token = (flags.token as string | undefined) ??
    env.get("TAKOSUMI_ACCOUNTS_TOKEN") ?? env.get("TAKOS_TOKEN");
  const idempotencyKey = (flags["idempotency-key"] as string | undefined) ??
    crypto.randomUUID();
  const base = {
    operation,
    installationId: positional[0],
    accountsUrl,
    ...(token ? { token } : {}),
    idempotencyKey,
    json: Boolean(flags.json),
  };
  if (operation === "materialize") {
    const mode = (flags.mode as string | undefined) ?? "dedicated";
    if (mode !== "dedicated") {
      throw new Error("--mode must be dedicated");
    }
    const region = flags.region as string | undefined;
    if (!region) throw new Error("missing --region");
    if (flags["cost-ack"] !== true) {
      throw new Error("--cost-ack is required");
    }
    const drainSeconds = optionalNonNegativeInteger(
      flags["drain-seconds"],
      "--drain-seconds",
    );
    return {
      ...base,
      materialize: {
        mode,
        region,
        plan: objectFromEntries({
          compute: flags.compute,
          database: flags.database,
          objectStore: flags["object-store"],
        }),
        cutover: objectFromEntries({
          strategy: flags["cutover-strategy"] ?? "blue-green",
          ...(drainSeconds !== undefined ? { drainSeconds } : {}),
        }),
        ...(flags["permission-digest"]
          ? { permissionDigest: String(flags["permission-digest"]) }
          : {}),
      },
    };
  }

  const method = (flags["encryption-method"] as string | undefined) ?? "none";
  if (method !== "none" && method !== "age") {
    throw new Error("--encryption-method must be none or age");
  }
  const recipients = commaSeparated(flags.recipient);
  if (method === "age" && recipients.length === 0) {
    throw new Error("--recipient is required when --encryption-method age");
  }
  return {
    ...base,
    export: {
      includeData: Boolean(flags["include-data"]),
      encryption: { method, recipients },
      scope: objectFromEntries({
        data: commaSeparated(flags.data),
        secrets: flags.secrets,
      }),
      ...(flags.output ? { outputPath: String(flags.output) } : {}),
    },
  };
}

export async function runLifecycle(
  options: ParsedLifecycleArgs & { readonly fetch?: typeof fetch },
): Promise<LifecycleResult> {
  const request = buildLifecycleRequest(options);
  const response = await (options.fetch ?? fetch)(
    `${normalizeBaseUrl(options.accountsUrl)}/v1/installations/${
      encodeURIComponent(options.installationId)
    }/${options.operation}`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": options.idempotencyKey,
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify(request),
    },
  );
  const body = await readResponseBody(response);
  if (response.status >= 400) {
    throw new LifecycleApplyError(options.operation, response.status, body);
  }
  const download = options.operation === "export" && options.export?.outputPath
    ? await downloadExportBundle({
      fetch: options.fetch ?? fetch,
      body,
      outputPath: options.export.outputPath,
    })
    : undefined;
  return {
    operation: options.operation,
    request,
    response: {
      status: response.status,
      body,
    },
    ...(download ? { download } : {}),
  };
}

function buildLifecycleRequest(
  options: ParsedLifecycleArgs,
): Record<string, unknown> {
  if (options.operation === "materialize") {
    const materialize = options.materialize;
    if (!materialize) throw new Error("missing materialize options");
    return {
      mode: materialize.mode,
      region: materialize.region,
      plan: materialize.plan,
      cutover: materialize.cutover,
      confirm: {
        costAck: true,
        permissionDigest: materialize.permissionDigest ?? null,
      },
    };
  }
  const exportOptions = options.export;
  if (!exportOptions) throw new Error("missing export options");
  return {
    includeData: exportOptions.includeData,
    format: "bundle",
    encryption: exportOptions.encryption,
    scope: exportOptions.scope,
  };
}

function renderLifecycleResult(result: LifecycleResult): string {
  const body = isRecord(result.response.body) ? result.response.body : {};
  if (result.operation === "materialize") {
    return [
      `Materialize operation ${stringValue(body.operationId) ?? "unknown"}`,
      `  installation: ${stringValue(body.installationId) ?? "unknown"}`,
      `  mode: ${stringValue(body.fromMode) ?? "shared-cell"} -> ${
        stringValue(body.toMode) ?? "dedicated"
      }`,
      `  tracking: ${stringValue(body.trackingUrl) ?? "unknown"}`,
    ].join("\n") + "\n";
  }
  return [
    `Export operation ${stringValue(body.operationId) ?? "unknown"}`,
    `  status: ${stringValue(body.status) ?? "preparing"}`,
    `  tracking: ${stringValue(body.trackingUrl) ?? "unknown"}`,
    ...(result.download
      ? [
        `  download: ${result.download.url}`,
        `  output: ${result.download.outputPath}`,
        `  bytes: ${result.download.bytes}`,
      ]
      : []),
  ].join("\n") + "\n";
}

function lifecycleHelpText(operation: LifecycleOperation): string {
  if (operation === "materialize") {
    return `takosumi-git materialize

USAGE:
  takosumi-git materialize <installation-id> --mode dedicated --region <region> --cost-ack [options]

OPTIONS:
  --accounts-url <url>       Takosumi Accounts URL (or TAKOSUMI_ACCOUNTS_URL)
  --token <token>            bearer token (or TAKOSUMI_ACCOUNTS_TOKEN/TAKOS_TOKEN)
  --mode dedicated           target runtime mode (default dedicated)
  --region <region>          target dedicated runtime region
  --compute <plan>           compute plan hint
  --database <plan>          database plan hint
  --object-store <plan>      object storage plan hint
  --cutover-strategy <mode>  cutover strategy (default blue-green)
  --drain-seconds <n>        non-negative drain window
  --permission-digest <sha>  approved permission digest
  --idempotency-key <key>    idempotency key (default random UUID)
  --cost-ack                 acknowledge dedicated runtime cost
  --json                     print JSON
`;
  }
  return `takosumi-git export

USAGE:
  takosumi-git export <installation-id> [options]

OPTIONS:
  --accounts-url <url>       Takosumi Accounts URL (or TAKOSUMI_ACCOUNTS_URL)
  --token <token>            bearer token (or TAKOSUMI_ACCOUNTS_TOKEN/TAKOS_TOKEN)
  --include-data             include data resources in the bundle request
  --encryption-method <m>    none | age (default none)
  --recipient <age1...,...>  age recipients when encryption method is age
  --data <name,...>          data scope labels
  --secrets <mode>           secret export scope mode
  --output <path>            write the bundle when the operation returns downloadUrl
  --idempotency-key <key>    idempotency key (default random UUID)
  --json                     print JSON
`;
}

class LifecycleHelpRequested extends Error {
  constructor() {
    super("help requested");
    this.name = "LifecycleHelpRequested";
  }
}

class LifecycleApplyError extends Error {
  constructor(
    operation: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Takosumi Accounts ${operation} returned HTTP ${status}`);
    this.name = "LifecycleApplyError";
  }
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function objectFromEntries(
  entries: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === false || value === "") continue;
    result[key] = value;
  }
  return result;
}

async function downloadExportBundle(input: {
  fetch: typeof fetch;
  body: unknown;
  outputPath: string;
}): Promise<LifecycleResult["download"]> {
  const body = isRecord(input.body) ? input.body : {};
  const downloadUrl = stringValue(body.downloadUrl);
  if (!downloadUrl) {
    throw new Error(
      "export did not return a downloadUrl; rerun with the same idempotency key after the operation is ready",
    );
  }
  const response = await input.fetch(downloadUrl, {
    headers: { accept: "application/octet-stream" },
  });
  if (!response.ok) {
    throw new Error(`export download returned HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  await Deno.mkdir(dirname(input.outputPath), { recursive: true });
  await Deno.writeFile(input.outputPath, bytes);
  return {
    url: downloadUrl,
    outputPath: input.outputPath,
    bytes: bytes.byteLength,
  };
}

function commaSeparated(value: unknown): readonly string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function optionalNonNegativeInteger(
  value: unknown,
  flag: string,
): number | undefined {
  if (value === undefined || value === false || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
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
