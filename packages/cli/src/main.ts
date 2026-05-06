/**
 * `@takos/takosumi-git-cli`
 *
 * CLI entrypoint for `takosumi-git`. The `push` subcommand is wired to a
 * real implementation that resolves `.takosumi/manifest.yml` plus the
 * referenced workflows and submits the cleaned manifest to the takosumi
 * kernel via `POST /v1/deployments`. `history` reads manifest git history.
 * `serve` receives git webhooks and dispatches push.
 */

import { runPushCli } from "./push.ts";
import { runInitCli } from "./init.ts";
import { runHistoryCli } from "./history.ts";
import { runServeCli } from "./serve.ts";

const VERSION = "0.3.0";

const HELP_TEXT = `takosumi-git ${VERSION}

Bridge between a git repository and the takosumi manifest deploy engine.

USAGE:
  takosumi-git <command> [options]

COMMANDS:
  init        Scaffold .takosumi/manifest.yml and workflows in this repo
  push        Resolve .takosumi/manifest.yml + workflows and submit to takosumi
  serve       Run a webhook receiver that auto-pushes on git events
  history     Show manifest version history
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

HISTORY OPTIONS:
  --cwd <dir>                  git repository root (default .)
  --manifest <path>            manifest YAML (default .takosumi/manifest.yml)
  --resource <name>            show semantic YAML diff for one resources[].name
  --limit <n>                  maximum manifest commits to read (default 20)

SERVE OPTIONS:
  --host <host>                listen host (default 0.0.0.0)
  --port <port>                listen port (default 8788)
  --endpoint <url>             takosumi kernel endpoint (or TAKOSUMI_ENDPOINT)
  --token <token>              bearer token (or TAKOSUMI_TOKEN)
  --webhook-secret <secret>    HMAC secret (or TAKOSUMI_GIT_WEBHOOK_SECRET)
  --manifest <path>            manifest YAML (default .takosumi/manifest.yml)
  --workflows-dir <path>       workflows dir (default .takosumi/workflows)
  --artifact-contract <v0|v1|auto>
                               artifact URI resolver for dispatched push
  --rate-limit <n>             max requests per rate window (default 60)
  --rate-limit-window-ms <n>   rate window milliseconds (default 60000)

GLOBAL OPTIONS:
  -h, --help     Show help
  -v, --version  Print version
`;

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
  if (first === "history") {
    return await runHistoryCli(rest);
  }
  if (first === "serve") {
    return await runServeCli(rest);
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
