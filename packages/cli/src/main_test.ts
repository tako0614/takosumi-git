import { assert, assertEquals, assertStringIncludes } from "@std/assert";

Deno.test("top-level help documents current install UX", async () => {
  const output = await runCli("--help");

  assertStringIncludes(
    output,
    "install     Preview/apply .takosumi/app.yml as an AppInstallation",
  );
  assertStringIncludes(output, "--preview-id <id>");
  assertStringIncludes(output, "--permission-digest <sha256:...>");
  assertStringIncludes(output, "--cost-ack");
  assertStringIncludes(output, "--launch-return-to <path>");
  assertStringIncludes(
    output,
    "--json                       print preview/apply JSON",
  );
  assertStringIncludes(output, "--artifact-contract <v1>");
  assert(!output.includes("--artifact-contract <v0|v1|auto>"));
});

Deno.test("top-level help documents import and webhook install flags", async () => {
  const output = await runCli("--help");

  assertStringIncludes(output, "bundle.tar.zst.age");
  assertStringIncludes(output, "--restore-data");
  assertStringIncludes(output, "--webhook-mode <push|install>");
  assertStringIncludes(output, "--accounts-url <url>");
  assertStringIncludes(output, "--accounts-token <token>");
  assertStringIncludes(output, "--space-id <id>");
});

async function runCli(...args: string[]): Promise<string> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-all",
      "packages/cli/src/main.ts",
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();

  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  assertEquals(stderr, "");
  assertEquals(output.code, 0);
  return stdout;
}
