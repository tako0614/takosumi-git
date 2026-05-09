export interface JsrPublishPackage {
  readonly name: string;
  readonly version: string;
  readonly directory: string;
}

export const JSR_PUBLISH_PACKAGES: readonly JsrPublishPackage[] = Object.freeze(
  [
    {
      name: "@takos/takosumi-git-workflow-contract",
      version: "0.0.1",
      directory: "packages/workflow-contract",
    },
    {
      name: "@takos/takosumi-git-deploy-client",
      version: "0.0.1",
      directory: "packages/deploy-client",
    },
    {
      name: "@takos/takosumi-git-workflow-runner",
      version: "0.0.1",
      directory: "packages/workflow-runner",
    },
    {
      name: "@takos/takosumi-git-source",
      version: "0.0.1",
      directory: "packages/git-source",
    },
    {
      name: "@takos/takosumi-git-cli",
      version: "0.3.0",
      directory: "packages/cli",
    },
    {
      name: "@takos/takosumi-git",
      version: "0.0.1",
      directory: "packages/all",
    },
  ],
);

const decoder = new TextDecoder();

export async function runJsrPublish(options: {
  readonly root?: URL;
  readonly dryRun: boolean;
}): Promise<boolean> {
  const root = options.root ?? new URL("../", import.meta.url);
  let allOk = true;

  for (const packageInfo of JSR_PUBLISH_PACKAGES) {
    const ok = await runSinglePackagePublish(root, packageInfo, options.dryRun);
    allOk &&= ok;
  }

  return allOk;
}

async function runSinglePackagePublish(
  root: URL,
  packageInfo: JsrPublishPackage,
  dryRun: boolean,
): Promise<boolean> {
  const label = `${packageInfo.name}@${packageInfo.version}`;
  const cwd = new URL(`${packageInfo.directory}/`, root);
  const action = dryRun ? "dry-run" : "publish";
  const args = ["publish", "--quiet"];
  if (dryRun) args.push("--dry-run", "--allow-dirty");
  console.log(`${action} ${label}`);

  const output = await new Deno.Command(Deno.execPath(), {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = decoder.decode(output.stdout);
  const stderr = decoder.decode(output.stderr);

  if (!output.success) {
    console.error(`failed ${label}`);
    if (stdout.trim()) console.error(stdout.trimEnd());
    if (stderr.trim()) console.error(stderr.trimEnd());
    return false;
  }

  console.log(`ok ${label}`);
  return true;
}

if (import.meta.main) {
  const mode = parseMode(Deno.args);
  if (!mode) {
    console.error(
      "Usage: deno run --allow-run --allow-read scripts/jsr-publish.ts [--dry-run|--publish]",
    );
    Deno.exit(2);
  }
  const ok = await runJsrPublish({ dryRun: mode === "dry-run" });
  if (!ok) Deno.exit(1);
}

export function parseMode(
  args: readonly string[],
): "dry-run" | "publish" | null {
  if (args.length === 0) return "dry-run";
  if (args.length === 1 && args[0] === "--dry-run") return "dry-run";
  if (args.length === 1 && args[0] === "--publish") return "publish";
  return null;
}
