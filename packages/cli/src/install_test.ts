import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  buildInstallPreview,
  InstallableAppValidationError,
  parseInstallableAppYaml,
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
