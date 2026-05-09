import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);

Deno.test("artifact contract documents v1 marker resolver and v0 fallback", async () => {
  const doc = await read("docs/artifact-contract.md");
  const pushSource = await read("packages/cli/src/push.ts");

  for (
    const snippet of [
      "resources[i].workflowRef",
      "resources[i].spec.image",
      "workflowRef.target",
      "spec.artifact.hash",
      "TAKOSUMI_ARTIFACT=<uri>",
      "final non-empty stdout line",
      "[stderr]",
      "cleared process",
      "TAKOS_TOKEN",
      "OIDC_CLIENT_SECRET",
      "DATABASE_URL",
      "<image>@sha256:<64-hex>",
      "`spec.image` URI is not digest-pinned",
      "workflow job '<job>' produced no TAKOSUMI_ARTIFACT=<uri> marker; cannot resolve artifact URI",
      "workflow job '<job>' produced no stdout; cannot resolve artifact URI",
      "artifactContractResolver",
      "lastLineArtifactResolver",
      "parseArtifactContract",
      "stripWorkflowRefs",
    ]
  ) {
    assert.ok(doc.includes(snippet), `doc missing ${snippet}`);
  }

  for (
    const snippet of [
      "ARTIFACT_MARKER_PREFIX",
      "clearEnv: true",
      "WORKFLOW_ENV_ALLOWLIST",
      "validateResolvedArtifactTarget",
      "spec.image artifacts must be digest-pinned",
      "artifactContractResolver",
      "lastLineArtifactResolver",
      "parseArtifactContract",
      "setResourceArtifactTarget",
      "stripWorkflowRefs",
      "workflow job '${jobName}' produced no ${ARTIFACT_MARKER_PREFIX}<uri> marker; cannot resolve artifact URI",
      "workflow job '${jobName}' produced no stdout; cannot resolve artifact URI",
    ]
  ) {
    assert.ok(pushSource.includes(snippet), `source missing ${snippet}`);
  }
});

Deno.test("artifact contract is linked from top-level docs", async () => {
  const readme = await read("README.md");
  const agents = await read("AGENTS.md");

  assert.ok(readme.includes("docs/artifact-contract.md"));
  assert.ok(readme.includes("docs/workflow-ref.md"));
  assert.ok(readme.includes("docs/quickstart.md"));
  assert.ok(readme.includes("docs/history.md"));
  assert.ok(readme.includes("docs/serve.md"));
  assert.ok(agents.includes("docs/artifact-contract.md"));
  assert.ok(agents.includes("docs/workflow-ref.md"));
  assert.ok(agents.includes("docs/quickstart.md"));
  assert.ok(agents.includes("docs/history.md"));
  assert.ok(agents.includes("docs/serve.md"));
  assert.ok(agents.includes("docs/install.md"));
});

Deno.test("quickstart and workflow-ref docs pin the project convention", async () => {
  const quickstart = await read("docs/quickstart.md");
  const workflowRef = await read("docs/workflow-ref.md");

  for (
    const snippet of [
      "takosumi-git init",
      "takosumi-git/packages/cli/src/main.ts push --dry-run",
      "POST /v1/deployments",
      ".takosumi/manifest.yml",
      "Artifact URI Contract",
    ]
  ) {
    assert.ok(quickstart.includes(snippet), `quickstart missing ${snippet}`);
  }

  for (
    const snippet of [
      "resources[i].workflowRef",
      "ComputeWorkflowRef",
      "resources[i].spec.image",
      "workflowRef.target",
      "spec.artifact.hash",
      "stripped before `POST /v1/deployments`",
      "resources[i].workflowRef must have string {file, job, artifact, target?}",
    ]
  ) {
    assert.ok(workflowRef.includes(snippet), `workflowRef missing ${snippet}`);
  }
});

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, root));
}
