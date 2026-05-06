import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { init, InitRefusedError, runInitCli } from "./init.ts";

interface TempProject {
  readonly root: string;
  cleanup(): Promise<void>;
}

async function makeTempProject(
  prefix = "takosumi-git-init-",
): Promise<TempProject> {
  const root = await Deno.makeTempDir({ prefix });
  return {
    root,
    async cleanup() {
      await Deno.remove(root, { recursive: true });
    },
  };
}

Deno.test("init scaffolds .takosumi/manifest.yml and workflows/build.yml", async () => {
  const project = await makeTempProject();
  try {
    const result = await init({
      cwd: project.root,
      name: "demo",
      force: false,
      stdout: () => {},
    });

    assertEquals(
      result.manifestPath,
      join(project.root, ".takosumi", "manifest.yml"),
    );
    assertEquals(
      result.workflowPath,
      join(project.root, ".takosumi", "workflows", "build.yml"),
    );
    assertEquals(result.overwritten, false);

    const manifest = await Deno.readTextFile(result.manifestPath);
    assertStringIncludes(manifest, 'apiVersion: "1.0"');
    assertStringIncludes(manifest, "kind: Manifest");
    assertStringIncludes(manifest, "name: demo");
    assertStringIncludes(manifest, "managed-by: takosumi-git");
    assertStringIncludes(manifest, "workflowRef:");

    const workflow = await Deno.readTextFile(result.workflowPath);
    assertStringIncludes(workflow, 'version: "0"');
    assertStringIncludes(workflow, "name: build");
    assertStringIncludes(workflow, "TAKOSUMI_ARTIFACT=");
    assertStringIncludes(workflow, "artifact:");
    assertStringIncludes(workflow, "name: image");
  } finally {
    await project.cleanup();
  }
});

Deno.test("init refuses to overwrite existing manifest without --force", async () => {
  const project = await makeTempProject();
  try {
    await init({
      cwd: project.root,
      name: "demo",
      force: false,
      stdout: () => {},
    });

    await assertRejects(
      () =>
        init({
          cwd: project.root,
          name: "demo",
          force: false,
          stdout: () => {},
        }),
      InitRefusedError,
      "already initialized",
    );
  } finally {
    await project.cleanup();
  }
});

Deno.test("init --force overwrites existing manifest", async () => {
  const project = await makeTempProject();
  try {
    await init({
      cwd: project.root,
      name: "first",
      force: false,
      stdout: () => {},
    });

    const result = await init({
      cwd: project.root,
      name: "second",
      force: true,
      stdout: () => {},
    });
    assertEquals(result.overwritten, true);

    const manifest = await Deno.readTextFile(result.manifestPath);
    assertStringIncludes(manifest, "name: second");
    assert(!manifest.includes("name: first"), "old name must be replaced");
  } finally {
    await project.cleanup();
  }
});

Deno.test("init --name substitutes metadata.name", async () => {
  const project = await makeTempProject();
  try {
    const result = await init({
      cwd: project.root,
      name: "my-cool-app",
      force: false,
      stdout: () => {},
    });
    const manifest = await Deno.readTextFile(result.manifestPath);
    assertStringIncludes(manifest, "name: my-cool-app");
  } finally {
    await project.cleanup();
  }
});

Deno.test("runInitCli returns 0 on first run and non-zero on refusal", async () => {
  const project = await makeTempProject();
  // Capture stderr written by runInitCli to keep test output clean.
  const originalStderrWrite = Deno.stderr.writeSync.bind(Deno.stderr);
  const captured: string[] = [];
  (Deno.stderr as { writeSync: (p: Uint8Array) => number }).writeSync = (
    p: Uint8Array,
  ) => {
    captured.push(new TextDecoder().decode(p));
    return p.byteLength;
  };
  // Capture stdout too.
  const originalStdoutWrite = Deno.stdout.writeSync.bind(Deno.stdout);
  (Deno.stdout as { writeSync: (p: Uint8Array) => number }).writeSync = (
    p: Uint8Array,
  ) => p.byteLength;
  try {
    const okCode = await runInitCli(["--cwd", project.root, "--name", "x"]);
    assertEquals(okCode, 0);
    const refuseCode = await runInitCli(["--cwd", project.root, "--name", "x"]);
    assertEquals(refuseCode, 1);
    assert(
      captured.join("").includes("already initialized"),
      "must mention already initialized",
    );
    const forceCode = await runInitCli([
      "--cwd",
      project.root,
      "--name",
      "x",
      "--force",
    ]);
    assertEquals(forceCode, 0);
  } finally {
    (Deno.stderr as { writeSync: (p: Uint8Array) => number }).writeSync =
      originalStderrWrite;
    (Deno.stdout as { writeSync: (p: Uint8Array) => number }).writeSync =
      originalStdoutWrite;
    await project.cleanup();
  }
});

Deno.test("init defaults metadata.name to basename of cwd when --name omitted", async () => {
  // Create a temp dir with a known basename by nesting a child dir.
  const parent = await Deno.makeTempDir({
    prefix: "takosumi-git-init-parent-",
  });
  const child = join(parent, "my-project");
  await Deno.mkdir(child);
  try {
    // Use runInitCli to exercise the default-name path.
    const originalStdoutWrite = Deno.stdout.writeSync.bind(Deno.stdout);
    (Deno.stdout as { writeSync: (p: Uint8Array) => number }).writeSync = (
      p: Uint8Array,
    ) => p.byteLength;
    try {
      const code = await runInitCli(["--cwd", child]);
      assertEquals(code, 0);
    } finally {
      (Deno.stdout as { writeSync: (p: Uint8Array) => number }).writeSync =
        originalStdoutWrite;
    }
    const manifest = await Deno.readTextFile(
      join(child, ".takosumi", "manifest.yml"),
    );
    assertStringIncludes(manifest, "name: my-project");
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});
