import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  applyInstall,
  buildInstallPreview,
  compileInstallManifest,
  InstallableAppValidationError,
  InstallApplyError,
  parseInstallableAppYaml,
  parseInstallArgs,
  previewInstall,
  runInstallCli,
} from "./install.ts";

const VALID_APP_YML = `apiVersion: app.takosumi.dev/v1
kind: InstallableApp
metadata:
  id: example.hello
  name: Hello
  description: Minimal example app
  publisher: example
  homepage: https://example.com
  signingKeyFingerprint: SHA256:abcd
source:
  git: https://github.com/example/hello
  ref: v1.2.3
entry:
  manifest: .takosumi/manifest.yml
runtime:
  modes:
    - shared-cell
    - dedicated
bindings:
  auth:
    type: identity.oidc@v1
    required: true
    redirectPaths:
      - /auth/oidc/callback
    allowedScopes:
      - openid
      - profile
  database:
    type: database.postgres@v1
    required: true
    plan: nano
  blob:
    type: object-store.s3-compatible@v1
    required: false
    plan: standard
  bootstrap:
    type: install-launch-token@v1
    required: true
    consumePath: /_takosumi/launch
install:
  healthcheckPath: /health
  postInstallLaunchPath: /_takosumi/launch
permissions:
  requested:
    - app.profile.write
    - logs.read.own
upgrade:
  policy:
    securityPatch: automatic
    minor: ask
    major: manual
compatibility:
  takosumi-git: ">=0.4.0"
  kernel: ">=1.0.0"
`;

const MANIFEST_YML = `apiVersion: "1.0"
kind: Manifest
metadata:
  name: hello
resources: []
`;

const PINNED_APP_YML = VALID_APP_YML.replace(
  "ref: v1.2.3",
  "ref: v1.2.3\n  commit: 0123456789abcdef0123456789abcdef01234567",
);

const SERVICE_IMPORT_APP_YML = VALID_APP_YML.replace(
  "install:\n",
  `  account-auth:
    type: service.import@v1
    service: takosumi.account.auth@v1
    alias: account-auth
    endpointRoles:
      - oidc-issuer
      - install-launch
    refreshPolicy:
      kind: ttl
      ttl: 300s
install:\n`,
);

Deno.test("parseInstallableAppYaml accepts InstallableApp v1", () => {
  const app = parseInstallableAppYaml(VALID_APP_YML);

  assertEquals(app.metadata.id, "example.hello");
  assertEquals(app.source.git, "https://github.com/example/hello");
  assertEquals(app.runtime.modes, ["shared-cell", "dedicated"]);
  assertEquals(app.bindings.auth.type, "identity.oidc@v1");
  assertEquals(app.bindings.database.type, "database.postgres@v1");
  assertEquals(app.permissions.requested, [
    "app.profile.write",
    "logs.read.own",
  ]);

  const preview = buildInstallPreview(app);
  assertEquals(preview.kind, "takosumi-git.install-preview@v1");
  assertEquals(preview.publisher.verified, true);
  assertEquals(preview.source.pinned, true);
  assertEquals(preview.bindings.map((binding) => binding.name), [
    "auth",
    "blob",
    "bootstrap",
    "database",
  ]);
  assert(preview.permissionDigest.startsWith("sha256:"));
});

Deno.test("parseInstallableAppYaml accepts service import bindings", () => {
  const app = parseInstallableAppYaml(
    VALID_APP_YML.replace(
      "install:\n",
      `  account-auth:
    type: service.import@v1
    service: takosumi.account.auth@v1
    alias: account-auth
    endpointRoles:
      - oidc-issuer
      - install-launch
    refreshPolicy:
      kind: ttl
      ttl: 300s
install:\n`,
    ),
  );

  assertEquals(app.bindings["account-auth"], {
    type: "service.import@v1",
    required: true,
    service: "takosumi.account.auth@v1",
    alias: "account-auth",
    endpointRoles: ["oidc-issuer", "install-launch"],
    refreshPolicy: { kind: "ttl", ttl: "300s" },
  });
  const preview = buildInstallPreview(app);
  assertEquals(preview.serviceImports, [{
    binding: "account-auth",
    alias: "account-auth",
    service: "takosumi.account.auth@v1",
    endpointRoles: ["oidc-issuer", "install-launch"],
    refreshPolicy: { kind: "ttl", ttl: "300s" },
  }]);
});

