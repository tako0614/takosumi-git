import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { parseRevisionArgs, runRevision } from "./revision.ts";

const APP_YML_V124 = `apiVersion: app.takosumi.dev/v1
kind: InstallableApp
metadata:
  id: example.hello
  name: Hello
  description: Minimal example app
  publisher: example
  homepage: https://example.com
source:
  git: https://github.com/example/hello
  ref: v1.2.4
entry:
  manifest: .takosumi/manifest.yml
runtime:
  modes:
    - shared-cell
bindings:
  bootstrap:
    type: install-launch-token@v1
    required: true
    consumePath: /_takosumi/launch
install:
  healthcheckPath: /health
  postInstallLaunchPath: /_takosumi/launch
permissions:
  requested:
    - logs.read.own
    - files:read
`;

const APP_YML_V123 = APP_YML_V124
  .replace("ref: v1.2.4", "ref: v1.2.3")
  .replace("    - files:read\n", "");

const MANIFEST_YML = `apiVersion: "1.0"
kind: Manifest
metadata:
  name: hello
resources: []
`;

Deno.test("parseRevisionArgs reads upgrade options from env", () => {
  const parsed = parseRevisionArgs("upgrade", [
    "inst_1",
    "--ref",
    "v1.2.4",
  ], {
    get(key: string) {
      const env: Record<string, string> = {
        TAKOSUMI_ACCOUNTS_URL: "http://accounts.example",
        TAKOS_TOKEN: "secret",
      };
      return env[key];
    },
  });

  assertEquals(parsed.operation, "upgrade");
  assertEquals(parsed.installationId, "inst_1");
  assertEquals(parsed.targetRef, "v1.2.4");
  assertEquals(parsed.accountsUrl, "http://accounts.example");
  assertEquals(parsed.token, "secret");
});

Deno.test("parseRevisionArgs reads rollback target from --to", () => {
  const parsed = parseRevisionArgs("rollback", [
    "inst_1",
    "--to",
    "v1.2.3",
    "--accounts-url",
    "http://accounts.example",
  ]);

  assertEquals(parsed.operation, "rollback");
  assertEquals(parsed.installationId, "inst_1");
  assertEquals(parsed.targetRef, "v1.2.3");
  assertEquals(parsed.accountsUrl, "http://accounts.example");
});

