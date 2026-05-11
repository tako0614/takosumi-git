import { isAbsolute, relative, resolve } from "@std/path";

export async function resolveWorkflowFilePath(
  workflowsDir: string,
  file: string,
  label: string,
): Promise<string> {
  if (file.length === 0 || isAbsolute(file)) {
    throw new Error(
      `${label} must be a relative path inside workflows directory`,
    );
  }

  const base = await Deno.realPath(workflowsDir);
  const candidate = resolve(base, file);
  assertInsideWorkflowsDir(base, candidate, label);

  const realCandidate = await Deno.realPath(candidate);
  assertInsideWorkflowsDir(base, realCandidate, label);
  return realCandidate;
}

function assertInsideWorkflowsDir(
  base: string,
  candidate: string,
  label: string,
): void {
  const rel = relative(base, candidate);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `${label} must be a relative path inside workflows directory`,
    );
  }
}
