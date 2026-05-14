/**
 * `takosumi-git serve` implementation.
 *
 * Receives git webhooks, verifies provider signatures, deduplicates delivery
 * IDs, and dispatches `takosumi-git push`.
 */

import { parseArgs } from "@std/cli/parse-args";
import { dirname, isAbsolute, join } from "@std/path";
import type { WorkflowEvent } from "@takos/takosumi-git-workflow-contract";
import { type ArtifactContract, parseArtifactContract, push } from "./push.ts";
import {
  deliveryId,
  hmacSha256Hex,
  isPushWebhookEvent,
  isRecord,
  normalizeWebhookEvent,
  providerFromPath,
  verifyWebhookSignature,
  type WebhookProvider,
} from "./webhook_signature.ts";
export { hmacSha256Hex, type WebhookProvider } from "./webhook_signature.ts";
import {
  applyInstall,
  buildInstallPreview,
  compileInstallManifest,
  digestText,
  INSTALLABLE_APP_RUNTIME_MODES,
  type InstallableAppRuntimeMode,
  InstallableAppValidationError,
  InstallApplyError,
  type InstallSourceCheckoutFactory,
  parseInstallableAppObject,
  parseInstallableAppYaml,
  previewInstall,
} from "./install.ts";
import { runRevision } from "./revision.ts";

export type WebhookMode = "push" | "install";

export interface ServeOptions {
  readonly host: string;
  readonly port: number;
  readonly endpoint: string;
  readonly token: string;
  readonly manifestPath: string;
  readonly workflowsDir: string;
  readonly webhookSecret: string;
  readonly artifactContract: ArtifactContract;
  readonly accountsUrl?: string;
  readonly accountsToken?: string;
  readonly accountId?: string;
  readonly spaceId?: string;
  readonly subject?: string;
  readonly webhookMode?: WebhookMode;
  readonly runtimeBaseUrl?: string;
  readonly deployToken?: string;
  readonly rateLimit: number;
  readonly rateLimitWindowMs: number;
  readonly installPreviewCheckoutSource?: InstallSourceCheckoutFactory;
  readonly installApplyFetch?: typeof fetch;
  readonly waitForDispatch?: boolean;
  readonly dispatch?: WebhookDispatch;
}

export interface ParsedServeArgs extends ServeOptions {}

export interface WebhookDispatchJob {
  readonly id: string;
  readonly provider: WebhookProvider;
  readonly event: WorkflowEvent;
}

export type WebhookDispatch = (job: WebhookDispatchJob) => Promise<void>;

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8788;
const DEFAULT_MANIFEST = ".takosumi/manifest.yml";
const DEFAULT_WORKFLOWS_DIR = ".takosumi/workflows";
const DEFAULT_RATE_LIMIT = 60;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const fullCommitPattern = /^[0-9a-f]{40}$/;

class InMemoryRateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #hits = new Map<string, number[]>();

  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  allow(key: string, now = Date.now()): boolean {
    const cutoff = now - this.#windowMs;
    const hits = (this.#hits.get(key) ?? []).filter((hit) => hit > cutoff);
    if (hits.length >= this.#limit) {
      this.#hits.set(key, hits);
      return false;
    }
    hits.push(now);
    this.#hits.set(key, hits);
    return true;
  }
}

class InMemoryWebhookQueue {
  readonly #seen = new Set<string>();
  readonly #queue: WebhookDispatchJob[] = [];
  #running = false;

  enqueue(job: WebhookDispatchJob): "queued" | "duplicate" {
    if (this.#seen.has(job.id)) return "duplicate";
    this.#seen.add(job.id);
    this.#queue.push(job);
    return "queued";
  }

  async drain(dispatch: WebhookDispatch): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#queue.length > 0) {
        const job = this.#queue.shift()!;
        await dispatch(job);
      }
    } finally {
      this.#running = false;
    }
  }
}

function json(body: object, status: number): Response {
  return Response.json(body, { status });
}

function rateLimitKey(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "direct";
}

