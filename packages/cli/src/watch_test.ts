import { assertEquals } from "@std/assert";
import { resolve } from "@std/path";
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
