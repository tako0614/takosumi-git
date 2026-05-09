import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { applyImport, ImportApplyError, parseImportArgs } from "./import.ts";

const EXPORT_BUNDLE = {
  kind: "takosumi.accounts.installation-export-bundle@v1",
  version: "v1",
  exportedAt: "2026-05-09T00:00:00.000Z",
  installation: {
    installationId: "inst_source",
    accountId: "acct_source",
    spaceId: "space_source",
    appId: "example.hello",
    mode: "dedicated",
    status: "ready",
  },
  source: {
    gitUrl: "https://github.com/example/hello",
    ref: "v1.2.3",
    commit: "0123456789abcdef0123456789abcdef01234567",
    appManifestDigest: "sha256:app",
    compiledManifestDigest: "sha256:compiled",
  },
  serviceImports: [],
  runtimeBinding: null,
  oidcClient: {
    clientId: "toc_source",
    binding: "auth",
    serviceId: "takosumi.account.auth@v1",
    issuerUrl: "https://accounts.source.test",
    redirectUris: ["https://hello.example/auth/callback"],
    allowedScopes: ["openid", "profile"],
    subjectMode: "pairwise",
    tokenEndpointAuthMethod: "client_secret_post",
  },
  bindings: [],
  grants: [],
  events: [],
};

Deno.test("parseImportArgs reads import options and aliases", () => {
  const parsed = parseImportArgs([
    "takos-export.bundle.json",
    "--to",
    "https://accounts.target.test",
    "--account-id",
    "acct_target",
    "--space-id",
    "space_target",
    "--subject",
    "tsub_target",
    "--auth-issuer",
    "https://accounts.target.test",
    "--installation-id",
    "inst_target",
    "--mode",
    "self-hosted",
    "--idempotency-key",
    "idem-import",
    "--json",
  ]);

  assertStringIncludes(parsed.bundlePath, "takos-export.bundle.json");
  assertEquals(parsed.accountsUrl, "https://accounts.target.test");
  assertEquals(parsed.accountId, "acct_target");
  assertEquals(parsed.spaceId, "space_target");
  assertEquals(parsed.createdBySubject, "tsub_target");
  assertEquals(parsed.targetIssuer, "https://accounts.target.test");
  assertEquals(parsed.targetInstallationId, "inst_target");
  assertEquals(parsed.mode, "self-hosted");
  assertEquals(parsed.idempotencyKey, "idem-import");
  assertEquals(parsed.json, true);
});

Deno.test("parseImportArgs reads required options from env", () => {
  const parsed = parseImportArgs(["takos-export.bundle.json"], {
    get(key: string) {
      const env: Record<string, string> = {
        TAKOSUMI_ACCOUNTS_URL: "https://accounts.target.test",
        TAKOS_ACCOUNT_ID: "acct_target",
        TAKOS_SPACE_ID: "space_target",
        TAKOSUMI_SUBJECT: "tsub_target",
        TAKOS_TOKEN: "accounts-token",
      };
      return env[key];
    },
  });

  assertEquals(parsed.accountsUrl, "https://accounts.target.test");
  assertEquals(parsed.accountId, "acct_target");
  assertEquals(parsed.spaceId, "space_target");
  assertEquals(parsed.createdBySubject, "tsub_target");
  assertEquals(parsed.token, "accounts-token");
});

Deno.test("parseImportArgs rejects tar.zst until archive parser exists", () => {
  assertThrows(
    () =>
      parseImportArgs([
        "takos-export.tar.zst",
        "--to",
        "https://accounts.target.test",
        "--account-id",
        "acct_target",
        "--space-id",
        "space_target",
        "--subject",
        "tsub_target",
      ]),
    Error,
    "tar.zst bundle import is not implemented yet",
  );
});

Deno.test("applyImport posts JSON export bundle to Accounts import API", async () => {
  const root = await Deno.makeTempDir({
    prefix: "takosumi-git-import-",
  });
  const requests: Request[] = [];
  try {
    const bundlePath = join(root, "takos-export.bundle.json");
    await Deno.writeTextFile(
      bundlePath,
      `${JSON.stringify(EXPORT_BUNDLE, null, 2)}\n`,
    );

    const result = await applyImport({
      bundlePath,
      accountsUrl: "https://accounts.target.test/",
      token: "accounts-token",
      targetIssuer: "https://accounts.target.test",
      accountId: "acct_target",
      spaceId: "space_target",
      createdBySubject: "tsub_target",
      targetInstallationId: "inst_target",
      mode: "self-hosted",
      idempotencyKey: "idem-import",
      json: true,
      fetch: (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Promise.resolve(Response.json({
          installation: {
            id: "inst_target",
            mode: "self-hosted",
            status: "installing",
          },
          import_plan: {
            bundle_kind: "takosumi.accounts.installation-export-bundle@v1",
            source_issuer: "https://accounts.source.test",
            target_issuer: "https://accounts.target.test",
          },
        }, { status: 202 }));
      },
    });

    assertEquals(result.response.status, 202);
    assertEquals(result.accounts.installationId, "inst_target");
    assertEquals(
      result.importPlan?.target_issuer,
      "https://accounts.target.test",
    );
    assertEquals(
      requests[0].url,
      "https://accounts.target.test/v1/installations/import",
    );
    assertEquals(requests[0].method, "POST");
    assertEquals(
      requests[0].headers.get("authorization"),
      "Bearer accounts-token",
    );
    assertEquals(requests[0].headers.get("idempotency-key"), "idem-import");
    const body = await requests[0].json();
    assertEquals(
      body.bundle.kind,
      "takosumi.accounts.installation-export-bundle@v1",
    );
    assertEquals(body.targetAccountId, "acct_target");
    assertEquals(body.targetSpaceId, "space_target");
    assertEquals(body.createdBySubject, "tsub_target");
    assertEquals(body.targetIssuer, "https://accounts.target.test");
    assertEquals(body.targetInstallationId, "inst_target");
    assertEquals(body.mode, "self-hosted");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("applyImport rejects unsupported bundle kind", async () => {
  const root = await Deno.makeTempDir({
    prefix: "takosumi-git-import-",
  });
  try {
    const bundlePath = join(root, "takos-export.bundle.json");
    await Deno.writeTextFile(
      bundlePath,
      `${JSON.stringify({ kind: "other" })}\n`,
    );

    await assertRejects(
      () =>
        applyImport({
          bundlePath,
          accountsUrl: "https://accounts.target.test",
          accountId: "acct_target",
          spaceId: "space_target",
          createdBySubject: "tsub_target",
          json: true,
        }),
      Error,
      "unsupported export bundle kind",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("applyImport surfaces Accounts import errors", async () => {
  const root = await Deno.makeTempDir({
    prefix: "takosumi-git-import-",
  });
  try {
    const bundlePath = join(root, "takos-export.bundle.json");
    await Deno.writeTextFile(
      bundlePath,
      `${JSON.stringify(EXPORT_BUNDLE)}\n`,
    );

    await assertRejects(
      () =>
        applyImport({
          bundlePath,
          accountsUrl: "https://accounts.target.test",
          accountId: "acct_target",
          spaceId: "space_target",
          createdBySubject: "tsub_target",
          json: true,
          fetch: () =>
            Promise.resolve(
              Response.json({ error: "invalid_import_bundle" }, {
                status: 400,
              }),
            ),
        }),
      ImportApplyError,
      "HTTP 400",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
