/**
 * `@takos/takosumi-git-cli`
 *
 * CLI entrypoint for `takosumi-git`. Phase 2 skeleton — only `--help`
 * and `--version` are wired. `push` / `serve` / `history` subcommands
 * print a "not yet implemented" notice.
 */

const VERSION = "0.0.1";

const HELP_TEXT = `takosumi-git ${VERSION}

Bridge between a git repository and the takosumi manifest deploy engine.

USAGE:
  takosumi-git <command> [options]

COMMANDS:
  push        Resolve .takosumi/manifest.yml + workflows and submit to takosumi
  serve       Run a webhook receiver that auto-pushes on git events
  history     Show manifest version history (git history of manifest file)
  help        Show this help
  version     Print version

GLOBAL OPTIONS:
  -h, --help     Show help
  -v, --version  Print version

Phase 2 skeleton: subcommands are stubbed.
`;

const NOT_IMPLEMENTED = (cmd: string) =>
  `takosumi-git ${cmd}: not yet implemented (Phase 2 skeleton)\n`;

export function run(args: readonly string[]): number {
  const [first, ...rest] = args;
  if (!first || first === "help" || first === "-h" || first === "--help") {
    Deno.stdout.writeSync(new TextEncoder().encode(HELP_TEXT));
    return 0;
  }
  if (first === "version" || first === "-v" || first === "--version") {
    Deno.stdout.writeSync(new TextEncoder().encode(`${VERSION}\n`));
    return 0;
  }
  if (first === "push" || first === "serve" || first === "history") {
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
  Deno.exit(run(Deno.args));
}
