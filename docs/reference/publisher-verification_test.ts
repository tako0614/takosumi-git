import assert from "node:assert/strict";

const root = new URL("../../", import.meta.url);

Deno.test("publisher verification minimum spec matches preview vocabulary", async () => {
  const spec = await read("docs/reference/publisher-verification.md");
  const appSpec = await read("docs/reference/app-yml-spec.md");
  const installSource = await read("packages/cli/src/install.ts");

  for (
    const snippet of [
      "metadata.publisher",
      "metadata.homepage",
      "metadata.signingKeyFingerprint",
      "resolved source commit",
      "app manifest digest",
      "_takosumi-publisher.<homepage-host>",
      "takosumi-publisher=v1 publisher=<publisher> key=<signingKeyFingerprint>",
      "publisher.verified",
      "publisher is not verified",
      "cross-instance federation",
      "GitHub organization ownership",
    ]
  ) {
    assert.ok(spec.includes(snippet), `publisher spec missing ${snippet}`);
  }

  for (
    const snippet of [
      "metadata.publisher",
      "metadata.homepage",
      "metadata.signingKeyFingerprint",
    ]
  ) {
    assert.ok(appSpec.includes(snippet), `app yml spec missing ${snippet}`);
  }

  for (
    const snippet of [
      "publisher: {",
      "verified:",
      "PublisherVerificationRecord",
      "signingKeyFingerprint",
      "publisher is not verified",
    ]
  ) {
    assert.ok(
      installSource.includes(snippet),
      `install source missing ${snippet}`,
    );
  }
});

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, root));
}
