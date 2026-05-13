import type {
  StepExecutor,
  StepOutcome,
} from "@takos/takosumi-git-workflow-runner";

export const WORKFLOW_SANDBOX_DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";

export const WORKFLOW_SANDBOX_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
] as const;

export const WORKFLOW_SANDBOX_CREDENTIAL_KEYS = [
  "TAKOS_TOKEN",
  "TAKOSUMI_TOKEN",
  "TAKOSUMI_DEPLOY_TOKEN",
  "OIDC_CLIENT_SECRET",
  "DATABASE_URL",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUDFLARE_API_TOKEN",
] as const;

export function workflowSandboxEnv(
  sourceEnv: Readonly<Record<string, string | undefined>> = Deno.env.toObject(),
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: WORKFLOW_SANDBOX_DEFAULT_PATH,
  };
  for (const key of WORKFLOW_SANDBOX_ENV_ALLOWLIST) {
    if (key === "PATH") continue;
    const value = sourceEnv[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function createWorkflowStepExecutor(cwd: string): StepExecutor {
  return async (run, _context): Promise<StepOutcome> => {
    const command = new Deno.Command("bash", {
      args: ["-lc", run],
      cwd,
      clearEnv: true,
      env: workflowSandboxEnv(),
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await command.output();
    const out = new TextDecoder().decode(stdout);
    const err = new TextDecoder().decode(stderr);
    return {
      stdout: err.length > 0 ? `${out}\n[stderr]\n${err}` : out,
      exitCode: code,
    };
  };
}
