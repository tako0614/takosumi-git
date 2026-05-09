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
import { runInstallCli } from "./install.ts";
import { runRollbackCli, runUpgradeCli } from "./revision.ts";

const VERSION = "0.3.0";

const HELP_TEXT = `takosumi-git ${VERSION}

Bridge between a git repository and the takosumi manifest deploy engine.

USAGE:
  takosumi-git <command> [options]

COMMANDS:
  init        Scaffold .takosumi/app.yml, manifest.yml, and workflows
  push        Resolve .takosumi/manifest.yml + workflows and submit to takosumi
  install     Install .takosumi/app.yml metadata from a local repo or Git URL
  upgrade     Preview or apply an AppInstallation source revision
  rollback    Preview or apply an AppInstallation rollback revision
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
  --service-resolver-url <url> service descriptor anchor URL
  --service-resolver-public-key <key>
                               Ed25519 public key for the anchor
  --dry-run                    run workflows but skip POST; print resolved manifest

INSTALL OPTIONS:
  [<git-url>]                  create an AppInstallation in Takosumi Accounts
  preview [<git-url>]          parse .takosumi/app.yml and print install preview
  apply [<git-url>]            explicit form of the default install action
  --cwd <dir>                  project root (default .)
  --app <path>                 InstallableApp YAML (default .takosumi/app.yml)
  --manifest <path>            kernel manifest path override
  --git-url <url>              Git source URL (or positional <git-url>)
  --ref <ref>                  immutable tag/ref/full SHA for Git URL install
  --accounts-url <url>         Takosumi Accounts URL for apply
  --account-id <id>            ledger account id for apply
  --space-id <id>              target space id for apply
  --subject <tsub_...>         installer subject for apply
  --mode <mode>                shared-cell | dedicated | self-hosted
  --source-commit <sha>        resolved 40-char source commit pin
  --runtime-base-url <url>     app runtime base URL for OIDC redirects
  --endpoint <url>             takosumi kernel endpoint for deploy
  --deploy-token <token>       kernel deploy token
  --service-resolver-url <url> service descriptor anchor URL
  --service-resolver-public-key <key>
                               Ed25519 public key for the anchor
  --json                       print preview JSON

UPGRADE / ROLLBACK OPTIONS:
  upgrade <id> --ref <ref>     preview an upgrade target
  rollback <id> --to <ref>     preview a rollback target
  --accounts-url <url>         Takosumi Accounts URL
  --git-url <url>              source Git URL override
  --apply                      POST the revision to Takosumi Accounts
  --json                       print JSON

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
  --webhook-mode <push|install>
                               dispatch verified webhooks through push or install
  --manifest <path>            manifest YAML (default .takosumi/manifest.yml)
  --workflows-dir <path>       workflows dir (default .takosumi/workflows)
  --artifact-contract <v0|v1|auto>
                               artifact URI resolver for dispatched push
  --service-resolver-url <url> service descriptor anchor URL
  --service-resolver-public-key <key>
                               Ed25519 public key for the anchor
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
  if (first === "install") {
    return await runInstallCli(rest);
  }
  if (first === "upgrade") {
    return await runUpgradeCli(rest);
  }
  if (first === "rollback") {
    return await runRollbackCli(rest);
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