export function createServeHandler(
  options: ServeOptions,
): (request: Request) => Promise<Response> {
  const queue = new InMemoryWebhookQueue();
  const limiter = new InMemoryRateLimiter(
    options.rateLimit,
    options.rateLimitWindowMs,
  );
  const dispatch = options.dispatch ?? defaultDispatch(options);

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "takosumi-git-serve" }, 200);
    }
    if (request.method === "POST" && url.pathname === "/v1/install/preview") {
      if (!limiter.allow(rateLimitKey(request))) {
        return json({ error: "rate_limited" }, 429);
      }
      return await handleInstallPreviewRequest(
        request,
        options.installPreviewCheckoutSource,
      );
    }
    if (request.method === "POST" && url.pathname === "/v1/install/apply") {
      if (!limiter.allow(rateLimitKey(request))) {
        return json({ error: "rate_limited" }, 429);
      }
      if (!hasBearerToken(request, options.token)) {
        return json({ error: "unauthorized" }, 401);
      }
      return await handleInstallApplyRequest(request, options);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/v1/install/revision/preview"
    ) {
      if (!limiter.allow(rateLimitKey(request))) {
        return json({ error: "rate_limited" }, 429);
      }
      if (!hasBearerToken(request, options.token)) {
        return json({ error: "unauthorized" }, 401);
      }
      return await handleInstallRevisionRequest(request, options, false);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/v1/install/revision/apply"
    ) {
      if (!limiter.allow(rateLimitKey(request))) {
        return json({ error: "rate_limited" }, 429);
      }
      if (!hasBearerToken(request, options.token)) {
        return json({ error: "unauthorized" }, 401);
      }
      return await handleInstallRevisionRequest(request, options, true);
    }
    if (request.method !== "POST") return json({ error: "not_found" }, 404);
    const provider = providerFromPath(url.pathname);
    if (!provider) return json({ error: "not_found" }, 404);
    if (!limiter.allow(rateLimitKey(request))) {
      return json({ error: "rate_limited" }, 429);
    }

    const rawBody = await request.text();
    const verified = await verifyWebhookSignature(
      provider,
      options.webhookSecret,
      request.headers,
      rawBody,
    );
    if (!verified) return json({ error: "invalid_signature" }, 401);

    if (!isPushWebhookEvent(provider, request.headers)) {
      return json({
        ok: true,
        queued: false,
        ignored: true,
        reason: "unsupported_event",
      }, 202);
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const id = deliveryId(provider, request.headers, body);
    const status = queue.enqueue({
      id,
      provider,
      event: normalizeWebhookEvent(provider, request.headers, body),
    });
    if (status === "duplicate") {
      return json({ ok: true, queued: false, duplicate: true }, 202);
    }

    const drain = queue.drain(dispatch);
    if (options.waitForDispatch ?? false) await drain;
    else {
      drain.catch((error) => {
        console.error(
          `takosumi-git serve dispatch failed: ${(error as Error).message}`,
        );
      });
    }
    return json({ ok: true, queued: true, duplicate: false }, 202);
  };
}

