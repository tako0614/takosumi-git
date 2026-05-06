import { assertEquals, assertStringIncludes } from "@std/assert";
import { type GitRunner, history, parseHistoryArgs } from "./history.ts";

function fakeGit(
  responses: Record<string, { code?: number; stdout: string; stderr?: string }>,
): GitRunner {
  return (args) => {
    const key = args.join("\0");
    const response = responses[key];
    if (!response) {
      return Promise.resolve({
        code: 1,
        stdout: "",
        stderr: `unexpected git args: ${args.join(" ")}`,
      });
    }
    return Promise.resolve({
      code: response.code ?? 0,
      stdout: response.stdout,
      stderr: response.stderr ?? "",
    });
  };
}

function key(...args: string[]): string {
  return args.join("\0");
}

const LOG_OUTPUT =
  "2222222222222222222222222222222222222222\t2222222\t2026-05-07T12:00:00Z\tupdate web image\n" +
  "1111111111111111111111111111111111111111\t1111111\t2026-05-07T11:00:00Z\tadd web\n";

const MANIFEST_V1 = `
apiVersion: "1.0"
kind: Manifest
resources:
  - name: web
    shape: web-service@v1
    provider: "@takos/cloudflare-container"
    spec:
      image: ghcr.io/example/web@sha256:1111
      port: 8080
  - name: db
    shape: object-store@v1
    spec:
      name: app-data
`;

const MANIFEST_V2 = `
apiVersion: "1.0"
kind: Manifest
resources:
  - name: web
    shape: web-service@v1
    provider: "@takos/cloudflare-container"
    spec:
      image: ghcr.io/example/web@sha256:2222
      port: 8080
  - name: db
    shape: object-store@v1
    spec:
      name: app-data
`;

Deno.test("history lists manifest commits", async () => {
  let output = "";
  await history({
    cwd: "/repo",
    manifestPath: ".takosumi/manifest.yml",
    limit: 20,
    stdout: (text) => {
      output += text;
    },
    git: fakeGit({
      [
        key(
          "log",
          "-n20",
          "--format=%H%x09%h%x09%cI%x09%s",
          "--",
          ".takosumi/manifest.yml",
        )
      ]: {
        stdout: LOG_OUTPUT,
      },
    }),
  });

  assertStringIncludes(
    output,
    "2222222\t2026-05-07T12:00:00Z\tupdate web image",
  );
  assertStringIncludes(output, "1111111\t2026-05-07T11:00:00Z\tadd web");
});

Deno.test("history --resource renders semantic YAML diff", async () => {
  let output = "";
  await history({
    cwd: "/repo",
    manifestPath: ".takosumi/manifest.yml",
    resource: "web",
    limit: 20,
    stdout: (text) => {
      output += text;
    },
    git: fakeGit({
      [
        key(
          "log",
          "-n20",
          "--format=%H%x09%h%x09%cI%x09%s",
          "--",
          ".takosumi/manifest.yml",
        )
      ]: {
        stdout: LOG_OUTPUT,
      },
      [
        key(
          "show",
          "2222222222222222222222222222222222222222:.takosumi/manifest.yml",
        )
      ]: {
        stdout: MANIFEST_V2,
      },
      [
        key(
          "show",
          "1111111111111111111111111111111111111111:.takosumi/manifest.yml",
        )
      ]: {
        stdout: MANIFEST_V1,
      },
    }),
  });

  assertStringIncludes(
    output,
    "2222222\t2026-05-07T12:00:00Z\tupdate web image",
  );
  assertStringIncludes(output, "resource web");
  assertStringIncludes(output, "-   image: 'ghcr.io/example/web@sha256:1111'");
  assertStringIncludes(output, "+   image: 'ghcr.io/example/web@sha256:2222'");
});

Deno.test("parseHistoryArgs validates limit and resource option", () => {
  const parsed = parseHistoryArgs([
    "--cwd",
    "/repo",
    "--manifest",
    ".takosumi/custom.yml",
    "--resource",
    "web",
    "--limit",
    "5",
  ]);

  assertEquals(parsed.cwd, "/repo");
  assertEquals(parsed.manifestPath, ".takosumi/custom.yml");
  assertEquals(parsed.resource, "web");
  assertEquals(parsed.limit, 5);
});
