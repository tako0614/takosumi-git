import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
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
  runtimeBinding: null,
  oidcClient: {
    clientId: "toc_source",
    binding: "auth",
    namespacePath: "operator.identity.oidc",
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
    "--identity",
    "identity-a.txt,identity-b.txt",
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
  assertStringIncludes(parsed.identities?.[0] ?? "", "identity-a.txt");
  assertStringIncludes(parsed.identities?.[1] ?? "", "identity-b.txt");
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

Deno.test("parseImportArgs accepts tar.zst export bundle path", () => {
  const parsed = parseImportArgs([
    "takos-export.tar.zst",
    "--to",
    "https://accounts.target.test",
    "--account-id",
    "acct_target",
    "--space-id",
    "space_target",
    "--subject",
    "tsub_target",
  ]);

  assertStringIncludes(parsed.bundlePath, "takos-export.tar.zst");
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

Deno.test("applyImport reads bundle JSON from tar.zst archive", async () => {
  const root = await Deno.makeTempDir({
    prefix: "takosumi-git-import-",
  });
  const requests: Request[] = [];
  try {
    const sourceRoot = join(root, "src");
    await Deno.mkdir(join(sourceRoot, "takos-export"), { recursive: true });
    await Deno.writeTextFile(
      join(sourceRoot, "takos-export", "bundle.json"),
      `${JSON.stringify(EXPORT_BUNDLE, null, 2)}\n`,
    );
    await Deno.writeTextFile(
      join(sourceRoot, "takos-export", "docs-restore-placeholder.txt"),
      "restore docs placeholder\n",
    );
    const bundlePath = join(root, "takos-export.tar.zst");
    await assertCommandOk(
      new Deno.Command("tar", {
        args: [
          "--use-compress-program=zstd",
          "-cf",
          bundlePath,
          "-C",
          sourceRoot,
          "takos-export",
        ],
      }),
    );

    const result = await applyImport({
      bundlePath,
      accountsUrl: "https://accounts.target.test/",
      accountId: "acct_target",
      spaceId: "space_target",
      createdBySubject: "tsub_target",
      json: true,
      fetch: (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(Response.json({
          installation: {
            id: "inst_target",
          },
          import_plan: {
            target_issuer: "https://accounts.target.test",
          },
        }, { status: 202 }));
      },
    });

    assertEquals(result.accounts.installationId, "inst_target");
    const body = await requests[0].json();
    assertEquals(
      body.bundle.kind,
      "takosumi.accounts.installation-export-bundle@v1",
    );
    assertEquals(
      body.bundle.source.commit,
      "0123456789abcdef0123456789abcdef01234567",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("applyImport reports data entries that current import API ignores", async () => {
  const root = await Deno.makeTempDir({
    prefix: "takosumi-git-import-data-",
  });
  try {
    const sourceRoot = join(root, "src");
    await Deno.mkdir(join(sourceRoot, "takos-export", "data", "postgres"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(sourceRoot, "takos-export", "bundle.json"),
      `${JSON.stringify(EXPORT_BUNDLE, null, 2)}\n`,
    );
    await Deno.writeTextFile(
      join(sourceRoot, "takos-export", "data", "manifest.json"),
      `${
        JSON.stringify(
          {
            kind: "takosumi.accounts.installation-export-data-manifest@v1",
            version: "v1",
            files: [{
              path: "takos-export/data/postgres/dump.sql",
              mediaType: "application/sql",
              byteLength: 10,
            }],
          },
          null,
          2,
        )
      }\n`,
    );
    await Deno.writeTextFile(
      join(sourceRoot, "takos-export", "data", "postgres", "dump.sql"),
      "select 1;\n",
    );
    const bundlePath = join(root, "takos-export.tar.zst");
    await assertCommandOk(
      new Deno.Command("tar", {
        args: [
          "--use-compress-program=zstd",
          "-cf",
          bundlePath,
          "-C",
          sourceRoot,
          "takos-export",
        ],
      }),
    );

    const result = await applyImport({
      bundlePath,
      accountsUrl: "https://accounts.target.test/",
      accountId: "acct_target",
      spaceId: "space_target",
      createdBySubject: "tsub_target",
      json: true,
      fetch: () =>
        Promise.resolve(Response.json({
          installation: {
            id: "inst_target",
          },
        }, { status: 202 })),
    });

    assertEquals(result.accounts.installationId, "inst_target");
    assertEquals(result.ignoredDataEntries, [
      "takos-export/data/manifest.json",
      "takos-export/data/postgres/dump.sql",
    ]);
    assertEquals(
      (result.request.bundle as { kind: string }).kind,
      "takosumi.accounts.installation-export-bundle@v1",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("applyImport decrypts age-wrapped tar.zst archive with identity", async () => {
  const root = await Deno.makeTempDir({
    prefix: "takosumi-git-import-age-",
  });
  const requests: Request[] = [];
  try {
    const sourceRoot = join(root, "src");
    await Deno.mkdir(join(sourceRoot, "takos-export"), { recursive: true });
    await Deno.writeTextFile(
      join(sourceRoot, "takos-export", "bundle.json"),
      `${JSON.stringify(EXPORT_BUNDLE, null, 2)}\n`,
    );
    const clearPath = join(root, "takos-export.tar.zst");
    await assertCommandOk(
      new Deno.Command("tar", {
        args: [
          "--use-compress-program=zstd",
          "-cf",
          clearPath,
          "-C",
          sourceRoot,
          "takos-export",
        ],
      }),
    );
    const encryptedPath = join(root, "takos-export.tar.zst.age");
    await Deno.copyFile(clearPath, encryptedPath);
    const identityPath = join(root, "identity.txt");
    await Deno.writeTextFile(identityPath, "AGE-SECRET-KEY-test\n");
    const ageExecutable = await writeFakeAgeExecutable(root);

    const result = await applyImport({
      bundlePath: encryptedPath,
      accountsUrl: "https://accounts.target.test/",
      accountId: "acct_target",
      spaceId: "space_target",
      createdBySubject: "tsub_target",
      identities: [identityPath],
      ageExecutable,
      json: true,
      fetch: (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(Response.json({
          installation: {
            id: "inst_target",
          },
          import_plan: {
            target_issuer: "https://accounts.target.test",
          },
        }, { status: 202 }));
      },
    });

    assertEquals(result.accounts.installationId, "inst_target");
    const body = await requests[0].json();
    assertEquals(
      body.bundle.kind,
      "takosumi.accounts.installation-export-bundle@v1",
    );
    assertEquals(
      body.bundle.source.commit,
      "0123456789abcdef0123456789abcdef01234567",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("applyImport rejects encrypted export bundle without identity", async () => {
  const root = await Deno.makeTempDir({
    prefix: "takosumi-git-import-age-",
  });
  try {
    const bundlePath = join(root, "takos-export.tar.zst.age");
    await Deno.writeTextFile(bundlePath, "encrypted placeholder\n");
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
      "requires --identity",
    );
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

async function assertCommandOk(command: Deno.Command): Promise<void> {
  const output = await command.output();
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr));
  }
}

async function writeFakeAgeExecutable(root: string): Promise<string> {
  const path = join(root, "fake-age.sh");
  await Deno.writeTextFile(
    path,
    `#!/bin/sh
set -eu
out=""
input=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      shift
      out="$1"
      ;;
    -r|-i)
      shift
      ;;
    -d)
      ;;
    *)
      input="$1"
      ;;
  esac
  shift
done
cp "$input" "$out"
`,
  );
  await Deno.chmod(path, 0o755);
  return path;
}

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
