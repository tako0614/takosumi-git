import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);

Deno.test("install docs cover preview, apply, and commit pins", async () => {
  const doc = await read("docs/install.md");
  const installSource = await read("packages/cli/src/install.ts");
  const mainSource = await read("packages/cli/src/main.ts");

  for (
    const snippet of [
      ".takosumi/app.yml",
      "takosumi-git install preview",
      "takosumi-git.install-preview@v1",
      "takosumi-git install apply",
      "POST /v1/installations",
      "--source-commit",
      "takosumi-git://installable-app/<app-id>/bindings/<name>/sha256:<digest>",
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
});

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, root));
}
