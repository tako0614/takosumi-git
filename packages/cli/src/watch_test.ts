import { assertEquals } from "@std/assert";
import { join, resolve } from "@std/path";
import { parseWatchArgs, watchDeployIntentRepo } from "./watch.ts";

Deno.test("watchDeployIntentRepo dispatches push when HEAD changes", async () => {
  const commits = [
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  ];
  let headReads = 0;
  const pushed: unknown[] = [];
  const stdout: string[] = [];
  const result = await watchDeployIntentRepo({
    cwd: "/tmp/deploy-repo",
    endpoint: "http://kernel.example",
    token: "deploy-token",
    manifestPath: ".takosumi/manifest.yml",
    workflowsDir: ".takosumi/workflows",
    mode: "apply",
    artifactContract: "v1",
    dryRun: false,
    pollIntervalMs: 1,
    once: true,
    git: (args) => {
      assertEquals(args, ["rev-parse", "HEAD"]);
      const commit = commits[Math.min(headReads, commits.length - 1)];
      headReads += 1;
      return Promise.resolve({ code: 0, stdout: `${commit}\n` });
    },
    sleep: () => Promise.resolve(),
    stdout: (line) => stdout.push(line),
    pushImpl: (options) => {
      pushed.push(options);
      return Promise.resolve({
        manifest: {},
        resolved: [],
        response: { status: 200, body: { ok: true } },
      });
    },
  });

  assertEquals(result.observedHead, commits[1]);
  assertEquals(result.deployments, [{ commit: commits[1], status: 200 }]);
  assertEquals(pushed.length, 1);
  const pushOptions = pushed[0] as {
    manifestPath: string;
    workflowsDir: string;
    event?: { kind: string; source: string; payload?: { commit?: string } };
  };
  assertEquals(
    pushOptions.manifestPath,
    resolve("/tmp/deploy-repo", ".takosumi/manifest.yml"),
  );
  assertEquals(
    pushOptions.workflowsDir,
    resolve("/tmp/deploy-repo", ".takosumi/workflows"),
  );
  assertEquals(pushOptions.event?.kind, "git-push");
  assertEquals(pushOptions.event?.source, "takosumi-git watch");
  assertEquals(pushOptions.event?.payload?.commit, commits[1]);
  assertEquals(
    stdout.includes(`takosumi-git watch: detected commit ${commits[1]}\n`),
    true,
  );
});

Deno.test("watchDeployIntentRepo can run current commit once", async () => {
  const commit = "cccccccccccccccccccccccccccccccccccccccc";
  const pushed: unknown[] = [];
  const result = await watchDeployIntentRepo({
    cwd: "/tmp/deploy-repo",
    endpoint: "http://kernel.example",
    token: "deploy-token",
    manifestPath: ".takosumi/manifest.yml",
    workflowsDir: ".takosumi/workflows",
    mode: "apply",
    artifactContract: "v1",
    dryRun: false,
    pollIntervalMs: 1,
    once: true,
    runCurrent: true,
    git: () => Promise.resolve({ code: 0, stdout: `${commit}\n` }),
    sleep: () => Promise.resolve(),
    stdout: () => {},
    pushImpl: (options) => {
      pushed.push(options);
      return Promise.resolve({
        manifest: {},
        resolved: [],
        response: { status: 202, body: { ok: true } },
      });
    },
  });

  assertEquals(result.observedHead, commit);
  assertEquals(result.deployments, [{ commit, status: 202 }]);
  assertEquals(pushed.length, 1);
});

