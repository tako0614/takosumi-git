import { assertEquals } from "@std/assert";
import type { WorkflowFile } from "@takos/takosumi-git-workflow-contract";
import { runWorkflow, type StepContext } from "./mod.ts";

const workflow: WorkflowFile = {
  version: "0",
  jobs: [{
    name: "build",
    steps: [
      { name: "compile", run: "deno task build" },
      { name: "publish", run: "deno task publish" },
    ],
    artifact: { name: "image" },
  }],
};

Deno.test("runWorkflow executes steps in order and resolves the declared artifact", async () => {
  const calls: Array<{ run: string; context: StepContext }> = [];
  const result = await runWorkflow({
    file: workflow,
    job: "build",
    event: { kind: "manual", source: "test" },
    executor: (run, context) => {
      calls.push({ run, context });
      return Promise.resolve({
        stdout: `ok:${context.step}`,
        exitCode: 0,
      });
    },
    resolveArtifact: (job) =>
      Promise.resolve({
        name: job.artifact?.name ?? "image",
        uri:
          "ghcr.io/example/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      }),
  });

  assertEquals(result.success, true);
  assertEquals(result.artifact?.name, "image");
  assertEquals(calls.map((call) => call.run), [
    "deno task build",
    "deno task publish",
  ]);
  assertEquals(calls.map((call) => call.context.step), [
    "compile",
    "publish",
  ]);
  assertEquals(result.logs, [
    "step compile: exit=0",
    "ok:compile",
    "step publish: exit=0",
    "ok:publish",
  ]);
});

Deno.test("runWorkflow stops on the first failing step", async () => {
  let resolvedArtifact = false;
  const result = await runWorkflow({
    file: workflow,
    job: "build",
    event: { kind: "manual", source: "test" },
    executor: (_run, context) =>
      Promise.resolve({
        stdout: `step:${context.step}`,
        exitCode: context.step === "compile" ? 1 : 0,
      }),
    resolveArtifact: () => {
      resolvedArtifact = true;
      return Promise.resolve({ name: "image", uri: "unused" });
    },
  });

  assertEquals(result.success, false);
  assertEquals(result.artifact, undefined);
  assertEquals(resolvedArtifact, false);
  assertEquals(result.logs, [
    "step compile: exit=1",
    "step:compile",
  ]);
});

Deno.test("runWorkflow reports missing jobs without executing", async () => {
  let executed = false;
  const result = await runWorkflow({
    file: workflow,
    job: "release",
    event: { kind: "manual", source: "test" },
    executor: () => {
      executed = true;
      return Promise.resolve({ stdout: "", exitCode: 0 });
    },
    resolveArtifact: () => Promise.resolve({ name: "image", uri: "unused" }),
  });

  assertEquals(executed, false);
  assertEquals(result, {
    job: "release",
    success: false,
    logs: ["job 'release' not found in workflow file"],
  });
});
