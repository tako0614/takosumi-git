import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);

Deno.test("artifact contract documents the v0 stdout resolver", async () => {
  const doc = await read("docs/artifact-contract.md");
  const pushSource = await read("packages/cli/src/push.ts");

  for (
    const snippet of [
      "resources[i].workflowRef",
      "resources[i].spec.image",
      "final non-empty stdout line",
      "[stderr]",
      "workflow job '<job>' produced no stdout; cannot resolve artifact URI",
      "lastLineArtifactResolver",
      "stripWorkflowRefs",
    ]
  ) {
    assert.ok(doc.includes(snippet), `doc missing ${snippet}`);
  }

  for (
    const snippet of [
      "lastLineArtifactResolver",
      "setResourceImage",
      "stripWorkflowRefs",
      "workflow job '${job.name}' produced no stdout; cannot resolve artifact URI",
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
  assert.ok(agents.includes("docs/artifact-contract.md"));
  assert.ok(agents.includes("docs/workflow-ref.md"));
  assert.ok(agents.includes("docs/quickstart.md"));
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
      "stripped before `POST /v1/deployments`",
      "resources[i].workflowRef must have string {file, job, artifact}",
    ]
  ) {
    assert.ok(workflowRef.includes(snippet), `workflowRef missing ${snippet}`);
  }
});

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, root));
}