Deno.test("watchDeployIntentRepo runs workflow push on changed HEAD", async () => {
  const root = await Deno.makeTempDir({ prefix: "takosumi-git-watch-" });
  const firstCommit = "1111111111111111111111111111111111111111";
  const secondCommit = "2222222222222222222222222222222222222222";
  let headReads = 0;
  let deploymentBody: Record<string, unknown> | undefined;
  try {
    await Deno.mkdir(join(root, ".takosumi", "workflows"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(root, ".takosumi", "manifest.yml"),
      `apiVersion: "1.0"
kind: Manifest
metadata:
  name: watch-fixture
resources:
  - shape: web-service@v1
    name: api
    provider: container
    workflowRef:
      file: build.yml
      job: build
      artifact: image
    spec:
      image: ghcr.io/example/watch-placeholder@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
`,
    );
    await Deno.writeTextFile(
      join(root, ".takosumi", "workflows", "build.yml"),
      `version: "0"
name: build
jobs:
  - name: build
    steps:
      - name: emit
        run: echo artifact
    artifact:
      name: image
`,
    );

    const result = await watchDeployIntentRepo({
      cwd: root,
      endpoint: "http://kernel.example",
      token: "deploy-token",
      manifestPath: ".takosumi/manifest.yml",
      workflowsDir: ".takosumi/workflows",
      mode: "apply",
      artifactContract: "v1",
      dryRun: false,
      pollIntervalMs: 1,
      once: true,
      git: (args) => {
        const key = args.join(" ");
        if (key === "rev-parse HEAD") {
          const commit = headReads === 0 ? firstCommit : secondCommit;
          headReads += 1;
          return Promise.resolve({ code: 0, stdout: `${commit}\n` });
        }
        if (key === "rev-parse --abbrev-ref HEAD") {
          return Promise.resolve({ code: 0, stdout: "main\n" });
        }
        if (key === "config --get remote.origin.url") {
          return Promise.resolve({
            code: 0,
            stdout: "https://git.example.test/deploy.git\n",
          });
        }
        return Promise.resolve({ code: 1, stdout: "" });
      },
      executorFactory: () => () =>
        Promise.resolve({
          stdout:
            "TAKOSUMI_ARTIFACT=ghcr.io/example/watch@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
          exitCode: 0,
        }),
      fetch: async (input, init) => {
        deploymentBody = await new Request(input, init).json() as Record<
          string,
          unknown
        >;
        return Response.json({ ok: true });
      },
      sleep: () => Promise.resolve(),
      stdout: () => {},
    });

    assertEquals(result.deployments, [{ commit: secondCommit, status: 200 }]);
    const body = deploymentBody!;
    assertEquals(body.mode, "apply");
    const manifest = body.manifest as {
      resources: Array<{ workflowRef?: unknown; spec: { image: string } }>;
    };
    assertEquals(
      manifest.resources[0].spec.image,
      "ghcr.io/example/watch@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    assertEquals("workflowRef" in manifest.resources[0], false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("parseWatchArgs reads kernel config from env", () => {
  const parsed = parseWatchArgs([
    "--cwd",
    "/repo",
    "--once",
    "--run-current",
    "--poll-interval-ms",
    "250",
    "--artifact-contract",
    "auto",
  ], {
    get(key: string) {
      const values: Record<string, string> = {
        TAKOSUMI_ENDPOINT: "http://kernel.example",
        TAKOSUMI_TOKEN: "deploy-token",
      };
      return values[key];
    },
  });

  assertEquals(parsed.cwd, "/repo");
  assertEquals(parsed.endpoint, "http://kernel.example");
  assertEquals(parsed.token, "deploy-token");
  assertEquals(parsed.once, true);
  assertEquals(parsed.runCurrent, true);
  assertEquals(parsed.pollIntervalMs, 250);
  assertEquals(parsed.artifactContract, "auto");
});

Deno.test("parseWatchArgs requires deploy config unless dry-run", () => {
  const emptyEnv = { get: (_key: string) => undefined };
  assertThrowsMessage(
    () => parseWatchArgs([], emptyEnv),
    "missing --endpoint",
  );
  const dryRun = parseWatchArgs(["--dry-run"], emptyEnv);
  assertEquals(dryRun.dryRun, true);
});

function assertThrowsMessage(fn: () => unknown, message: string): void {
  try {
    fn();
  } catch (error) {
    assertEquals(error instanceof Error, true);
    assertEquals((error as Error).message.includes(message), true);
    return;
  }
  throw new Error(`expected function to throw ${message}`);
}