Deno.test("compileInstallManifest injects service imports from app bindings", () => {
  const app = parseInstallableAppYaml(SERVICE_IMPORT_APP_YML);
  const compiled = compileInstallManifest(app, MANIFEST_YML);

  assert(compiled.digest.startsWith("sha256:"));
  assertEquals(compiled.serviceImports, [{
    alias: "account-auth",
    service: "takosumi.account.auth@v1",
    refreshPolicy: { kind: "ttl", ttl: "300s" },
  }]);
  assertEquals(compiled.manifest.imports, [{
    alias: "account-auth",
    service: "takosumi.account.auth@v1",
    refreshPolicy: { kind: "ttl", ttl: "300s" },
  }]);
});

Deno.test("compileInstallManifest rejects conflicting manifest imports", () => {
  const app = parseInstallableAppYaml(SERVICE_IMPORT_APP_YML);

  assertThrows(
    () =>
      compileInstallManifest(
        app,
        MANIFEST_YML.replace(
          "resources: []",
          `imports:
  - alias: account-auth
    service: takosumi.account.billing@v1
resources: []`,
        ),
      ),
    Error,
    "conflicts with app.yml binding",
  );
});

Deno.test("parseInstallableAppYaml rejects unknown fields and mutable refs", () => {
  const error = assertThrows(
    () =>
      parseInstallableAppYaml(
        VALID_APP_YML.replace("ref: v1.2.3", "ref: main") +
          "\nextra: nope\n",
      ),
    InstallableAppValidationError,
  );

  assertStringIncludes(error.message, "source.ref looks mutable: main");
  assertStringIncludes(error.message, "$.extra is not allowed");
});

Deno.test("parseInstallableAppYaml rejects unsupported binding catalog entries", () => {
  const error = assertThrows(
    () =>
      parseInstallableAppYaml(
        VALID_APP_YML.replace(
          "type: database.postgres@v1",
          "type: database.mysql@v1",
        ),
      ),
    InstallableAppValidationError,
  );

  assertStringIncludes(
    error.message,
    "bindings.database.type must be one of the v1 binding catalog identifiers",
  );
});

Deno.test("parseInstallableAppYaml rejects malformed service import bindings", () => {
  const error = assertThrows(
    () =>
      parseInstallableAppYaml(
        VALID_APP_YML.replace(
          "install:\n",
          `  account-auth:
    type: service.import@v1
    service: takosumi.account.auth.oidc@v1
    endpointRoles:
      - OIDC
    refreshPolicy:
      kind: ttl
      ttl: five-minutes
install:\n`,
        ),
      ),
    InstallableAppValidationError,
  );

  assertStringIncludes(
    error.message,
    "bindings.account-auth.service must be a forward 3-level service identifier",
  );
  assertStringIncludes(
    error.message,
    "bindings.account-auth.endpointRoles must contain endpoint role identifiers",
  );
  assertStringIncludes(
    error.message,
    "bindings.account-auth.refreshPolicy.ttl must be a duration",
  );
});

