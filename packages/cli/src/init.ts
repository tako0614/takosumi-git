/**
 * `takosumi-git init` implementation.
 *
 * Scaffolds the canonical `.takosumi/` project layout in a target directory:
 *
 *   <cwd>/
 *   └── .takosumi/
 *       ├── manifest.yml           (deploy intent, the only file submitted to takosumi)
 *       └── workflows/
 *           └── build.yml          (workflow referenced by compute.<name>.workflowRef)
 *
 * The `.takosumi/` convention is owned by takosumi-git, NOT by the takosumi
 * kernel. The kernel takes manifests by explicit path or HTTP body and has
 * no opinion on file layout. This command is the single official way to
 * bootstrap that layout.
 */

import { parseArgs } from "@std/cli/parse-args";
import { basename, dirname, isAbsolute, join, resolve } from "@std/path";

export interface InitOptions {
  /** Project root in which `.takosumi/` will be created. */
  readonly cwd: string;
  /** Value substituted into `metadata.name`. */
  readonly name: string;
  /** Overwrite existing `.takosumi/manifest.yml` if true. */
  readonly force: boolean;
  /** Captures stdout for tests. Defaults to `Deno.stdout.writeSync`. */
  readonly stdout?: (text: string) => void;
  /** Captures stderr for tests. Defaults to `Deno.stderr.writeSync`. */
  readonly stderr?: (text: string) => void;
}

export interface InitResult {
  readonly manifestPath: string;
  readonly workflowPath: string;
  readonly overwritten: boolean;
}

export function manifestSkeleton(name: string): string {
  return `apiVersion: "1.0"
kind: Manifest
metadata:
  name: ${name}
  labels:
    managed-by: takosumi-git
# resources[] declares the runtime shape of your application.
# image URIs in compute resources are resolved by takosumi-git from the
# referenced workflow before submission to the takosumi kernel.
resources:
  - shape: web-service@v1
    name: web
    provider: "@takos/cloudflare-container"
    spec:
      image: ghcr.io/example/app@sha256:0000000000000000000000000000000000000000000000000000000000000000
      port: 8080
    # workflowRef is a takosumi-git private extension; it is parsed by
    # takosumi-git, used to resolve \`image\` from the workflow output, and
    # stripped before the manifest is POSTed to takosumi.
    workflowRef:
      file: build.yml
      job: build
      artifact: image
`;
}

export function workflowSkeleton(): string {
  return `version: "0"
jobs:
  - name: build
    steps:
      - name: build-and-push
        # takosumi-git captures the LAST non-empty stdout line as the
        # artifact URI. Make sure your build script ends by echoing the
        # digest-pinned image URI (e.g. ghcr.io/<org>/<app>@sha256:...).
        run: |
          # docker buildx build --push -t ghcr.io/<org>/<app>:latest .
          # docker images --no-trunc --quiet ghcr.io/<org>/<app>:latest
          echo "ghcr.io/example/app@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    artifact:
      name: image
`;
}

function resolveCwd(cwd: string): string {
  return isAbsolute(cwd) ? cwd : resolve(cwd);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

export async function init(options: InitOptions): Promise<InitResult> {
  const projectRoot = resolveCwd(options.cwd);
  const takosumiDir = join(projectRoot, ".takosumi");
  const workflowsDir = join(takosumiDir, "workflows");
  const manifestPath = join(takosumiDir, "manifest.yml");
  const workflowPath = join(workflowsDir, "build.yml");

  const stdout = options.stdout ?? ((text: string) => {
    Deno.stdout.writeSync(new TextEncoder().encode(text));
  });

  const manifestExists = await exists(manifestPath);
  if (manifestExists && !options.force) {
    throw new InitRefusedError(
      `already initialized at ${manifestPath}; pass --force to overwrite`,
    );
  }

  await Deno.mkdir(workflowsDir, { recursive: true });
  await Deno.writeTextFile(manifestPath, manifestSkeleton(options.name));
  await Deno.writeTextFile(workflowPath, workflowSkeleton());

  stdout(`takosumi-git init: wrote ${manifestPath}\n`);
  stdout(`takosumi-git init: wrote ${workflowPath}\n`);
  if (manifestExists) {
    stdout(`takosumi-git init: overwrote existing files (--force)\n`);
  }

  return {
    manifestPath,
    workflowPath,
    overwritten: manifestExists,
  };
}

export class InitRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitRefusedError";
  }
}

export interface ParsedInitArgs {
  readonly cwd: string;
  readonly name: string;
  readonly force: boolean;
}

export function parseInitArgs(args: readonly string[]): ParsedInitArgs {
  const flags = parseArgs(args as string[], {
    string: ["cwd", "name"],
    boolean: ["force"],
    default: {
      cwd: ".",
      force: false,
    },
  });
  const cwd = resolveCwd(flags.cwd as string);
  const name = (flags.name as string | undefined) ?? defaultName(cwd);
  return {
    cwd,
    name,
    force: Boolean(flags.force),
  };
}

function defaultName(projectRoot: string): string {
  const base = basename(projectRoot);
  if (base.length > 0 && base !== "." && base !== "/") return base;
  // Fallback for unusual roots (e.g. cwd === "/"): use parent's name or
  // a sensible literal.
  const parent = basename(dirname(projectRoot));
  return parent.length > 0 ? parent : "app";
}

export async function runInitCli(args: readonly string[]): Promise<number> {
  let parsed: ParsedInitArgs;
  try {
    parsed = parseInitArgs(args);
  } catch (e) {
    Deno.stderr.writeSync(
      new TextEncoder().encode(`takosumi-git init: ${(e as Error).message}\n`),
    );
    return 64;
  }
  try {
    await init(parsed);
    return 0;
  } catch (e) {
    if (e instanceof InitRefusedError) {
      Deno.stderr.writeSync(
        new TextEncoder().encode(`takosumi-git init: ${e.message}\n`),
      );
      return 1;
    }
    Deno.stderr.writeSync(
      new TextEncoder().encode(`takosumi-git init: ${(e as Error).message}\n`),
    );
    return 1;
  }
}