async function handleInstallPreviewRequest(
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

async function handleInstallApplyRequest(
  request: Request,
  options: ServeOptions,
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

async function handleInstallRevisionRequest(
  request: Request,
  options: ServeOptions,
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

function optionalBodyString(
  body: Record<string, unknown>,
  key: string,
  alternateKey?: string,
): string | undefined {
  const value = body[key] ?? (alternateKey ? body[alternateKey] : undefined);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalBodyBoolean(
  body: Record<string, unknown>,
  key: string,
  alternateKey?: string,
): boolean | undefined {
  const value = body[key] ?? (alternateKey ? body[alternateKey] : undefined);
  return typeof value === "boolean" ? value : undefined;
}

function hasBearerToken(request: Request, token: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${token}`;
}

function parseOptionalSourceCommit(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  if (!fullCommitPattern.test(value)) {
    throw new Error("sourceCommit must be a 40-char SHA");
  }
  return value;
}

function parseOptionalBodyMode(
  body: Record<string, unknown>,
): InstallableAppRuntimeMode | undefined {
  const value = optionalBodyString(body, "mode");
  if (!value) return undefined;
  if (
    INSTALLABLE_APP_RUNTIME_MODES.includes(value as InstallableAppRuntimeMode)
  ) {
    return value as InstallableAppRuntimeMode;
  }
  throw new Error(
    `mode must be one of ${INSTALLABLE_APP_RUNTIME_MODES.join("|")}`,
  );
}

function parseOptionalRuntimeBaseUrl(
  value: string | undefined,
): string | undefined {
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
      "runtimeBaseUrl must be an https URL or localhost http URL",
    );
  }
}

function pathFromSpec(cwd: string, spec: string): string {
  return isAbsolute(spec) ? spec : join(cwd, spec);
}

function defaultDispatch(options: ServeOptions): WebhookDispatch {
  return async (job) => {
    if ((options.webhookMode ?? "push") === "install") {
      await dispatchInstallWebhook(options, job);
      return;
    }
    await push({
      endpoint: options.endpoint,
      token: options.token,
      manifestPath: options.manifestPath,
      workflowsDir: options.workflowsDir,
      mode: "apply",
      dryRun: false,
      artifactContract: options.artifactContract,
      event: job.event,
    });
  };
}

async function dispatchInstallWebhook(
  options: ServeOptions,
  job: WebhookDispatchJob,
): Promise<void> {
  if (
    !options.accountsUrl || !options.accountsToken || !options.accountId ||
    !options.spaceId || !options.subject
  ) {
    throw new Error(
      "webhook install mode requires accounts URL, accounts token, account id, space id, and subject",
    );
  }
  const cwd = Deno.cwd();
  const manifestPath = pathFromSpec(cwd, options.manifestPath);
  const projectRoot = dirname(dirname(manifestPath));
  const sourceCommit = eventCommit(job.event);
  await applyInstall({
    subcommand: "apply",
    cwd: projectRoot,
    appPath: join(projectRoot, ".takosumi", "app.yml"),
    manifestPath,
    json: true,
    accountsUrl: options.accountsUrl,
    token: options.accountsToken,
    accountId: options.accountId,
    spaceId: options.spaceId,
    createdBySubject: options.subject,
    ...(sourceCommit ? { sourceCommit } : {}),
    ...(options.runtimeBaseUrl
      ? { runtimeBaseUrl: options.runtimeBaseUrl }
      : {}),
    endpoint: options.endpoint,
    deployToken: options.deployToken ?? options.token,
    ...(options.installApplyFetch ? { fetch: options.installApplyFetch } : {}),
  });
}

function eventCommit(event: WorkflowEvent): string | undefined {
  const commit = isRecord(event.payload)
    ? typeof event.payload.commit === "string" ? event.payload.commit : ""
    : "";
  return fullCommitPattern.test(commit) ? commit : undefined;
}

function parseWebhookMode(value: string): WebhookMode {
  if (value === "push" || value === "install") return value;
  throw new Error("--webhook-mode must be push or install");
}

function parsePositiveInt(raw: unknown, field: string): number {
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer (got '${raw}')`);
  }
  return value;
}

export function parseServeArgs(
  args: readonly string[],
  env: { get(key: string): string | undefined } = Deno.env,
): ParsedServeArgs {
  rejectRemovedServiceResolverOptions(args);
  const flags = parseArgs(args as string[], {
    string: [
      "host",
      "port",
      "endpoint",
      "token",
      "manifest",
      "workflows-dir",
      "webhook-secret",
      "webhook-mode",
      "artifact-contract",
      "accounts-url",
      "accounts-token",
      "account-id",
      "space",
      "space-id",
      "subject",
      "runtime-base-url",
      "deploy-token",
      "rate-limit",
      "rate-limit-window-ms",
    ],
    default: {
      host: DEFAULT_HOST,
      port: String(DEFAULT_PORT),
      manifest: DEFAULT_MANIFEST,
      "workflows-dir": DEFAULT_WORKFLOWS_DIR,
      "artifact-contract": "v1",
      "rate-limit": String(DEFAULT_RATE_LIMIT),
      "rate-limit-window-ms": String(DEFAULT_RATE_LIMIT_WINDOW_MS),
    },
  });
  const endpoint = (flags.endpoint as string | undefined) ??
    env.get("TAKOSUMI_ENDPOINT") ?? "";
  const token = (flags.token as string | undefined) ??
    env.get("TAKOSUMI_TOKEN") ?? "";
  const webhookSecret = (flags["webhook-secret"] as string | undefined) ??
    env.get("TAKOSUMI_GIT_WEBHOOK_SECRET") ?? "";
  const webhookMode = parseWebhookMode(
    (flags["webhook-mode"] as string | undefined) ??
      env.get("TAKOSUMI_GIT_WEBHOOK_MODE") ?? "push",
  );
  const accountsUrl = (flags["accounts-url"] as string | undefined) ??
    env.get("TAKOSUMI_ACCOUNTS_URL");
  const accountsToken = (flags["accounts-token"] as string | undefined) ??
    env.get("TAKOSUMI_ACCOUNTS_TOKEN") ?? env.get("TAKOS_TOKEN");
  const accountId = (flags["account-id"] as string | undefined) ??
    env.get("TAKOS_ACCOUNT_ID");
  const spaceId = (flags["space-id"] as string | undefined) ??
    (flags.space as string | undefined) ?? env.get("TAKOS_SPACE_ID");
  const subject = (flags.subject as string | undefined) ??
    env.get("TAKOSUMI_SUBJECT") ?? env.get("TAKOS_SUBJECT");
  const runtimeBaseUrl = parseOptionalRuntimeBaseUrl(
    (flags["runtime-base-url"] as string | undefined) ??
      env.get("TAKOSUMI_RUNTIME_BASE_URL"),
  );
  const deployToken = (flags["deploy-token"] as string | undefined) ??
    env.get("TAKOSUMI_DEPLOY_TOKEN") ?? env.get("TAKOSUMI_TOKEN");
  if (!endpoint) throw new Error("missing --endpoint (or TAKOSUMI_ENDPOINT)");
  if (!token) throw new Error("missing --token (or TAKOSUMI_TOKEN)");
  if (!webhookSecret) {
    throw new Error(
      "missing --webhook-secret (or TAKOSUMI_GIT_WEBHOOK_SECRET)",
    );
  }
  if (
    webhookMode === "install" &&
    (!accountsUrl || !accountsToken || !accountId || !spaceId || !subject)
  ) {
    throw new Error(
      "--webhook-mode install requires --accounts-url, --accounts-token, --account-id, --space-id, and --subject",
    );
  }
  return {
    host: flags.host as string,
    port: parsePositiveInt(flags.port, "--port"),
    endpoint,
    token,
    manifestPath: flags.manifest as string,
    workflowsDir: flags["workflows-dir"] as string,
    webhookSecret,
    webhookMode,
    artifactContract: parseArtifactContract(flags["artifact-contract"]),
    ...(accountsUrl ? { accountsUrl } : {}),
    ...(accountsToken ? { accountsToken } : {}),
    ...(accountId ? { accountId } : {}),
    ...(spaceId ? { spaceId } : {}),
    ...(subject ? { subject } : {}),
    ...(runtimeBaseUrl ? { runtimeBaseUrl } : {}),
    ...(deployToken ? { deployToken } : {}),
    rateLimit: parsePositiveInt(flags["rate-limit"], "--rate-limit"),
    rateLimitWindowMs: parsePositiveInt(
      flags["rate-limit-window-ms"],
      "--rate-limit-window-ms",
    ),
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

export async function runServeCli(args: readonly string[]): Promise<number> {
  let parsed: ParsedServeArgs;
  try {
    parsed = parseServeArgs(args);
  } catch (error) {
    Deno.stderr.writeSync(
      new TextEncoder().encode(
        `takosumi-git serve: ${(error as Error).message}\n`,
      ),
    );
    return 64;
  }

  const handler = createServeHandler(parsed);
  Deno.serve({ hostname: parsed.host, port: parsed.port }, handler);
  await new Promise(() => {});
  return 0;
}
