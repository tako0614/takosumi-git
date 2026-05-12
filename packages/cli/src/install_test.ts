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

const FORBIDDEN_SERVICE_IMPORT_APP_YML = VALID_APP_YML.replace(
  "install:\n",
  `serviceImports:
  - binding: account-auth
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

const WORKFLOW_APP_YML = `apiVersion: app.takosumi.dev/v1
kind: InstallableApp
metadata:
  id: example.workflow
  name: Workflow App
  description: App with a workflowRef-backed runtime image
  publisher: example
  homepage: https://example.com
source:
  git: https://github.com/example/workflow
  ref: v1.2.3
entry:
  manifest: .takosumi/manifest.yml
runtime:
  modes:
    - dedicated
bindings:
  auth:
    type: identity.oidc@v1
    required: true
    redirectPaths:
      - /auth/oidc/callback
install:
  healthcheckPath: /health
  postInstallLaunchPath: /_takosumi/launch
permissions:
  requested: []
`;

const WORKFLOW_MANIFEST_YML = `apiVersion: "1.0"
kind: Manifest
metadata:
  name: workflow
resources:
  - name: web
    shape: web-service@v1
    provider: "@takos/selfhost-docker-compose"
    spec:
      port: 8080
    workflowRef:
      file: build.yml
      job: image
      artifact: image
`;

const WORKFLOW_FILE_YML = `version: "0"
jobs:
  - name: image
    steps:
      - name: build
        run: echo build
    artifact:
      name: image
`;

const SECRET_PROBE_WORKFLOW_FILE_YML = `version: "0"
jobs:
  - name: image
    steps:
      - name: probe-env
        run: |
          if [ -n "$TAKOS_TOKEN$TAKOSUMI_DEPLOY_TOKEN$OIDC_CLIENT_SECRET$DATABASE_URL$AWS_ACCESS_KEY_ID$AWS_SECRET_ACCESS_KEY$GOOGLE_APPLICATION_CREDENTIALS$CLOUDFLARE_API_TOKEN" ]; then
            echo "leaked:$TAKOS_TOKEN:$TAKOSUMI_DEPLOY_TOKEN:$OIDC_CLIENT_SECRET:$DATABASE_URL:$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY:$GOOGLE_APPLICATION_CREDENTIALS:$CLOUDFLARE_API_TOKEN"
            exit 42
          fi
          echo "isolated"
          echo "TAKOSUMI_ARTIFACT=ghcr.io/example/workflow@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    artifact:
      name: image
`;

function restoreEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
}

function opaqueLaunchTokenConfig(
  overrides: {
    readonly accountsBaseUrl?: string;
    readonly installationId?: string;
    readonly redirectUri?: string;
    readonly consumePath?: string;
    readonly maxLifetimeSeconds?: number;
  } = {},
): Record<string, unknown> {
  const accountsBaseUrl = overrides.accountsBaseUrl ??
    "http://accounts.example";
  const installationId = overrides.installationId ?? "inst_1";
  const redirectUri = overrides.redirectUri ??
    "http://localhost:8787/_takosumi/launch";
  const consumePath = overrides.consumePath ?? "/_takosumi/launch";
  const maxLifetimeSeconds = overrides.maxLifetimeSeconds ?? 300;
  return {
    accountsBaseUrl,
    installationId,
    redirectUri,
    consumePath,
    maxLifetimeSeconds,
    env: {
      ACCOUNTS_BASE_URL: accountsBaseUrl,
      INSTALL_LAUNCH_INSTALLATION_ID: installationId,
      INSTALL_LAUNCH_REDIRECT_URI: redirectUri,
      INSTALL_LAUNCH_CONSUME_PATH: consumePath,
    },
  };
}

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
  assert(preview.previewId.startsWith("preview_"));
  assert(new Date(preview.expiresAt).getTime() > Date.now());
  assertEquals(preview.publisher.verified, true);
  assertEquals(preview.source.pinned, true);
  assertEquals(preview.bindings.map((binding) => binding.name), [
    "auth",
    "blob",
    "bootstrap",
    "database",
  ]);
  assert(preview.permissionDigest.startsWith("sha256:"));
  assertEquals(preview.risk.level, "medium");
  assertEquals(preview.approvalRequired, true);
});

Deno.test("buildInstallPreview records approval and risk metadata", () => {
  const app = parseInstallableAppYaml(VALID_APP_YML.replace(
    "  signingKeyFingerprint: SHA256:abcd\n",
    "",
  ));
  const preview = buildInstallPreview(app, {
    now: new Date("2026-05-11T00:00:00.000Z"),
  });

  assertEquals(preview.expiresAt, "2026-05-11T00:15:00.000Z");
  assertEquals(preview.publisher.verified, false);
  assertEquals(preview.risk.level, "high");
  assertEquals(
    preview.risk.reasons.includes("publisher is not verified"),
    true,
  );
  assertEquals(preview.approvalRequired, true);
});

Deno.test("parseInstallableAppYaml accepts Takos resource AppGrant scopes", () => {
  const app = parseInstallableAppYaml(
    VALID_APP_YML.replace(
      `    - app.profile.write
    - logs.read.own`,
      `    - files:read
    - files:write
    - threads:read
    - threads:write
    - runs:read
    - runs:write
    - agents:execute
    - repos:read
    - repos:write
    - mcp:invoke
    - events:subscribe`,
    ),
  );

  assertEquals(app.permissions.requested, [
    "files:read",
    "files:write",
    "threads:read",
    "threads:write",
    "runs:read",
    "runs:write",
    "agents:execute",
    "repos:read",
    "repos:write",
    "mcp:invoke",
    "events:subscribe",
  ]);
});

Deno.test("parseInstallableAppYaml rejects serviceImports metadata", () => {
  const error = assertThrows(
    () => parseInstallableAppYaml(FORBIDDEN_SERVICE_IMPORT_APP_YML),
    InstallableAppValidationError,
  );

  assertStringIncludes(error.message, "$.serviceImports is not allowed");
});

Deno.test("compileInstallManifest rejects forbidden kernel import fields", () => {
  const app = parseInstallableAppYaml(VALID_APP_YML);

  for (
    const [field, yaml] of [
      ["imports", "imports: []"],
      ["serviceResolvers", "serviceResolvers: []"],
      ["services", "services: []"],
    ] as const
  ) {
    assertThrows(
      () =>
        compileInstallManifest(
          app,
          MANIFEST_YML.replace("resources: []", `${yaml}\nresources: []`),
        ),
      Error,
      `entry manifest.${field} is forbidden`,
    );
  }
});

Deno.test("compileInstallManifest rejects direct manifest imports", () => {
  const app = parseInstallableAppYaml(VALID_APP_YML);
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
    "entry manifest.imports is forbidden",
  );
});

Deno.test("compileInstallManifest rejects unresolved installer placeholders", () => {
  const app = parseInstallableAppYaml(VALID_APP_YML);

  assertThrows(
    () =>
      compileInstallManifest(
        app,
        MANIFEST_YML.replace(
          "resources: []",
          `resources:
  - name: api
    shape: web-service@v1
    provider: "@takos/cloudflare-container"
    spec:
      env:
        OIDC_CLIENT_ID: "\${bindings.auth.clientId}"
        OIDC_CLIENT_SECRET: "\${secrets.auth.clientSecret}"`,
        ),
      ),
    Error,
    "unresolved installer placeholder",
  );
});

Deno.test("compileInstallManifest rejects removed imports placeholders", () => {
  const app = parseInstallableAppYaml(VALID_APP_YML);
  assertThrows(
    () =>
      compileInstallManifest(
        app,
        MANIFEST_YML.replace(
          "resources: []",
          `resources:
  - name: api
    shape: web-service@v1
    provider: "@takos/cloudflare-container"
    spec:
      upstream: "\${imports.account-auth.endpoints.oidc-issuer.url}"`,
        ),
      ),
    Error,
    "unresolved installer placeholder",
  );
});

Deno.test("compileInstallManifest rejects service import metadata", () => {
  const app = parseInstallableAppYaml(VALID_APP_YML);
  assertThrows(
    () =>
      compileInstallManifest(
        app,
        MANIFEST_YML.replace(
          "metadata:\n  name: hello",
          `metadata:
  name: sample-app
  takosumiServiceImports:
    account:
      service: takosumi.account.auth@v1`,
        ),
      ),
    Error,
    "metadata.takosumiServiceImports is forbidden",
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

Deno.test("parseInstallableAppYaml rejects serviceImports as unknown metadata", () => {
  const error = assertThrows(
    () =>
      parseInstallableAppYaml(
        VALID_APP_YML.replace(
          "install:\n",
          `serviceImports:
  - binding: account-auth
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

  assertStringIncludes(error.message, "$.serviceImports is not allowed");
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
    "--preview-id",
    "preview_0123456789abcdef01234567",
    "--permission-digest",
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "--cost-ack",
  ], {
    get(key: string) {
      const env: Record<string, string> = {
        TAKOSUMI_ACCOUNTS_URL: "http://accounts.example",
        TAKOS_ACCOUNT_ID: "acct_1",
        TAKOS_SPACE_ID: "space_1",
        TAKOSUMI_SUBJECT: "tsub_owner",
        TAKOS_TOKEN: "secret",
        TAKOSUMI_RUNTIME_BASE_URL: "https://hello.example",
        TAKOSUMI_INSTALL_LAUNCH_RETURN_TO: "/spaces/space_1/threads",
        TAKOSUMI_ENDPOINT: "https://kernel.example",
        TAKOSUMI_DEPLOY_TOKEN: "deploy-secret",
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
  assertEquals(parsed.launchReturnTo, "/spaces/space_1/threads");
  assertEquals(parsed.confirmPreviewId, "preview_0123456789abcdef01234567");
  assertEquals(
    parsed.confirmPermissionDigest,
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
  assertEquals(parsed.costAck, true);
  assertEquals(parsed.endpoint, "https://kernel.example");
  assertEquals(parsed.deployToken, "deploy-secret");
});

Deno.test("parseInstallArgs accepts install runtime modes", () => {
  for (const mode of ["shared-cell", "dedicated", "self-hosted"] as const) {
    const parsed = parseInstallArgs([
      "apply",
      "--mode",
      mode,
    ], {
      get(key: string) {
        const env: Record<string, string> = {
          TAKOSUMI_ACCOUNTS_URL: "http://accounts.example",
          TAKOS_ACCOUNT_ID: "acct_1",
          TAKOS_SPACE_ID: "space_1",
          TAKOSUMI_SUBJECT: "tsub_owner",
        };
        return env[key];
      },
    });

    assertEquals(parsed.mode, mode);
  }
});

Deno.test("parseInstallArgs rejects invalid install runtime mode", () => {
  assertThrows(
    () =>
      parseInstallArgs([
        "apply",
        "--mode",
        "serverless",
      ], {
        get(key: string) {
          const env: Record<string, string> = {
            TAKOSUMI_ACCOUNTS_URL: "http://accounts.example",
            TAKOS_ACCOUNT_ID: "acct_1",
            TAKOS_SPACE_ID: "space_1",
            TAKOSUMI_SUBJECT: "tsub_owner",
          };
          return env[key];
        },
      }),
    Error,
    "--mode must be one of shared-cell|dedicated|self-hosted",
  );
});

Deno.test("parseInstallArgs rejects invalid launch return targets", () => {
  assertThrows(
    () =>
      parseInstallArgs([
        "apply",
        "--launch-return-to",
        "https://evil.example/spaces",
      ], {
        get(key: string) {
          const env: Record<string, string> = {
            TAKOSUMI_ACCOUNTS_URL: "http://accounts.example",
            TAKOS_ACCOUNT_ID: "acct_1",
            TAKOS_SPACE_ID: "space_1",
            TAKOSUMI_SUBJECT: "tsub_owner",
          };
          return env[key];
        },
      }),
    Error,
    "--launch-return-to must be a slash-prefixed path without query",
  );
});

Deno.test("parseInstallArgs rejects removed service resolver flags", () => {
  assertThrows(
    () =>
      parseInstallArgs([
        "apply",
        "--service-resolver-url",
        "https://anchor.example.test/v1/services/",
      ]),
    Error,
    "service resolver options were removed",
  );
});

Deno.test("parseInstallArgs accepts Git URL source and immutable ref", () => {
  const parsed = parseInstallArgs([
    "preview",
    "https://github.com/example/hello",
    "--ref",
    "v1.2.3",
    "--app",
    ".takosumi/app.yml",
    "--manifest",
    ".takosumi/manifest.yml",
    "--json",
  ]);

  assertEquals(parsed.sourceGitUrl, "https://github.com/example/hello");
  assertEquals(parsed.sourceRef, "v1.2.3");
  assertEquals(parsed.appPathSpec, ".takosumi/app.yml");
  assertEquals(parsed.manifestPathSpec, ".takosumi/manifest.yml");
  assertEquals(parsed.json, true);
});

Deno.test("parseInstallArgs treats bare install as apply", () => {
  const parsed = parseInstallArgs([
    "https://github.com/example/hello",
    "--ref",
    "v1.2.3",
    "--accounts-url",
    "http://accounts.example",
    "--account-id",
    "acct_1",
    "--space-id",
    "space_1",
    "--subject",
    "tsub_owner",
  ]);

  assertEquals(parsed.subcommand, "apply");
  assertEquals(parsed.sourceGitUrl, "https://github.com/example/hello");
  assertEquals(parsed.sourceRef, "v1.2.3");
});

Deno.test("parseInstallArgs rejects mutable Git URL refs", () => {
  assertThrows(
    () =>
      parseInstallArgs([
        "preview",
        "https://github.com/example/hello",
        "--ref",
        "main",
      ]),
    Error,
    "--ref looks mutable: main",
  );
});

Deno.test("previewInstall checks out Git URL source and pins resolved commit", async () => {
  const checkoutRoot = await Deno.makeTempDir({
    prefix: "takosumi-git-install-checkout-",
  });
  let cleanupCalled = false;
  try {
    await Deno.mkdir(join(checkoutRoot, ".takosumi"));
    await Deno.writeTextFile(
      join(checkoutRoot, ".takosumi", "app.yml"),
      VALID_APP_YML,
    );
    await Deno.writeTextFile(
      join(checkoutRoot, ".takosumi", "manifest.yml"),
      MANIFEST_YML,
    );

    const preview = await previewInstall({
      subcommand: "preview",
      cwd: "/unused",
      appPath: "/unused/.takosumi/app.yml",
      appPathSpec: ".takosumi/app.yml",
      manifestPathSpec: ".takosumi/manifest.yml",
      json: true,
      sourceGitUrl: "https://github.com/example/hello",
      sourceRef: "v1.2.3",
      checkoutSource: (request) => {
        assertEquals(request, {
          gitUrl: "https://github.com/example/hello",
          ref: "v1.2.3",
        });
        return Promise.resolve({
          root: checkoutRoot,
          commit: "0123456789abcdef0123456789abcdef01234567",
          cleanup: () => {
            cleanupCalled = true;
            return Promise.resolve();
          },
        });
      },
    });

    assertEquals(
      preview.source.commit,
      "0123456789abcdef0123456789abcdef01234567",
    );
    assertEquals(preview.source.pinned, true);
    assert(preview.source.compiledManifestDigest?.startsWith("sha256:"));
    assertEquals(cleanupCalled, true);
  } finally {
    await Deno.remove(checkoutRoot, { recursive: true }).catch(() => {});
  }
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
      costAck: true,
      fetch: (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(Response.json({
          installation: { id: "inst_1" },
          runtime_binding: {
            target_type: "shared-cell",
            target_id: "shared-cell://tokyo-cell-01/namespaces/inst_1",
          },
        }, { status: 202 }));
      },
    });

    assertEquals(result.response.status, 202);
    assertEquals(result.accounts.installationId, "inst_1");
    assertEquals(result.accounts.runtimeBinding, {
      target_type: "shared-cell",
      target_id: "shared-cell://tokyo-cell-01/namespaces/inst_1",
    });
    assertEquals(result.accounts.bindings, []);
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
    assertEquals("serviceImports" in body, false);
    assertEquals(body.oidcClients, undefined);
    assertEquals(body.grants.length, 2);
    assertEquals(body.confirm, {
      previewId: result.preview.previewId,
      permissionDigest: result.preview.permissionDigest,
      costAck: true,
      approvalRequired: result.preview.approvalRequired,
      expiresAt: result.preview.expiresAt,
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("applyInstall requires cost acknowledgement for metered bindings", async () => {
  const root = await Deno.makeTempDir({ prefix: "takosumi-git-install-" });
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

    await assertRejects(
      () =>
        applyInstall({
          subcommand: "apply",
          cwd: root,
          appPath: join(root, ".takosumi", "app.yml"),
          json: true,
          accountsUrl: "http://accounts.example/",
          accountId: "acct_1",
          spaceId: "space_1",
          createdBySubject: "tsub_owner",
        }),
      Error,
      "--cost-ack",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("applyInstall rejects stale approval evidence", async () => {
  const root = await Deno.makeTempDir({ prefix: "takosumi-git-install-" });
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

    await assertRejects(
      () =>
        applyInstall({
          subcommand: "apply",
          cwd: root,
          appPath: join(root, ".takosumi", "app.yml"),
          json: true,
          accountsUrl: "http://accounts.example/",
          accountId: "acct_1",
          spaceId: "space_1",
          createdBySubject: "tsub_owner",
          confirmPermissionDigest:
            "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          costAck: true,
        }),
      Error,
      "--permission-digest",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("applyInstall deploys without service import materialization", async () => {
  const root = await Deno.makeTempDir({ prefix: "takosumi-git-install-" });
  const requests: Request[] = [];
  try {
    await Deno.mkdir(join(root, ".takosumi"));
    await Deno.writeTextFile(
      join(root, ".takosumi", "app.yml"),
      VALID_APP_YML.replace(
        "ref: v1.2.3",
        "ref: v1.2.3\n  commit: 0123456789abcdef0123456789abcdef01234567",
      ),
    );
    await Deno.writeTextFile(
      join(root, ".takosumi", "manifest.yml"),
      `apiVersion: "1.0"
kind: Manifest
metadata:
  name: hello
resources:
  - shape: web-service@v1
    name: api
    provider: "@takos/selfhost-docker-compose"
    spec:
      image: ghcr.io/example/hello@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      port: 8080
      env:
        AUTH_DRIVER: oidc
`,
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
      costAck: true,
      runtimeBaseUrl: "http://localhost:8787",
      launchReturnTo: "/spaces/space_1/threads",
      endpoint: "http://kernel.example/",
      deployToken: "deploy-secret",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        const url = String(input);
        if (url.includes("/v1/deployments")) {
          return Promise.resolve(Response.json({
            status: "ok",
            outcome: { status: "succeeded" },
          }));
        }
        const request = new Request(input, init);
        if (
          url.endsWith("/v1/installations/inst_1/launch-token") &&
          request.method === "GET"
        ) {
          return Promise.resolve(Response.json(
            opaqueLaunchTokenConfig(),
          ));
        }
        if (
          url.endsWith("/v1/installations/inst_1/launch-token") &&
          request.method === "POST"
        ) {
          const body = await request.json();
          assertEquals(
            body.redirectUri,
            "http://localhost:8787/_takosumi/launch?return_to=%2Fspaces%2Fspace_1%2Fthreads",
          );
          return Promise.resolve(Response.json({
            url:
              "http://localhost:8787/_takosumi/launch?return_to=%2Fspaces%2Fspace_1%2Fthreads&token=launch-jws",
            token: "launch-jws",
            expiresAt: "2026-05-12T00:02:00.000Z",
            jti: "lt_1",
            audience: "example.hello",
          }));
        }
        if (url.includes("/status")) {
          return Promise.resolve(Response.json({
            installation: { id: "inst_1", status: "ready" },
          }));
        }
        return Promise.resolve(Response.json({
          installation: { id: "inst_1" },
          binding_env: {
            DATABASE_URL:
              "postgres://takos:secret@db.example.test:5432/takos?sslmode=require",
            BLOB_ENDPOINT: "https://objects.example.test",
            BLOB_BUCKET: "inst-1",
            BLOB_ACCESS_KEY: "access-key",
            BLOB_SECRET_KEY: "secret-key",
          },
          bindings: [{
            name: "auth",
            kind: "identity.oidc@v1",
            config_ref:
              "takosumi-accounts://installations/inst_1/bindings/auth/oidc-client/toc_1",
            secret_refs: [
              "takosumi-accounts://installations/inst_1/bindings/auth/secrets/client-secret",
            ],
          }, {
            name: "bootstrap",
            kind: "install-launch-token@v1",
            config_ref:
              "takosumi-accounts://installations/inst_1/bindings/bootstrap/launch-token/launch-test",
            secret_refs: [],
          }, {
            name: "database",
            kind: "database.postgres@v1",
            config_ref:
              "takosumi-accounts://installations/inst_1/bindings/database/postgres/main",
            secret_refs: [
              "takosumi-accounts://installations/inst_1/bindings/database/secrets/password",
            ],
          }],
          oidc_client_secret: "client-secret",
          oidc_client: {
            client_id: "toc_1",
            installation_id: "inst_1",
            namespace_path: "operator.identity.oidc",
            issuer_url: "https://accounts.example",
            redirect_uris: ["http://localhost:8787/auth/oidc/callback"],
          },
        }, { status: 202 }));
      },
    });

    assertEquals(result.deployment?.status, 200);
    assertEquals(result.statusTransition?.status, 200);
    assertEquals(
      result.launch?.url,
      "http://localhost:8787/_takosumi/launch?return_to=%2Fspaces%2Fspace_1%2Fthreads&token=launch-jws",
    );
    assertEquals(result.accounts.installationId, "inst_1");
    assertEquals(
      result.accounts.bindings[0]?.config_ref,
      "takosumi-accounts://installations/inst_1/bindings/auth/oidc-client/toc_1",
    );
    assertEquals(result.accounts.oidcClient?.client_id, "toc_1");
    assertEquals(result.accounts.oidcClientSecret, "client-secret");
    assertEquals(
      result.accounts.bindingEnv?.DATABASE_URL?.startsWith(
        "postgres://takos:secret@db.example.test",
      ),
      true,
    );
    assertEquals(requests.length, 5);
    const body = await requests[0].json();
    assertEquals("serviceImports" in body, false);
    assertEquals(
      body.bindings.some((binding: { kind: string }) =>
        binding.kind === "service.import@v1"
      ),
      false,
    );
    assertEquals(
      body.bindings.find((
        binding: { name: string },
      ) => binding.name === "database")?.declaration,
      {
        type: "database.postgres@v1",
        required: true,
        plan: "nano",
      },
    );
    assertEquals(body.oidcClients, [{
      binding: "auth",
      namespacePath: "operator.identity.oidc",
      redirectUris: ["http://localhost:8787/auth/oidc/callback"],
      allowedScopes: ["openid", "profile"],
      subjectMode: "pairwise",
    }]);
    assertEquals(
      requests[1].url,
      "http://accounts.example/v1/installations/inst_1/launch-token",
    );
    assertEquals(requests[1].method, "GET");
    assertEquals(requests[1].headers.get("authorization"), null);
    assertEquals(requests[2].url, "http://kernel.example/v1/deployments");
    assertEquals(
      requests[2].headers.get("authorization"),
      "Bearer deploy-secret",
    );
    const deployBody = await requests[2].json();
    assertEquals(deployBody.mode, "apply");
    assertEquals("imports" in deployBody.manifest, false);
    assertEquals("serviceResolvers" in deployBody.manifest, false);
    assertEquals(
      deployBody.manifest.resources[0].spec.env,
      {
        AUTH_DRIVER: "oidc",
        TAKOS_INSTALLATION_ID: "inst_1",
        BASE_URL: "http://localhost:8787",
        OIDC_ISSUER_URL: "https://accounts.example",
        OIDC_CLIENT_ID: "toc_1",
        OIDC_REDIRECT_URI: "http://localhost:8787/auth/oidc/callback",
        OIDC_CLIENT_SECRET: "client-secret",
        DATABASE_URL:
          "postgres://takos:secret@db.example.test:5432/takos?sslmode=require",
        BLOB_ENDPOINT: "https://objects.example.test",
        BLOB_BUCKET: "inst-1",
        BLOB_ACCESS_KEY: "access-key",
        BLOB_SECRET_KEY: "secret-key",
        ACCOUNTS_BASE_URL: "http://accounts.example",
        INSTALL_LAUNCH_INSTALLATION_ID: "inst_1",
        INSTALL_LAUNCH_REDIRECT_URI: "http://localhost:8787/_takosumi/launch",
        INSTALL_LAUNCH_CONSUME_PATH: "/_takosumi/launch",
      },
    );
    assertEquals(
      requests[3].url,
      "http://accounts.example/v1/installations/inst_1/status",
    );
    assertEquals(requests[3].method, "PATCH");
    assertEquals(await requests[3].json(), {
      status: "ready",
      reason: "kernel deploy HTTP 200",
    });
    assertEquals(
      requests[4].url,
      "http://accounts.example/v1/installations/inst_1/launch-token",
    );
    assertEquals(requests[4].method, "POST");
    assertEquals(await requests[4].json(), {
      purpose: "install-bootstrap",
      ttlSeconds: 120,
      redirectUri:
        "http://localhost:8787/_takosumi/launch?return_to=%2Fspaces%2Fspace_1%2Fthreads",
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("applyInstall resolves Accounts binding placeholders before kernel deploy", async () => {
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
      `apiVersion: "1.0"
kind: Manifest
metadata:
  name: hello
resources:
  - shape: web-service@v1
    name: api
    provider: "@takos/selfhost-docker-compose"
    spec:
      image: ghcr.io/example/hello@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      port: 8080
      env:
        OIDC_ISSUER_URL: \${bindings.auth.issuerUrl}
        OIDC_CLIENT_ID: \${bindings.auth.clientId}
        OIDC_CLIENT_SECRET: \${secrets.auth.clientSecret}
        OIDC_REDIRECT_URI: \${bindings.auth.redirectUris[0]}
        DATABASE_URL: \${bindings.database.url}
        DB_HOST: \${bindings.database.host}
        DB_PASSWORD: \${secrets.database.password}
        BLOB_ENDPOINT: \${bindings.blob.endpoint}
        BLOB_SECRET_KEY: \${secrets.blob.secretKey}
        ACCOUNTS_BASE_URL: \${bindings.bootstrap.accountsBaseUrl}
        INSTALL_LAUNCH_INSTALLATION_ID: \${bindings.bootstrap.installationId}
        INSTALL_LAUNCH_REDIRECT_URI: \${bindings.bootstrap.redirectUri}
        INSTALL_LAUNCH_CONSUME_PATH: \${bindings.bootstrap.consumePath}
        INSTALL_LAUNCH_MAX_LIFETIME_SECONDS: \${bindings.bootstrap.maxLifetimeSeconds}
        DATABASE_CONFIG_REF: \${refs.database.configRef}
        DATABASE_SECRET_REF: \${refs.database.secretRefs[0]}
        BLOB_CONFIG_REF: \${refs.blob.config_ref}
        AUTH_SECRET_REF: \${refs.auth.secret_refs[0]}
        INSTALLATION_ID: \${installation.id}
        SPACE_ID: \${installation.spaceId}
        BASE_URL: \${installation.baseUrl}
`,
    );

    await applyInstall({
      subcommand: "apply",
      cwd: root,
      appPath: join(root, ".takosumi", "app.yml"),
      json: true,
      accountsUrl: "http://accounts.example/",
      accountId: "acct_1",
      spaceId: "space_1",
      createdBySubject: "tsub_owner",
      costAck: true,
      runtimeBaseUrl: "http://localhost:8787",
      endpoint: "http://kernel.example/",
      deployToken: "deploy-secret",
      fetch: (input, init) => {
        requests.push(new Request(input, init));
        const url = String(input);
        if (url.includes("/v1/deployments")) {
          return Promise.resolve(Response.json({
            status: "ok",
            outcome: { status: "succeeded" },
          }));
        }
        if (url.endsWith("/v1/installations/inst_1/launch-token")) {
          return Promise.resolve(Response.json(opaqueLaunchTokenConfig()));
        }
        if (url.includes("/status")) {
          return Promise.resolve(Response.json({
            installation: { id: "inst_1", status: "ready" },
          }));
        }
        return Promise.resolve(Response.json({
          installation: { id: "inst_1" },
          binding_env: {
            DATABASE_URL:
              "postgres://takos:secret@db.example.test:5432/takos?sslmode=require",
            BLOB_ENDPOINT: "https://objects.example.test",
            BLOB_BUCKET: "inst-1",
            BLOB_ACCESS_KEY: "access-key",
            BLOB_SECRET_KEY: "secret-key",
          },
          bindings: [{
            name: "auth",
            kind: "identity.oidc@v1",
            config_ref:
              "takosumi-accounts://installations/inst_1/bindings/auth/oidc-client/toc_1",
            secret_refs: [
              "takosumi-accounts://installations/inst_1/bindings/auth/secrets/client-secret",
            ],
          }, {
            name: "bootstrap",
            kind: "install-launch-token@v1",
            config_ref:
              "takosumi-accounts://installations/inst_1/bindings/bootstrap/launch-token/launch-test",
            secret_refs: [],
          }, {
            name: "blob",
            kind: "object-store.s3-compatible@v1",
            config_ref:
              "takosumi-accounts://installations/inst_1/bindings/blob/object-store/main",
            secret_refs: [
              "takosumi-accounts://installations/inst_1/bindings/blob/secrets/secret-key",
            ],
          }, {
            name: "database",
            kind: "database.postgres@v1",
            config_ref:
              "takosumi-accounts://installations/inst_1/bindings/database/postgres/main",
            secret_refs: [
              "takosumi-accounts://installations/inst_1/bindings/database/secrets/password",
            ],
          }],
          oidc_client_secret: "client-secret",
          oidc_client: {
            client_id: "toc_1",
            installation_id: "inst_1",
            namespace_path: "operator.identity.oidc",
            issuer_url: "https://accounts.example",
            redirect_uris: ["http://localhost:8787/auth/oidc/callback"],
          },
        }, { status: 202 }));
      },
    });

    const deployBody = await requests[2].json();
    const env = deployBody.manifest.resources[0].spec.env;
    assertEquals(env.OIDC_ISSUER_URL, "https://accounts.example");
    assertEquals(env.OIDC_CLIENT_ID, "toc_1");
    assertEquals(env.OIDC_CLIENT_SECRET, "client-secret");
    assertEquals(
      env.OIDC_REDIRECT_URI,
      "http://localhost:8787/auth/oidc/callback",
    );
    assertEquals(
      env.DATABASE_URL,
      "postgres://takos:secret@db.example.test:5432/takos?sslmode=require",
    );
    assertEquals(env.DB_HOST, "db.example.test");
    assertEquals(env.DB_PASSWORD, "secret");
    assertEquals(env.BLOB_ENDPOINT, "https://objects.example.test");
    assertEquals(env.BLOB_SECRET_KEY, "secret-key");
    assertEquals(env.ACCOUNTS_BASE_URL, "http://accounts.example");
    assertEquals(env.INSTALL_LAUNCH_INSTALLATION_ID, "inst_1");
    assertEquals(
      env.INSTALL_LAUNCH_REDIRECT_URI,
      "http://localhost:8787/_takosumi/launch",
    );
    assertEquals(
      env.INSTALL_LAUNCH_CONSUME_PATH,
      "/_takosumi/launch",
    );
    assertEquals(env.INSTALL_LAUNCH_MAX_LIFETIME_SECONDS, 300);
    assertEquals(
      env.DATABASE_CONFIG_REF,
      "takosumi-accounts://installations/inst_1/bindings/database/postgres/main",
    );
    assertEquals(
      env.DATABASE_SECRET_REF,
      "takosumi-accounts://installations/inst_1/bindings/database/secrets/password",
    );
    assertEquals(
      env.BLOB_CONFIG_REF,
      "takosumi-accounts://installations/inst_1/bindings/blob/object-store/main",
    );
    assertEquals(
      env.AUTH_SECRET_REF,
      "takosumi-accounts://installations/inst_1/bindings/auth/secrets/client-secret",
    );
    assertEquals(env.INSTALLATION_ID, "inst_1");
    assertEquals(env.SPACE_ID, "space_1");
    assertEquals(env.BASE_URL, "http://localhost:8787");
    assertEquals(JSON.stringify(deployBody).includes("${bindings."), false);
    assertEquals(JSON.stringify(deployBody).includes("${secrets."), false);
    assertEquals(JSON.stringify(deployBody).includes("${refs."), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("applyInstall resolves domain and deploy-intent binding placeholders", async () => {
  const root = await Deno.makeTempDir({ prefix: "takosumi-git-install-" });
  const requests: Request[] = [];
  try {
    await Deno.mkdir(join(root, ".takosumi"));
    await Deno.writeTextFile(
      join(root, ".takosumi", "app.yml"),
      `apiVersion: app.takosumi.dev/v1
kind: InstallableApp
metadata:
  id: example.gitops
  name: GitOps App
  description: App using domain and deploy-intent bindings
  publisher: example
  homepage: https://example.com
source:
  git: https://github.com/example/gitops
  ref: v1.2.3
  commit: 0123456789abcdef0123456789abcdef01234567
entry:
  manifest: .takosumi/manifest.yml
runtime:
  modes:
    - dedicated
bindings:
  site:
    type: domain.http@v1
    required: true
    hostname:
      custom: hello.example.com
  deploy:
    type: deploy-intent.gitops@v1
    required: true
    branch: main
    writePathPrefix: apps/hello
install:
  healthcheckPath: /health
  postInstallLaunchPath: /_takosumi/launch
permissions:
  requested: []
`,
    );
    await Deno.writeTextFile(
      join(root, ".takosumi", "manifest.yml"),
      `apiVersion: "1.0"
kind: Manifest
metadata:
  name: hello
resources:
  - shape: web-service@v1
    name: api
    provider: "@takos/selfhost-docker-compose"
    spec:
      image: ghcr.io/example/hello@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      port: 8080
      env:
        PUBLIC_HOST: \${bindings.site.hostname}
        PUBLIC_URL: \${bindings.site.url}
        DEPLOY_DRIVER: \${bindings.deploy.driver}
        DEPLOY_REMOTE: \${bindings.deploy.remote}
        DEPLOY_BRANCH: \${bindings.deploy.branch}
        DEPLOY_PREFIX: \${bindings.deploy.writePathPrefix}
        DEPLOY_TOKEN: \${secrets.deploy.token}
        DOMAIN_CONFIG_REF: \${refs.site.configRef}
        DEPLOY_CONFIG_REF: \${refs.deploy.configRef}
        DEPLOY_SECRET_REF: \${refs.deploy.secretRefs[0]}
`,
    );

    await applyInstall({
      subcommand: "apply",
      cwd: root,
      appPath: join(root, ".takosumi", "app.yml"),
      json: true,
      accountsUrl: "http://accounts.example/",
      accountId: "acct_1",
      spaceId: "space_1",
      createdBySubject: "tsub_owner",
      costAck: true,
      runtimeBaseUrl: "https://hello.example.com",
      endpoint: "http://kernel.example/",
      deployToken: "deploy-secret",
      fetch: (input, init) => {
        requests.push(new Request(input, init));
        const url = String(input);
        if (url.includes("/v1/deployments")) {
          return Promise.resolve(Response.json({
            status: "ok",
            outcome: { status: "succeeded" },
          }));
        }
        if (url.includes("/status")) {
          return Promise.resolve(Response.json({
            installation: { id: "inst_gitops", status: "ready" },
          }));
        }
        return Promise.resolve(Response.json({
          installation: { id: "inst_gitops" },
          binding_env: {
            DEPLOY_INTENT_DRIVER: "gitops",
            DEPLOY_INTENT_REMOTE: "ssh://git.example.com/acme/platform.git",
            DEPLOY_INTENT_TOKEN: "deploy-token",
          },
          bindings: [{
            name: "site",
            kind: "domain.http@v1",
            config_ref:
              "takosumi-accounts://installations/inst_gitops/bindings/site/domain/hello-example",
            secret_refs: [],
          }, {
            name: "deploy",
            kind: "deploy-intent.gitops@v1",
            config_ref:
              "takosumi-accounts://installations/inst_gitops/bindings/deploy/gitops/main",
            secret_refs: [
              "takosumi-accounts://installations/inst_gitops/bindings/deploy/secrets/token",
            ],
            branch: "main",
            write_path_prefix: "apps/hello",
          }],
        }, { status: 202 }));
      },
    });

    const deployBody = await requests[1].json();
    const env = deployBody.manifest.resources[0].spec.env;
    assertEquals(env.PUBLIC_HOST, "hello.example.com");
    assertEquals(env.PUBLIC_URL, "https://hello.example.com");
    assertEquals(env.DEPLOY_DRIVER, "gitops");
    assertEquals(env.DEPLOY_REMOTE, "ssh://git.example.com/acme/platform.git");
    assertEquals(env.DEPLOY_BRANCH, "main");
    assertEquals(env.DEPLOY_PREFIX, "apps/hello");
    assertEquals(env.DEPLOY_TOKEN, "deploy-token");
    assertEquals(
      env.DOMAIN_CONFIG_REF,
      "takosumi-accounts://installations/inst_gitops/bindings/site/domain/hello-example",
    );
    assertEquals(
      env.DEPLOY_CONFIG_REF,
      "takosumi-accounts://installations/inst_gitops/bindings/deploy/gitops/main",
    );
    assertEquals(
      env.DEPLOY_SECRET_REF,
      "takosumi-accounts://installations/inst_gitops/bindings/deploy/secrets/token",
    );
    assertEquals(JSON.stringify(deployBody).includes("${bindings."), false);
    assertEquals(JSON.stringify(deployBody).includes("${secrets."), false);
    assertEquals(JSON.stringify(deployBody).includes("${refs."), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("applyInstall compiles workflowRef before kernel deploy", async () => {
  const checkoutRoot = await Deno.makeTempDir({
    prefix: "takosumi-git-install-workflow-",
  });
  const requests: Request[] = [];
  let cleanupCalled = false;
  try {
    await Deno.mkdir(join(checkoutRoot, ".takosumi", "workflows"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(checkoutRoot, ".takosumi", "app.yml"),
      WORKFLOW_APP_YML,
    );
    await Deno.writeTextFile(
      join(checkoutRoot, ".takosumi", "manifest.yml"),
      WORKFLOW_MANIFEST_YML,
    );
    await Deno.writeTextFile(
      join(checkoutRoot, ".takosumi", "workflows", "build.yml"),
      WORKFLOW_FILE_YML,
    );

    const result = await applyInstall({
      subcommand: "apply",
      cwd: "/unused",
      appPath: "/unused/.takosumi/app.yml",
      appPathSpec: ".takosumi/app.yml",
      manifestPathSpec: ".takosumi/manifest.yml",
      json: true,
      sourceGitUrl: "https://github.com/example/workflow",
      sourceRef: "v1.2.3",
      accountsUrl: "http://accounts.example",
      accountId: "acct_1",
      spaceId: "space_1",
      createdBySubject: "tsub_owner",
      costAck: true,
      endpoint: "http://kernel.example",
      deployToken: "deploy-secret",
      checkoutSource: () =>
        Promise.resolve({
          root: checkoutRoot,
          commit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
          cleanup: () => {
            cleanupCalled = true;
            return Promise.resolve();
          },
        }),
      executorFactory: () => (_run, _context) =>
        Promise.resolve({
          stdout:
            "build complete\nTAKOSUMI_ARTIFACT=ghcr.io/example/workflow@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n",
          exitCode: 0,
        }),
      fetch: (input, init) => {
        requests.push(new Request(input, init));
        const url = String(input);
        if (url.includes("/v1/deployments")) {
          return Promise.resolve(Response.json({
            status: "ok",
            outcome: { status: "succeeded" },
          }));
        }
        if (url.includes("/status")) {
          return Promise.resolve(Response.json({
            installation: { id: "inst_workflow", status: "ready" },
          }));
        }
        return Promise.resolve(Response.json({
          installation: { id: "inst_workflow" },
        }, { status: 202 }));
      },
    });

    assertEquals(result.accounts.installationId, "inst_workflow");
    assertEquals(result.deployment?.status, 200);
    assertEquals(requests.length, 3);
    assertEquals(cleanupCalled, true);

    const createBody = await requests[0].json();
    assertEquals(
      createBody.source.commit,
      "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    );
    assert(
      createBody.source.compiledManifestDigest.startsWith("sha256:"),
    );

    const deployBody = await requests[1].json();
    const resource = deployBody.manifest.resources[0];
    assertEquals(
      resource.spec.image,
      "ghcr.io/example/workflow@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    assert(!("workflowRef" in resource));
  } finally {
    await Deno.remove(checkoutRoot, { recursive: true }).catch(() => {});
  }
});

Deno.test("applyInstall rejects workflowRef files outside the workflows directory", async () => {
  const checkoutRoot = await Deno.makeTempDir({
    prefix: "takosumi-git-install-workflow-",
  });
  const requests: Request[] = [];
  try {
    await Deno.mkdir(join(checkoutRoot, ".takosumi", "workflows"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(checkoutRoot, ".takosumi", "app.yml"),
      WORKFLOW_APP_YML,
    );
    await Deno.writeTextFile(
      join(checkoutRoot, ".takosumi", "manifest.yml"),
      WORKFLOW_MANIFEST_YML.replace("file: build.yml", "file: ../outside.yml"),
    );
    await Deno.writeTextFile(
      join(checkoutRoot, ".takosumi", "outside.yml"),
      WORKFLOW_FILE_YML,
    );

    await assertRejects(
      () =>
        applyInstall({
          subcommand: "apply",
          cwd: "/unused",
          appPath: "/unused/.takosumi/app.yml",
          appPathSpec: ".takosumi/app.yml",
          manifestPathSpec: ".takosumi/manifest.yml",
          json: true,
          sourceGitUrl: "https://github.com/example/workflow",
          sourceRef: "v1.2.3",
          accountsUrl: "http://accounts.example",
          accountId: "acct_1",
          spaceId: "space_1",
          createdBySubject: "tsub_owner",
          costAck: true,
          endpoint: "http://kernel.example",
          deployToken: "deploy-secret",
          checkoutSource: () =>
            Promise.resolve({
              root: checkoutRoot,
              commit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
              cleanup: () => Promise.resolve(),
            }),
          fetch: (input, init) => {
            requests.push(new Request(input, init));
            return Promise.resolve(Response.json({}));
          },
        }),
      Error,
      "resources[0].workflowRef.file must be a relative path inside workflows directory",
    );
    assertEquals(requests.length, 0);
  } finally {
    await Deno.remove(checkoutRoot, { recursive: true }).catch(() => {});
  }
});

Deno.test("applyInstall default workflow executor does not inherit runtime secrets or provider credentials", async () => {
  const checkoutRoot = await Deno.makeTempDir({
    prefix: "takosumi-git-install-sandbox-",
  });
  const previous = {
    TAKOS_TOKEN: Deno.env.get("TAKOS_TOKEN"),
    TAKOSUMI_DEPLOY_TOKEN: Deno.env.get("TAKOSUMI_DEPLOY_TOKEN"),
    OIDC_CLIENT_SECRET: Deno.env.get("OIDC_CLIENT_SECRET"),
    DATABASE_URL: Deno.env.get("DATABASE_URL"),
    AWS_ACCESS_KEY_ID: Deno.env.get("AWS_ACCESS_KEY_ID"),
    AWS_SECRET_ACCESS_KEY: Deno.env.get("AWS_SECRET_ACCESS_KEY"),
    GOOGLE_APPLICATION_CREDENTIALS: Deno.env.get(
      "GOOGLE_APPLICATION_CREDENTIALS",
    ),
    CLOUDFLARE_API_TOKEN: Deno.env.get("CLOUDFLARE_API_TOKEN"),
  };
  const requests: Request[] = [];
  try {
    Deno.env.set("TAKOS_TOKEN", "takos-token-secret");
    Deno.env.set("TAKOSUMI_DEPLOY_TOKEN", "deploy-token-secret");
    Deno.env.set("OIDC_CLIENT_SECRET", "oidc-client-secret");
    Deno.env.set("DATABASE_URL", "postgres://secret@example/db");
    Deno.env.set("AWS_ACCESS_KEY_ID", "aws-access-key");
    Deno.env.set("AWS_SECRET_ACCESS_KEY", "aws-secret-key");
    Deno.env.set("GOOGLE_APPLICATION_CREDENTIALS", "/tmp/gcp-creds.json");
    Deno.env.set("CLOUDFLARE_API_TOKEN", "cloudflare-token");
    await Deno.mkdir(join(checkoutRoot, ".takosumi", "workflows"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(checkoutRoot, ".takosumi", "app.yml"),
      WORKFLOW_APP_YML,
    );
    await Deno.writeTextFile(
      join(checkoutRoot, ".takosumi", "manifest.yml"),
      WORKFLOW_MANIFEST_YML,
    );
    await Deno.writeTextFile(
      join(checkoutRoot, ".takosumi", "workflows", "build.yml"),
      SECRET_PROBE_WORKFLOW_FILE_YML,
    );

    const result = await applyInstall({
      subcommand: "apply",
      cwd: "/unused",
      appPath: "/unused/.takosumi/app.yml",
      appPathSpec: ".takosumi/app.yml",
      manifestPathSpec: ".takosumi/manifest.yml",
      json: true,
      sourceGitUrl: "https://github.com/example/workflow",
      sourceRef: "v1.2.3",
      accountsUrl: "http://accounts.example",
      accountId: "acct_1",
      spaceId: "space_1",
      createdBySubject: "tsub_owner",
      costAck: true,
      endpoint: "http://kernel.example",
      deployToken: "deploy-secret",
      checkoutSource: () =>
        Promise.resolve({
          root: checkoutRoot,
          commit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
          cleanup: () => Promise.resolve(),
        }),
      fetch: (input, init) => {
        requests.push(new Request(input, init));
        const url = String(input);
        if (url.includes("/v1/deployments")) {
          return Promise.resolve(Response.json({
            status: "ok",
            outcome: { status: "succeeded" },
          }));
        }
        if (url.includes("/status")) {
          return Promise.resolve(Response.json({
            installation: { id: "inst_sandbox", status: "ready" },
          }));
        }
        return Promise.resolve(Response.json({
          installation: { id: "inst_sandbox" },
        }, { status: 202 }));
      },
    });

    assertEquals(result.accounts.installationId, "inst_sandbox");
    assertEquals(result.deployment?.status, 200);
    const deployBody = await requests[1].json();
    const resource = deployBody.manifest.resources[0];
    assertEquals(
      resource.spec.image,
      "ghcr.io/example/workflow@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
  } finally {
    restoreEnv(previous);
    await Deno.remove(checkoutRoot, { recursive: true }).catch(() => {});
  }
});

Deno.test("applyInstall rejects non-digest-pinned deploy images", async () => {
  const root = await Deno.makeTempDir({ prefix: "takosumi-git-install-" });
  const requests: Request[] = [];
  try {
    await Deno.mkdir(join(root, ".takosumi"));
    await Deno.writeTextFile(
      join(root, ".takosumi", "app.yml"),
      WORKFLOW_APP_YML.replace(
        "ref: v1.2.3",
        "ref: v1.2.3\n  commit: abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      ),
    );
    await Deno.writeTextFile(
      join(root, ".takosumi", "manifest.yml"),
      WORKFLOW_MANIFEST_YML.replace(
        `    workflowRef:
      file: build.yml
      job: image
      artifact: image`,
        "      image: ghcr.io/example/workflow:latest",
      ),
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
          costAck: true,
          endpoint: "http://kernel.example",
          deployToken: "deploy-secret",
          fetch: (input, init) => {
            requests.push(new Request(input, init));
            return Promise.resolve(Response.json({}));
          },
        }),
      Error,
      "spec.image must be digest-pinned",
    );
    assertEquals(requests.length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("applyInstall rejects missing required provider binding materialization", async () => {
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

    await assertRejects(
      () =>
        applyInstall({
          subcommand: "apply",
          cwd: root,
          appPath: join(root, ".takosumi", "app.yml"),
          json: true,
          accountsUrl: "http://accounts.example/",
          accountId: "acct_1",
          spaceId: "space_1",
          createdBySubject: "tsub_owner",
          costAck: true,
          runtimeBaseUrl: "http://localhost:8787",
          endpoint: "http://kernel.example/",
          deployToken: "deploy-secret",
          fetch: (input, init) => {
            requests.push(new Request(input, init));
            const url = String(input);
            if (url.endsWith("/v1/installations/inst_1/launch-token")) {
              return Promise.resolve(Response.json(opaqueLaunchTokenConfig()));
            }
            return Promise.resolve(Response.json({
              installation: { id: "inst_1" },
              bindings: [{
                name: "database",
                kind: "database.postgres@v1",
                config_ref:
                  "takosumi-git://installable-app/example.hello/bindings/database/sha256:pending",
                secret_refs: [],
              }, {
                name: "bootstrap",
                kind: "install-launch-token@v1",
                config_ref:
                  "takosumi-accounts://installations/inst_1/bindings/bootstrap/launch-token/launch-test",
                secret_refs: [],
              }],
            }, { status: 202 }));
          },
        }),
      Error,
      "required AppBinding materialization is missing",
    );
    assertEquals(requests.length, 2);
    assertEquals(
      requests.some((request) => request.url.includes("/v1/deployments")),
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("applyInstall rejects missing required opaque launch token env", async () => {
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

    await assertRejects(
      () =>
        applyInstall({
          subcommand: "apply",
          cwd: root,
          appPath: join(root, ".takosumi", "app.yml"),
          json: true,
          accountsUrl: "http://accounts.example/",
          accountId: "acct_1",
          spaceId: "space_1",
          createdBySubject: "tsub_owner",
          costAck: true,
          runtimeBaseUrl: "http://localhost:8787",
          endpoint: "http://kernel.example/",
          deployToken: "deploy-secret",
          fetch: (input, init) => {
            requests.push(new Request(input, init));
            const url = String(input);
            if (url.endsWith("/v1/installations/inst_1/launch-token")) {
              return Promise.resolve(Response.json({
                env: {},
              }));
            }
            return Promise.resolve(Response.json({
              installation: { id: "inst_1" },
              binding_env: {
                DATABASE_URL:
                  "postgres://takos:secret@db.example.test:5432/takos?sslmode=require",
              },
              bindings: [{
                name: "database",
                kind: "database.postgres@v1",
                config_ref:
                  "takosumi-accounts://installations/inst_1/bindings/database/postgres/main",
                secret_refs: [],
              }, {
                name: "bootstrap",
                kind: "install-launch-token@v1",
                config_ref:
                  "takosumi-accounts://installations/inst_1/bindings/bootstrap/launch-token/launch-test",
                secret_refs: [],
              }],
            }, { status: 202 }));
          },
        }),
      Error,
      "ACCOUNTS_BASE_URL",
    );
    assertEquals(requests.length, 2);
    assertEquals(
      requests.some((request) => request.url.includes("/v1/deployments")),
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runInstallCli returns failure when kernel deploy fails", async () => {
  const root = await Deno.makeTempDir({ prefix: "takosumi-git-install-" });
  const originalFetch = globalThis.fetch;
  const originalStdoutWrite = Deno.stdout.writeSync.bind(Deno.stdout);
  const originalStderrWrite = Deno.stderr.writeSync.bind(Deno.stderr);
  const stdout: string[] = [];
  const stderr: string[] = [];
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
    globalThis.fetch = ((input: URL | RequestInfo, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.includes("/v1/deployments")) {
        return Promise.resolve(
          Response.json({ error: "provider rejected manifest" }, {
            status: 422,
          }),
        );
      }
      if (request.url.endsWith("/v1/installations/inst_1/launch-token")) {
        return Promise.resolve(Response.json(opaqueLaunchTokenConfig()));
      }
      if (request.url.includes("/status")) {
        return Promise.resolve(Response.json({
          installation: { id: "inst_1", status: "failed" },
        }));
      }
      return Promise.resolve(Response.json({
        installation: { id: "inst_1" },
        binding_env: {
          DATABASE_URL:
            "postgres://takos:secret@db.example.test:5432/takos?sslmode=require",
        },
        bindings: [{
          name: "database",
          kind: "database.postgres@v1",
          config_ref:
            "takosumi-accounts://installations/inst_1/bindings/database/postgres/main",
          secret_refs: [
            "takosumi-accounts://installations/inst_1/bindings/database/secrets/password",
          ],
        }, {
          name: "bootstrap",
          kind: "install-launch-token@v1",
          config_ref:
            "takosumi-accounts://installations/inst_1/bindings/bootstrap/launch-token/launch-test",
          secret_refs: [],
        }],
      }, { status: 202 }));
    }) as typeof fetch;
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

    const code = await runInstallCli([
      "apply",
      "--cwd",
      root,
      "--accounts-url",
      "http://accounts.example",
      "--account-id",
      "acct_1",
      "--space-id",
      "space_1",
      "--subject",
      "tsub_owner",
      "--cost-ack",
      "--endpoint",
      "http://kernel.example",
      "--deploy-token",
      "deploy-secret",
    ]);

    assertEquals(code, 1);
    assertStringIncludes(stdout.join(""), "kernel response: HTTP 422");
    assertStringIncludes(stdout.join(""), "status response: HTTP 200");
    assertEquals(requests.length, 4);
    assertEquals(requests[1].method, "GET");
    assertEquals(await requests[3].json(), {
      status: "failed",
      reason: "kernel deploy HTTP 422",
    });
    assertEquals(stderr.join(""), "");
  } finally {
    globalThis.fetch = originalFetch;
    (Deno.stdout as { writeSync: (p: Uint8Array) => number }).writeSync =
      originalStdoutWrite;
    (Deno.stderr as { writeSync: (p: Uint8Array) => number }).writeSync =
      originalStderrWrite;
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
          costAck: true,
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
      costAck: true,
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

Deno.test("applyInstall uses Git URL checkout commit as source pin", async () => {
  const checkoutRoot = await Deno.makeTempDir({
    prefix: "takosumi-git-install-apply-checkout-",
  });
  const requests: Request[] = [];
  try {
    await Deno.mkdir(join(checkoutRoot, ".takosumi"));
    await Deno.writeTextFile(
      join(checkoutRoot, ".takosumi", "app.yml"),
      VALID_APP_YML,
    );

    await applyInstall({
      subcommand: "apply",
      cwd: "/unused",
      appPath: "/unused/.takosumi/app.yml",
      appPathSpec: ".takosumi/app.yml",
      json: true,
      sourceGitUrl: "https://github.com/example/hello",
      sourceRef: "v1.2.3",
      accountsUrl: "http://accounts.example",
      accountId: "acct_1",
      spaceId: "space_1",
      createdBySubject: "tsub_owner",
      costAck: true,
      checkoutSource: () =>
        Promise.resolve({
          root: checkoutRoot,
          commit: "fedcba9876543210fedcba9876543210fedcba98",
          cleanup: () => Promise.resolve(),
        }),
      fetch: (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(Response.json({
          installation: { id: "inst_1" },
        }, { status: 202 }));
      },
    });

    const body = await requests[0].json();
    assertEquals(
      body.source.commit,
      "fedcba9876543210fedcba9876543210fedcba98",
    );
  } finally {
    await Deno.remove(checkoutRoot, { recursive: true }).catch(() => {});
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
          costAck: true,
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