Deno.test("runRevision previews and applies an upgrade revision", async () => {
  const checkoutRoot = await Deno.makeTempDir({
    prefix: "takosumi-git-revision-",
  });
  const requests: Request[] = [];
  try {
    await Deno.mkdir(join(checkoutRoot, ".takosumi"));
    await Deno.writeTextFile(
      join(checkoutRoot, ".takosumi", "app.yml"),
      APP_YML_V124,
    );
    await Deno.writeTextFile(
      join(checkoutRoot, ".takosumi", "manifest.yml"),
      MANIFEST_YML,
    );

    const result = await runRevision({
      operation: "upgrade",
      installationId: "inst_1",
      targetRef: "v1.2.4",
      cwd: "/unused",
      appPath: "/unused/.takosumi/app.yml",
      appPathSpec: ".takosumi/app.yml",
      manifestPathSpec: ".takosumi/manifest.yml",
      accountsUrl: "http://accounts.example/",
      token: "secret",
      apply: true,
      json: true,
      checkoutSource: (request) => {
        assertEquals(request, {
          gitUrl: "https://github.com/example/hello",
          ref: "v1.2.4",
        });
        return Promise.resolve({
          root: checkoutRoot,
          commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          cleanup: () => Promise.resolve(),
        });
      },
      fetch: (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "POST") {
          return Promise.resolve(Response.json({
            operation: "upgrade",
            installation: { id: "inst_1" },
          }));
        }
        return Promise.resolve(Response.json({
          installation: {
            id: "inst_1",
            app_id: "example.hello",
            source: {
              url: "https://github.com/example/hello",
              ref: "v1.2.3",
              commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
            app_manifest_digest: "sha256:old-app",
            compiled_manifest_digest: "sha256:old-compiled",
            status: "ready",
          },
          bindings: [{
            name: "bootstrap",
            kind: "install-launch-token@v1",
          }],
          grants: [{
            capability: "logs.read.own",
            revoked_at: null,
          }],
        }));
      },
    });

    assertEquals(result.preview.diff.permissions.added, ["files:read"]);
    assertEquals(result.preview.diff.permissions.unchanged, ["logs.read.own"]);
    assertEquals(result.preview.diff.bindings.added, []);
    assertEquals(result.response?.status, 200);
    assertEquals(requests.length, 2);
    assertEquals(
      requests[0].url,
      "http://accounts.example/v1/installations/inst_1",
    );
    assertEquals(
      requests[1].url,
      "http://accounts.example/v1/installations/inst_1/upgrade",
    );
    assertEquals(requests[1].headers.get("authorization"), "Bearer secret");
    const body = await requests[1].json();
    assertEquals(body.source.ref, "v1.2.4");
    assertEquals(
      body.source.commit,
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    assertEquals(body.grants, [{
      capability: "files:read",
      scope: { type: "single-installation", appId: "example.hello" },
    }]);
  } finally {
    await Deno.remove(checkoutRoot, { recursive: true }).catch(() => {});
  }
});

Deno.test("runRevision previews and applies a rollback revision", async () => {
  const checkoutRoot = await Deno.makeTempDir({
    prefix: "takosumi-git-revision-rollback-",
  });
  const requests: Request[] = [];
  try {
    await Deno.mkdir(join(checkoutRoot, ".takosumi"));
    await Deno.writeTextFile(
      join(checkoutRoot, ".takosumi", "app.yml"),
      APP_YML_V123,
    );
    await Deno.writeTextFile(
      join(checkoutRoot, ".takosumi", "manifest.yml"),
      MANIFEST_YML,
    );

    const result = await runRevision({
      operation: "rollback",
      installationId: "inst_1",
      targetRef: "v1.2.3",
      cwd: "/unused",
      appPath: "/unused/.takosumi/app.yml",
      appPathSpec: ".takosumi/app.yml",
      manifestPathSpec: ".takosumi/manifest.yml",
      accountsUrl: "http://accounts.example/",
      apply: true,
      json: true,
      reason: "operator rollback",
      checkoutSource: (request) => {
        assertEquals(request, {
          gitUrl: "https://github.com/example/hello",
          ref: "v1.2.3",
        });
        return Promise.resolve({
          root: checkoutRoot,
          commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          cleanup: () => Promise.resolve(),
        });
      },
      fetch: (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "POST") {
          return Promise.resolve(Response.json({
            operation: "rollback",
            installation: { id: "inst_1" },
          }));
        }
        return Promise.resolve(Response.json({
          installation: {
            id: "inst_1",
            app_id: "example.hello",
            source: {
              url: "https://github.com/example/hello",
              ref: "v1.2.4",
              commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            },
            app_manifest_digest: "sha256:app-v124",
            compiled_manifest_digest: "sha256:compiled-v124",
            status: "ready",
          },
          bindings: [{
            name: "bootstrap",
            kind: "install-launch-token@v1",
          }],
          grants: [{
            capability: "logs.read.own",
            revoked_at: null,
          }, {
            capability: "files:read",
            revoked_at: null,
          }],
        }));
      },
    });

    assertEquals(result.preview.operation, "rollback");
    assertEquals(result.preview.diff.permissions.removed, ["files:read"]);
    assertEquals(result.preview.diff.permissions.unchanged, ["logs.read.own"]);
    assertEquals(result.response?.status, 200);
    assertEquals(requests.length, 2);
    assertEquals(
      requests[1].url,
      "http://accounts.example/v1/installations/inst_1/rollback",
    );
    const body = await requests[1].json();
    assertEquals(body.source.ref, "v1.2.3");
    assertEquals(
      body.source.commit,
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    assertEquals(body.reason, "operator rollback");
    assertEquals(body.grants, []);
  } finally {
    await Deno.remove(checkoutRoot, { recursive: true }).catch(() => {});
  }
});
