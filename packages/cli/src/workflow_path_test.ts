import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { resolveWorkflowFilePath } from "./workflow_path.ts";

Deno.test("resolveWorkflowFilePath accepts files inside workflows directory", async () => {
  const root = await Deno.makeTempDir({
    prefix: "takosumi-git-workflow-path-",
  });
  try {
    const workflowsDir = join(root, ".takosumi", "workflows");
    await Deno.mkdir(workflowsDir, { recursive: true });
    const workflowPath = join(workflowsDir, "build.yml");
    await Deno.writeTextFile(workflowPath, "version: '0'\n");

    assertEquals(
      await resolveWorkflowFilePath(
        workflowsDir,
        "build.yml",
        "resources[0].workflowRef.file",
      ),
      await Deno.realPath(workflowPath),
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("resolveWorkflowFilePath rejects symlink escapes", async () => {
  const root = await Deno.makeTempDir({
    prefix: "takosumi-git-workflow-path-",
  });
  try {
    const workflowsDir = join(root, ".takosumi", "workflows");
    await Deno.mkdir(workflowsDir, { recursive: true });
    const outside = join(root, ".takosumi", "outside.yml");
    const link = join(workflowsDir, "outside.yml");
    await Deno.writeTextFile(outside, "version: '0'\n");
    await Deno.symlink(outside, link);

    await assertRejects(
      () =>
        resolveWorkflowFilePath(
          workflowsDir,
          "outside.yml",
          "resources[0].workflowRef.file",
        ),
      Error,
      "resources[0].workflowRef.file must be a relative path inside workflows directory",
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
