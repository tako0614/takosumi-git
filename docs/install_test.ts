import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);

Deno.test("install docs cover preview, apply, and commit pins", async () => {
  const doc = await read("docs/install.md");
  const installSource = await read("packages/cli/src/install.ts");
  const initSource = await read("packages/cli/src/init.ts");
  const mainSource = await read("packages/cli/src/main.ts");
  const agents = await read("AGENTS.md");

  for (
    const snippet of [
      ".takosumi/app.yml",
      "takosumi-git install preview",
      "takosumi-git.install-preview@v1",
      "takosumi-git install apply",
      "POST /v1/installations",
      "--source-commit",
      "takosumi-git://installable-app/<app-id>/bindings/<name>/sha256:<digest>",
      "service.import@v1",
      "--service-resolver-url",
      "TAKOSUMI_SERVICE_RESOLVER_PUBLIC_KEY",
      "Preview is non-mutating",
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
      "source.commit is required for install apply",
      "POST",
      "/v1/installations",
      "sourceCommit",
    ]
  ) {
    assert.ok(
      installSource.includes(snippet),
      `install source missing ${snippet}`,
    );
  }

  assert.ok(mainSource.includes("install     Preview or install"));
  assert.ok(mainSource.includes("--source-commit <sha>"));
  assert.ok(initSource.includes("appSkeleton"));
  assert.ok(initSource.includes("app.yml"));
  assert.ok(agents.includes(".takosumi/app.yml"));
  assert.ok(agents.includes("takosumi-git install preview"));
  assert.ok(agents.includes("takosumi-git install apply"));
});

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, root));
}
