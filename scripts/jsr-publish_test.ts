import assert from "node:assert/strict";
import { JSR_PUBLISH_PACKAGES, parseMode } from "./jsr-publish.ts";

Deno.test("JSR publish package list is dependency ordered", () => {
  assert.deepEqual(
    JSR_PUBLISH_PACKAGES.map((packageInfo) => packageInfo.directory),
    [
      "packages/workflow-contract",
      "packages/deploy-client",
      "packages/workflow-runner",
      "packages/git-source",
      "packages/cli",
      "packages/all",
    ],
  );
});

Deno.test("JSR publish package list matches package metadata", async () => {
  for (const packageInfo of JSR_PUBLISH_PACKAGES) {
    const metadataPath = new URL(
      `../${packageInfo.directory}/deno.json`,
      import.meta.url,
    );
    const metadata = JSON.parse(await Deno.readTextFile(metadataPath)) as {
      name?: string;
      version?: string;
    };
    assert.equal(metadata.name, packageInfo.name);
    assert.equal(metadata.version, packageInfo.version);
  }
});

Deno.test("parseMode accepts explicit modes and rejects unknown args", () => {
  assert.equal(parseMode([]), "dry-run");
  assert.equal(parseMode(["--dry-run"]), "dry-run");
  assert.equal(parseMode(["--publish"]), "publish");
  assert.equal(parseMode(["--publish", "--dry-run"]), null);
  assert.equal(parseMode(["--unknown"]), null);
});
