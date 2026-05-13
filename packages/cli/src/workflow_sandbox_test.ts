import { assertEquals } from "@std/assert";
import {
  WORKFLOW_SANDBOX_CREDENTIAL_KEYS,
  WORKFLOW_SANDBOX_DEFAULT_PATH,
  workflowSandboxEnv,
} from "./workflow_sandbox.ts";

Deno.test("workflowSandboxEnv exposes only the workflow allowlist", () => {
  const env = workflowSandboxEnv({
    PATH: "/host/bin",
    HOME: "/home/build",
    TMPDIR: "/tmp/build",
    TMP: "/tmp",
    TEMP: "/tmp",
    USER: "builder",
    LOGNAME: "builder",
    SHELL: "/bin/bash",
    LANG: "C.UTF-8",
    LC_ALL: "C",
    TERM: "xterm-256color",
    TAKOS_TOKEN: "takos-token-secret",
    TAKOSUMI_TOKEN: "takosumi-token-secret",
    TAKOSUMI_DEPLOY_TOKEN: "deploy-token-secret",
    OIDC_CLIENT_SECRET: "oidc-client-secret",
    DATABASE_URL: "postgres://secret@example/db",
    AWS_ACCESS_KEY_ID: "aws-access-key",
    AWS_SECRET_ACCESS_KEY: "aws-secret-key",
    AWS_SESSION_TOKEN: "aws-session-token",
    GOOGLE_APPLICATION_CREDENTIALS: "/tmp/gcp-creds.json",
    CLOUDFLARE_API_TOKEN: "cloudflare-token",
    CUSTOM_PROVIDER_SECRET: "provider-secret",
  });

  assertEquals(env, {
    PATH: WORKFLOW_SANDBOX_DEFAULT_PATH,
    HOME: "/home/build",
    TMPDIR: "/tmp/build",
    TMP: "/tmp",
    TEMP: "/tmp",
    USER: "builder",
    LOGNAME: "builder",
    SHELL: "/bin/bash",
    LANG: "C.UTF-8",
    LC_ALL: "C",
    TERM: "xterm-256color",
  });
});

Deno.test("workflowSandboxEnv never passes known credential keys", () => {
  const sourceEnv: Record<string, string> = {};
  for (const key of WORKFLOW_SANDBOX_CREDENTIAL_KEYS) {
    sourceEnv[key] = `${key.toLowerCase()}-secret`;
  }

  const env = workflowSandboxEnv(sourceEnv);

  assertEquals(env, { PATH: WORKFLOW_SANDBOX_DEFAULT_PATH });
  for (const key of WORKFLOW_SANDBOX_CREDENTIAL_KEYS) {
    assertEquals(Object.hasOwn(env, key), false);
  }
});
