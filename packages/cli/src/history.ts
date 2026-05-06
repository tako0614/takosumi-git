/**
 * `takosumi-git history` implementation.
 *
 * Reads git history for `.takosumi/manifest.yml` and optionally renders a
 * semantic YAML diff for one `resources[].name`.
 */

import { parseArgs } from "@std/cli/parse-args";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { isAbsolute, relative, resolve } from "@std/path";

const DEFAULT_MANIFEST = ".takosumi/manifest.yml";
const DEFAULT_LIMIT = 20;

export interface GitCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type GitRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<GitCommandResult>;

export interface HistoryOptions {
  readonly cwd: string;
  readonly manifestPath: string;
  readonly resource?: string;
  readonly limit: number;
  readonly stdout?: (text: string) => void;
  readonly git?: GitRunner;
}

export interface ParsedHistoryArgs {
  readonly cwd: string;
  readonly manifestPath: string;
  readonly resource?: string;
  readonly limit: number;
}

interface CommitEntry {
  readonly sha: string;
  readonly shortSha: string;
  readonly committedAt: string;
  readonly subject: string;
}

export function parseHistoryArgs(args: readonly string[]): ParsedHistoryArgs {
  const flags = parseArgs(args as string[], {
    string: ["cwd", "manifest", "resource", "limit"],
    default: {
      cwd: ".",
      manifest: DEFAULT_MANIFEST,
      limit: String(DEFAULT_LIMIT),
    },
  });
  const limit = Number.parseInt(String(flags.limit), 10);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(
      `--limit must be a positive integer (got '${flags.limit}')`,
    );
  }
  return {
    cwd: resolve(flags.cwd as string),
    manifestPath: flags.manifest as string,
    resource: flags.resource as string | undefined,
    limit,
  };
}

