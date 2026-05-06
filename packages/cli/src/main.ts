/**
 * `@takos/takosumi-git-cli`
 *
 * CLI entrypoint for `takosumi-git`. The `push` subcommand is wired to a
 * real implementation that resolves `.takosumi/manifest.yml` plus the
 * referenced workflows and submits the cleaned manifest to the takosumi
 * kernel via `POST /v1/deployments`. `serve` and `history` remain stubs.
 */

import { runPushCli } from "./push.ts";
import { runInitCli } from "./init.ts";

const VERSION = "0.3.0";

const HELP_TEXT = `takosumi-git ${VERSION}

Bridge between a git repository and the takosumi manifest deploy engine.

USAGE:
  takosumi-git <command> [options]

COMMANDS:
  init        Scaffold .takosumi/manifest.yml and workflows in this repo
  push        Resolve .takosumi/manifest.yml + workflows and submit to takosumi
  serve       Run a webhook receiver that auto-pushes on git events (stub)
  history     Show manifest version history (stub)
  help        Show this help
  version     Print version

INIT OPTIONS:
  --cwd <dir>                  project root to scaffold into (default .)
  --name <appname>             metadata.name in the manifest (default: basename of cwd)
  --force                      overwrite existing .takosumi/manifest.yml

PUSH OPTIONS:
  --endpoint <url>             takosumi kernel endpoint (or TAKOSUMI_ENDPOINT)
  --token <token>              bearer token (or TAKOSUMI_TOKEN)
  --manifest <path>            manifest YAML (default .takosumi/manifest.yml)
  --workflows-dir <path>       workflows dir (default .takosumi/workflows)
  --mode <apply|plan|destroy>  deploy mode (default apply)
  --artifact-contract <v0|v1|auto>
                               artifact URI resolver (default v1)
  --dry-run                    run workflows but skip POST; print resolved manifest

GLOBAL OPTIONS:
  -h, --help     Show help
  -v, --version  Print version
`;

const NOT_IMPLEMENTED = (cmd: string) =>
  `takosumi-git ${cmd}: not yet implemented\n`;

export async function run(args: readonly string[]): Promise<number> {
  const [first, ...rest] = args;
  if (!first || first === "help" || first === "-h" || first === "--help") {
    Deno.stdout.writeSync(new TextEncoder().encode(HELP_TEXT));
    return 0;
  }
  if (first === "version" || first === "-v" || first === "--version") {
    Deno.stdout.writeSync(new TextEncoder().encode(`${VERSION}\n`));
    return 0;
  }
  if (first === "init") {
    return await runInitCli(rest);
  }
  if (first === "push") {
    return await runPushCli(rest);
  }
  if (first === "serve" || first === "history") {
    Deno.stderr.writeSync(new TextEncoder().encode(NOT_IMPLEMENTED(first)));
    return 64;
  }
  Deno.stderr.writeSync(
    new TextEncoder().encode(`takosumi-git: unknown command '${first}'\n`),
  );
  if (rest.length > 0) {
    Deno.stderr.writeSync(
      new TextEncoder().encode(`  extra args: ${rest.join(" ")}\n`),
    );
  }
  return 64;
}

if (import.meta.main) {
  Deno.exit(await run(Deno.args));
}
