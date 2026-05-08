/**
 * `takosumi-git init` implementation.
 *
 * Scaffolds the canonical `.takosumi/` project layout in a target directory:
 *
 *   <cwd>/
 *   └── .takosumi/
 *       ├── app.yml                (InstallableApp metadata read by takosumi-git)
 *       ├── manifest.yml           (deploy intent, the only file submitted to takosumi)
 *       └── workflows/
 *           └── build.yml          (workflow referenced by resources[i].workflowRef)
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
  readonly appPath: string;
  readonly manifestPath: string;
  readonly workflowPath: string;
  readonly overwritten: boolean;
}

export function appSkeleton(name: string): string {
  const id = installableAppId(name);
  return `apiVersion: app.takosumi.dev/v1
kind: InstallableApp
metadata:
  id: ${id}
  name: ${name}
  description: ${name} installable app
  publisher: example
  homepage: https://example.com
source:
  git: https://github.com/example/${id.split(".").at(-1)}
  ref: v0.1.0
entry:
  manifest: .takosumi/manifest.yml
runtime:
  modes:
    - shared-cell
    - dedicated
bindings:
  auth:
    type: identity.oidc@v1
    required: true
    redirectPaths:
      - /auth/oidc/callback
  bootstrap:
    type: install-launch-token@v1
    required: true
    consumePath: /_takosumi/launch
install:
  healthcheckPath: /health
  postInstallLaunchPath: /_takosumi/launch
permissions:
  requested: []
`;
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
        # Artifact URI contract v1: print TAKOSUMI_ARTIFACT=<uri> on stdout.
        # Use a digest-pinned image URI (e.g. ghcr.io/<org>/<app>@sha256:...).
        run: |
          # docker buildx build --push -t ghcr.io/<org>/<app>:latest .
          # docker images --no-trunc --quiet ghcr.io/<org>/<app>:latest
          echo "TAKOSUMI_ARTIFACT=ghcr.io/example/app@sha256:0000000000000000000000000000000000000000000000000000000000000000"
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
  const appPath = join(takosumiDir, "app.yml");
  const manifestPath = join(takosumiDir, "manifest.yml");
  const workflowPath = join(workflowsDir, "build.yml");

  const stdout = options.stdout ?? ((text: string) => {
    Deno.stdout.writeSync(new TextEncoder().encode(text));
  });

  const existingPath = await firstExistingPath([
    appPath,
    manifestPath,
    workflowPath,
  ]);
  if (existingPath && !options.force) {
    throw new InitRefusedError(
      `already initialized at ${existingPath}; pass --force to overwrite`,
    );
  }

  await Deno.mkdir(workflowsDir, { recursive: true });
  await Deno.writeTextFile(appPath, appSkeleton(options.name));
  await Deno.writeTextFile(manifestPath, manifestSkeleton(options.name));
  await Deno.writeTextFile(workflowPath, workflowSkeleton());

  stdout(`takosumi-git init: wrote ${appPath}\n`);
  stdout(`takosumi-git init: wrote ${manifestPath}\n`);
  stdout(`takosumi-git init: wrote ${workflowPath}\n`);
  if (existingPath) {
    stdout(`takosumi-git init: overwrote existing files (--force)\n`);
  }

  return {
    appPath,
    manifestPath,
    workflowPath,
    overwritten: !!existingPath,
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

async function firstExistingPath(
  paths: readonly string[],
): Promise<string | undefined> {
  for (const path of paths) {
    if (await exists(path)) return path;
  }
  return undefined;
}

function installableAppId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  );
  return `example.${slug || "app"}`;
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