Deno.test("previewInstall reads app and kernel manifests", async () => {
  const root = await Deno.makeTempDir({ prefix: "takosumi-git-install-" });
  try {
    await Deno.mkdir(join(root, ".takosumi"));
    await Deno.writeTextFile(join(root, ".takosumi", "app.yml"), VALID_APP_YML);
    await Deno.writeTextFile(
      join(root, ".takosumi", "manifest.yml"),
      MANIFEST_YML,
    );

    const preview = await previewInstall({
      subcommand: "preview",
      cwd: root,
      appPath: join(root, ".takosumi", "app.yml"),
      json: true,
    });

    assert(preview.source.appManifestDigest?.startsWith("sha256:"));
    assert(preview.source.compiledManifestDigest?.startsWith("sha256:"));
    assertEquals(preview.compatibility.warnings, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("previewInstall warns when entry manifest is absent", async () => {
  const root = await Deno.makeTempDir({ prefix: "takosumi-git-install-" });
  try {
    await Deno.mkdir(join(root, ".takosumi"));
    await Deno.writeTextFile(join(root, ".takosumi", "app.yml"), VALID_APP_YML);

    const preview = await previewInstall({
      subcommand: "preview",
      cwd: root,
      appPath: join(root, ".takosumi", "app.yml"),
      json: true,
    });

    assertEquals(preview.source.compiledManifestDigest, undefined);
    assertStringIncludes(
      preview.compatibility.warnings.join("\n"),
      "entry manifest not found",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runInstallCli prints preview JSON", async () => {
  const root = await Deno.makeTempDir({ prefix: "takosumi-git-install-" });
  const originalStdoutWrite = Deno.stdout.writeSync.bind(Deno.stdout);
  const originalStderrWrite = Deno.stderr.writeSync.bind(Deno.stderr);
  const stdout: string[] = [];
  const stderr: string[] = [];
  (Deno.stdout as { writeSync: (p: Uint8Array) => number }).writeSync = (
    p: Uint8Array,
  ) => {
    stdout.push(new TextDecoder().decode(p));
    return p.byteLength;
  };
  (Deno.stderr as { writeSync: (p: Uint8Array) => number }).writeSync = (
    p: Uint8Array,
  ) => {
    stderr.push(new TextDecoder().decode(p));
    return p.byteLength;
  };
  try {
    await Deno.mkdir(join(root, ".takosumi"));
    await Deno.writeTextFile(join(root, ".takosumi", "app.yml"), VALID_APP_YML);
    const code = await runInstallCli(["preview", "--cwd", root, "--json"]);

    assertEquals(code, 0);
    assertEquals(stderr.join(""), "");
    const parsed = JSON.parse(stdout.join(""));
    assertEquals(parsed.app.id, "example.hello");
    assertEquals(parsed.source.pinned, true);
  } finally {
    (Deno.stdout as { writeSync: (p: Uint8Array) => number }).writeSync =
      originalStdoutWrite;
    (Deno.stderr as { writeSync: (p: Uint8Array) => number }).writeSync =
      originalStderrWrite;
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("parseInstallArgs reads apply options from env", () => {
  const parsed = parseInstallArgs([
    "apply",
    "--mode",
    "dedicated",
    "--source-commit",
    "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
  ], {
    get(key: string) {
      const env: Record<string, string> = {
        TAKOSUMI_ACCOUNTS_URL: "http://accounts.example",
        TAKOS_ACCOUNT_ID: "acct_1",
        TAKOS_SPACE_ID: "space_1",
        TAKOSUMI_SUBJECT: "tsub_owner",
        TAKOS_TOKEN: "secret",
        TAKOSUMI_RUNTIME_BASE_URL: "https://hello.example",
      };
      return env[key];
    },
  });

  assertEquals(parsed.subcommand, "apply");
  assertEquals(parsed.accountsUrl, "http://accounts.example");
  assertEquals(parsed.accountId, "acct_1");
  assertEquals(parsed.spaceId, "space_1");
  assertEquals(parsed.createdBySubject, "tsub_owner");
  assertEquals(parsed.token, "secret");
  assertEquals(parsed.mode, "dedicated");
  assertEquals(parsed.sourceCommit, "abcdefabcdefabcdefabcdefabcdefabcdefabcd");
  assertEquals(parsed.runtimeBaseUrl, "https://hello.example");
});

Deno.test("applyInstall posts AppInstallation create request", async () => {
  const root = await Deno.makeTempDir({ prefix: "takosumi-git-install-" });
  const requests: Request[] = [];
  try {
    await Deno.mkdir(join(root, ".takosumi"));
    await Deno.writeTextFile(
      join(root, ".takosumi", "app.yml"),
      PINNED_APP_YML,
    );
    await Deno.writeTextFile(
      join(root, ".takosumi", "manifest.yml"),
      MANIFEST_YML,
    );

    const result = await applyInstall({
      subcommand: "apply",
      cwd: root,
      appPath: join(root, ".takosumi", "app.yml"),
      json: true,
      accountsUrl: "http://accounts.example/",
      token: "secret",
      accountId: "acct_1",
      spaceId: "space_1",
      createdBySubject: "tsub_owner",
      mode: "shared-cell",
      fetch: (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(Response.json({
          installation: { id: "inst_1" },
        }, { status: 202 }));
      },
    });

    assertEquals(result.response.status, 202);
    assertEquals(requests.length, 1);
    assertEquals(requests[0].url, "http://accounts.example/v1/installations");
    assertEquals(requests[0].headers.get("authorization"), "Bearer secret");
    const body = await requests[0].json();
    assertEquals(body.accountId, "acct_1");
    assertEquals(body.spaceId, "space_1");
    assertEquals(body.appId, "example.hello");
    assertEquals(body.mode, "shared-cell");
    assertEquals(
      body.source.commit,
      "0123456789abcdef0123456789abcdef01234567",
    );
    assertEquals(body.bindings.length, 4);
    assertEquals(
      body.bindings.map((binding: { name: string }) => binding.name),
      [
        "auth",
        "blob",
        "bootstrap",
        "database",
      ],
    );
    assertEquals(body.bindings[0].kind, "identity.oidc@v1");
    assertStringIncludes(
      body.bindings[0].configRef,
      "takosumi-git://installable-app/example.hello/bindings/auth/sha256:",
    );
    assertEquals(body.bindings[0].secretRefs, []);
    assertEquals(body.serviceImports, []);
    assertEquals(body.oidcClients, undefined);
    assertEquals(body.grants.length, 2);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("applyInstall posts service import materialization plan", async () => {
  const root = await Deno.makeTempDir({ prefix: "takosumi-git-install-" });
  const requests: Request[] = [];
  try {
    await Deno.mkdir(join(root, ".takosumi"));
    await Deno.writeTextFile(
      join(root, ".takosumi", "app.yml"),
      SERVICE_IMPORT_APP_YML.replace(
        "ref: v1.2.3",
        "ref: v1.2.3\n  commit: 0123456789abcdef0123456789abcdef01234567",
      ),
    );
    await Deno.writeTextFile(
      join(root, ".takosumi", "manifest.yml"),
      MANIFEST_YML,
    );

    const result = await applyInstall({
      subcommand: "apply",
      cwd: root,
      appPath: join(root, ".takosumi", "app.yml"),
      json: true,
      accountsUrl: "http://accounts.example/",
      accountId: "acct_1",
      spaceId: "space_1",
      createdBySubject: "tsub_owner",
      runtimeBaseUrl: "http://localhost:8787",
      fetch: (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(Response.json({
          installation: { id: "inst_1" },
        }, { status: 202 }));
      },
    });

    assertEquals(
      result.preview.serviceImports[0].service,
      "takosumi.account.auth@v1",
    );
    const body = await requests[0].json();
    assertEquals(body.serviceImports, [{
      binding: "account-auth",
      alias: "account-auth",
      service: "takosumi.account.auth@v1",
      endpointRoles: ["oidc-issuer", "install-launch"],
      refreshPolicy: { kind: "ttl", ttl: "300s" },
    }]);
    assertEquals(
      body.bindings.some((binding: { kind: string }) =>
        binding.kind === "service.import@v1"
      ),
      true,
    );
    assertEquals(body.oidcClients, [{
      binding: "auth",
      serviceId: "takosumi.account.auth@v1",
      redirectUris: ["http://localhost:8787/auth/oidc/callback"],
      allowedScopes: ["openid", "profile"],
      subjectMode: "pairwise",
    }]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("applyInstall requires a pinned source commit", async () => {
  const root = await Deno.makeTempDir({ prefix: "takosumi-git-install-" });
  try {
    await Deno.mkdir(join(root, ".takosumi"));
    await Deno.writeTextFile(join(root, ".takosumi", "app.yml"), VALID_APP_YML);

    await assertRejects(
      () =>
        applyInstall({
          subcommand: "apply",
          cwd: root,
          appPath: join(root, ".takosumi", "app.yml"),
          json: true,
          accountsUrl: "http://accounts.example",
          accountId: "acct_1",
          spaceId: "space_1",
          createdBySubject: "tsub_owner",
        }),
      Error,
      "source.commit is required",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("applyInstall accepts resolver-provided source commit", async () => {
  const root = await Deno.makeTempDir({ prefix: "takosumi-git-install-" });
  const requests: Request[] = [];
  try {
    await Deno.mkdir(join(root, ".takosumi"));
    await Deno.writeTextFile(join(root, ".takosumi", "app.yml"), VALID_APP_YML);

    await applyInstall({
      subcommand: "apply",
      cwd: root,
      appPath: join(root, ".takosumi", "app.yml"),
      json: true,
      accountsUrl: "http://accounts.example",
      accountId: "acct_1",
      spaceId: "space_1",
      createdBySubject: "tsub_owner",
      sourceCommit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      fetch: (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(Response.json({
          installation: { id: "inst_1" },
        }, { status: 202 }));
      },
    });

    const body = await requests[0].json();
    assertEquals(body.source.ref, "v1.2.3");
    assertEquals(
      body.source.commit,
      "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("applyInstall surfaces Accounts errors", async () => {
  const root = await Deno.makeTempDir({ prefix: "takosumi-git-install-" });
  try {
    await Deno.mkdir(join(root, ".takosumi"));
    await Deno.writeTextFile(
      join(root, ".takosumi", "app.yml"),
      PINNED_APP_YML,
    );

    await assertRejects(
      () =>
        applyInstall({
          subcommand: "apply",
          cwd: root,
          appPath: join(root, ".takosumi", "app.yml"),
          json: true,
          accountsUrl: "http://accounts.example",
          accountId: "acct_1",
          spaceId: "space_1",
          createdBySubject: "tsub_owner",
          fetch: () =>
            Promise.resolve(Response.json({ error: "nope" }, { status: 409 })),
        }),
      InstallApplyError,
      "HTTP 409",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runInstallCli returns usage error for invalid app.yml", async () => {
  const root = await Deno.makeTempDir({ prefix: "takosumi-git-install-" });
  const originalStderrWrite = Deno.stderr.writeSync.bind(Deno.stderr);
  (Deno.stderr as { writeSync: (p: Uint8Array) => number }).writeSync = (
    p: Uint8Array,
  ) => p.byteLength;
  try {
    await Deno.mkdir(join(root, ".takosumi"));
    await Deno.writeTextFile(
      join(root, ".takosumi", "app.yml"),
      VALID_APP_YML.replace("kind: InstallableApp", "kind: Other"),
    );

    const code = await runInstallCli(["preview", "--cwd", root, "--json"]);
    assertEquals(code, 64);
  } finally {
    (Deno.stderr as { writeSync: (p: Uint8Array) => number }).writeSync =
      originalStderrWrite;
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("previewInstall rejects missing app.yml", async () => {
  await assertRejects(
    () =>
      previewInstall({
        subcommand: "preview",
        cwd: ".",
        appPath: ".takosumi/app.yml",
        json: true,
      }),
    Deno.errors.NotFound,
  );
});
