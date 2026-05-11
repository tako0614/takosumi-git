import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);

Deno.test("install docs cover preview, apply, and commit pins", async () => {
  const doc = await read("docs/install.md");
  const installSource = await read("packages/cli/src/install.ts");
  const lifecycleSource = await read("packages/cli/src/lifecycle.ts");
  const deployClientSource = await read("packages/deploy-client/src/mod.ts");
  const initSource = await read("packages/cli/src/init.ts");
  const serveSource = await read("packages/cli/src/serve.ts");
  const mainSource = await read("packages/cli/src/main.ts");
  const agents = await read("AGENTS.md");

  for (
    const snippet of [
      ".takosumi/app.yml",
      "takosumi-git install preview",
      "takosumi-git install preview https://github.com/example/hello --ref v1.2.3",
      "takosumi-git.install-preview@v1",
      "previewId",
      "expiresAt",
      "approvalRequired",
      "POST /v1/install/preview",
      "POST /v1/install/apply",
      "takosumi-git.install-apply@v1",
      "accounts.installationId",
      "accounts.bindings[]",
      "accounts.oidcClient",
      "--accounts-token",
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
      "Namespace Exports",
      "operator.identity.oidc",
      "operator.billing.default",
      "resources[i].workflowRef",
      "TAKOSUMI_ARTIFACT=<uri>",
      "digest-pinned as `<image>@sha256:<64-hex>`",
      "cleared process environment",
      "relative path inside `.takosumi/workflows`",
      "TAKOSUMI_DEPLOY_TOKEN",
      "Artifact URI Contract",
      "A kernel HTTP 4xx/5xx response makes the",
      "non-zero",
      "kernel deploy HTTP 200",
      "Preview is non-mutating",
      "Compiled manifests must not carry installer-only placeholders",
      "${bindings.*}",
      "${refs.*}",
      "${refs.<binding>.configRef}",
      "removed `${imports.*}`",
      "takosumi-git upgrade inst_01J",
      "takosumi-git rollback inst_01J",
      "POST /v1/installations/{installation-id}/upgrade",
      "POST /v1/installations/{installation-id}/rollback",
      "installation.upgraded",
      "installation.rolled_back",
      "takosumi-git materialize inst_01J",
      "--mode dedicated",
      "takosumi-git export inst_01J",
      "--output ./takos-export.tar.zst",
      "POST /v1/installations/{installation-id}/materialize",
      "POST /v1/installations/{installation-id}/export",
      "Idempotency-Key",
    ]
  ) {
    assert.ok(doc.includes(snippet), `install doc missing ${snippet}`);
  }

  for (
    const forbidden of [
      "serviceImports[] is installer-facing",
      "--service-resolver-url",
      "TAKOSUMI_SERVICE_RESOLVER_PUBLIC_KEY",
      "${imports.account-auth.endpoints.oidc-issuer.url}",
    ]
  ) {
    assert.ok(
      !doc.includes(forbidden),
      `install doc still contains ${forbidden}`,
    );
  }

  for (
    const snippet of [
      "parseInstallableAppYaml",
      "buildInstallPreview",
      "applyInstall",
      "appBindingCreateRequests",
      "compileInstallManifest",
      "compileInstallWorkflowRefs",
      "resolveWorkflowFilePath",
      "assertNoInstallerPlaceholders",
      "unresolved installer placeholder",
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

  for (const removedSource of ["buildKernelServiceImports"]) {
    assert.ok(
      !installSource.includes(removedSource),
      `install source still contains ${removedSource}`,
    );
  }

  assert.ok(deployClientSource.includes("/v1/deployments"));
  assert.ok(lifecycleSource.includes("runMaterializeCli"));
  assert.ok(lifecycleSource.includes("runExportCli"));
  assert.ok(lifecycleSource.includes("downloadExportBundle"));
  assert.ok(lifecycleSource.includes("idempotency-key"));
  assert.ok(serveSource.includes("/v1/install/apply"));
  assert.ok(serveSource.includes("handleInstallApplyRequest"));

  assert.ok(mainSource.includes("install     Install .takosumi/app.yml"));
  assert.ok(mainSource.includes("materialize Request shared-cell"));
  assert.ok(mainSource.includes("export      Request a self-host"));
  assert.ok(mainSource.includes("--output <path>"));
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
