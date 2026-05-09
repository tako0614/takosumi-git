import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);

Deno.test("install docs cover preview, apply, and commit pins", async () => {
  const doc = await read("docs/install.md");
  const installSource = await read("packages/cli/src/install.ts");
  const deployClientSource = await read("packages/deploy-client/src/mod.ts");
  const initSource = await read("packages/cli/src/init.ts");
  const mainSource = await read("packages/cli/src/main.ts");
  const agents = await read("AGENTS.md");

  for (
    const snippet of [
      ".takosumi/app.yml",
      "takosumi-git install preview",
      "takosumi-git install preview https://github.com/example/hello --ref v1.2.3",
      "takosumi-git.install-preview@v1",
      "POST /v1/install/preview",
      '"gitUrl": "https://github.com/example/hello"',
      "takosumi-git install apply",
      "takosumi-git install apply https://github.com/example/hello",
      "POST /v1/installations",
      "POST /v1/deployments",
      "PATCH /v1/installations/{installation-id}/status",
      "--source-commit",
      "--ref",
      "--endpoint",
      "--deploy-token",
      "takosumi-git://installable-app/<app-id>/bindings/<name>/sha256:<digest>",
      "serviceImports[]",
      "--service-resolver-url",
      "TAKOSUMI_SERVICE_RESOLVER_PUBLIC_KEY",
      "A kernel HTTP 4xx/5xx response makes the CLI exit",
      "non-zero",
      "kernel deploy HTTP 200",
      "Preview is non-mutating",
      "takosumi-git upgrade inst_01J",
      "takosumi-git rollback inst_01J",
      "POST /v1/installations/{installation-id}/upgrade",
      "POST /v1/installations/{installation-id}/rollback",
      "installation.upgraded",
      "installation.rolled_back",
    ]
  ) {
    assert.ok(doc.includes(snippet), `install doc missing ${snippet}`);
  }

  for (
    const snippet of [
      "parseInstallableAppYaml",
      "buildInstallPreview",
      "applyInstall",
      "appBindingCreateRequests",
      "compileInstallManifest",
      "buildKernelServiceImports",
      "checkoutGitSource",
      "sourceGitUrl",
      "source.commit is required for install apply",
      "POST",
      "/v1/installations",
      "patchInstallationStatus",
      "sourceCommit",
    ]
  ) {
    assert.ok(
      installSource.includes(snippet),
      `install source missing ${snippet}`,
    );
  }

  assert.ok(deployClientSource.includes("/v1/deployments"));

  assert.ok(mainSource.includes("install     Install .takosumi/app.yml"));
  assert.ok(mainSource.includes("--source-commit <sha>"));
  assert.ok(mainSource.includes("--ref <ref>"));
  assert.ok(initSource.includes("appSkeleton"));
  assert.ok(initSource.includes("app.yml"));
  assert.ok(agents.includes(".takosumi/app.yml"));
  assert.ok(agents.includes("takosumi-git install preview"));
  assert.ok(agents.includes("takosumi-git install apply"));
});

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, root));
}