async function defaultGitRunner(
  args: readonly string[],
  cwd: string,
): Promise<GitCommandResult> {
  const command = new Deno.Command("git", {
    args: args as string[],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const decoder = new TextDecoder();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

function manifestPathForGit(cwd: string, manifestPath: string): string {
  if (!isAbsolute(manifestPath)) return manifestPath;
  return relative(cwd, manifestPath);
}

function parseCommitLog(raw: string): CommitEntry[] {
  return raw.split("\n").map((line) => line.trim()).filter(Boolean).map(
    (line) => {
      const [sha, shortSha, committedAt, ...subjectParts] = line.split("\t");
      return {
        sha,
        shortSha,
        committedAt,
        subject: subjectParts.join("\t"),
      };
    },
  ).filter((entry) => entry.sha && entry.shortSha);
}

async function runGit(
  git: GitRunner,
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const result = await git(args, cwd);
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${
        result.stderr.trim() || result.stdout.trim()
      }`,
    );
  }
  return result.stdout;
}

async function readManifestAtCommit(
  git: GitRunner,
  cwd: string,
  commit: string,
  manifestPath: string,
): Promise<Record<string, unknown> | null> {
  const result = await git(["show", `${commit}:${manifestPath}`], cwd);
  if (result.code !== 0) return null;
  const parsed = parseYaml(result.stdout);
  return isRecord(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function resourceByName(
  manifest: Record<string, unknown> | null,
  resourceName: string,
): Record<string, unknown> | null {
  const resources = manifest?.resources;
  if (!Array.isArray(resources)) return null;
  for (const resource of resources) {
    if (isRecord(resource) && resource.name === resourceName) return resource;
  }
  return null;
}

function sortForStableYaml(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableYaml);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortForStableYaml(value[key]);
  }
  return sorted;
}

function semanticYamlLines(value: Record<string, unknown> | null): string[] {
  if (!value) return [];
  return stringifyYaml(sortForStableYaml(value) as Record<string, unknown>)
    .trimEnd()
    .split("\n");
}

function lineDiff(before: readonly string[], after: readonly string[]): string {
  const rows = before.length + 1;
  const cols = after.length + 1;
  const lcs = Array.from(
    { length: rows },
    () => Array<number>(cols).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      lcs[i][j] = before[i] === after[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      lines.push(`  ${before[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push(`- ${before[i]}`);
      i++;
    } else {
      lines.push(`+ ${after[j]}`);
      j++;
    }
  }
  while (i < before.length) {
    lines.push(`- ${before[i]}`);
    i++;
  }
  while (j < after.length) {
    lines.push(`+ ${after[j]}`);
    j++;
  }
  return `${lines.join("\n")}\n`;
}

async function listCommits(
  git: GitRunner,
  cwd: string,
  manifestPath: string,
  limit: number,
): Promise<CommitEntry[]> {
  const raw = await runGit(git, cwd, [
    "log",
    `-n${limit}`,
    "--format=%H%x09%h%x09%cI%x09%s",
    "--",
    manifestPath,
  ]);
  return parseCommitLog(raw);
}

function renderCommitList(
  commits: readonly CommitEntry[],
  manifestPath: string,
): string {
  if (commits.length === 0) {
    return `No history for ${manifestPath}\n`;
  }
  return commits.map((commit) =>
    `${commit.shortSha}\t${commit.committedAt}\t${commit.subject}`
  ).join("\n") + "\n";
}

async function renderResourceHistory(
  git: GitRunner,
  cwd: string,
  manifestPath: string,
  resourceName: string,
  commits: readonly CommitEntry[],
): Promise<string> {
  if (commits.length === 0) {
    return `No history for ${manifestPath}\n`;
  }

  const output: string[] = [];
  for (let i = 0; i < commits.length; i++) {
    const currentCommit = commits[i];
    const previousCommit = commits[i + 1];
    const currentManifest = await readManifestAtCommit(
      git,
      cwd,
      currentCommit.sha,
      manifestPath,
    );
    const previousManifest = previousCommit
      ? await readManifestAtCommit(git, cwd, previousCommit.sha, manifestPath)
      : null;
    const current = resourceByName(currentManifest, resourceName);
    const previous = resourceByName(previousManifest, resourceName);
    const currentYaml = semanticYamlLines(current);
    const previousYaml = semanticYamlLines(previous);
    if (currentYaml.join("\n") === previousYaml.join("\n")) continue;

    output.push(
      `${currentCommit.shortSha}\t${currentCommit.committedAt}\t${currentCommit.subject}`,
      `resource ${resourceName}`,
      "--- previous",
      "+++ current",
      lineDiff(previousYaml, currentYaml).trimEnd(),
      "",
    );
  }

  return output.length > 0
    ? `${output.join("\n").trimEnd()}\n`
    : `No changes for resource ${resourceName} in ${manifestPath}\n`;
}

export async function history(options: HistoryOptions): Promise<void> {
  const stdout = options.stdout ?? ((text: string) => {
    Deno.stdout.writeSync(new TextEncoder().encode(text));
  });
  const cwd = resolve(options.cwd);
  const manifestPath = manifestPathForGit(cwd, options.manifestPath);
  const git = options.git ?? defaultGitRunner;
  const commits = await listCommits(git, cwd, manifestPath, options.limit);

  const output = options.resource
    ? await renderResourceHistory(
      git,
      cwd,
      manifestPath,
      options.resource,
      commits,
    )
    : renderCommitList(commits, manifestPath);
  stdout(output);
}

export async function runHistoryCli(args: readonly string[]): Promise<number> {
  let parsed: ParsedHistoryArgs;
  try {
    parsed = parseHistoryArgs(args);
  } catch (error) {
    Deno.stderr.writeSync(
      new TextEncoder().encode(
        `takosumi-git history: ${(error as Error).message}\n`,
      ),
    );
    return 64;
  }

  try {
    await history(parsed);
    return 0;
  } catch (error) {
    Deno.stderr.writeSync(
      new TextEncoder().encode(
        `takosumi-git history: ${(error as Error).message}\n`,
      ),
    );
    return 1;
  }
}
