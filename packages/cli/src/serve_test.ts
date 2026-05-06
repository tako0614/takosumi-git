import { assertEquals } from "@std/assert";
import {
  createServeHandler,
  hmacSha256Hex,
  parseServeArgs,
  type WebhookDispatchJob,
} from "./serve.ts";

function baseOptions(dispatches: WebhookDispatchJob[] = []) {
  return {
    host: "127.0.0.1",
    port: 8788,
    endpoint: "https://kernel.example",
    token: "token",
    manifestPath: ".takosumi/manifest.yml",
    workflowsDir: ".takosumi/workflows",
    webhookSecret: "secret",
    artifactContract: "v1" as const,
    rateLimit: 60,
    rateLimitWindowMs: 60_000,
    waitForDispatch: true,
    dispatch: (job: WebhookDispatchJob) => {
      dispatches.push(job);
      return Promise.resolve();
    },
  };
}

async function signedRequest(
  provider: "github" | "gitlab" | "gitea",
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Request> {
  const raw = JSON.stringify(body);
  const signature = `sha256=${await hmacSha256Hex("secret", raw)}`;
  const signatureHeader = provider === "gitlab"
    ? "x-gitlab-signature-256"
    : provider === "gitea"
    ? "x-gitea-signature-256"
    : "x-hub-signature-256";
  return new Request(`http://localhost/webhooks/${provider}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [signatureHeader]: signature,
      ...extraHeaders,
    },
    body: raw,
  });
}

Deno.test("serve verifies GitHub webhook and dispatches push event", async () => {
  const dispatches: WebhookDispatchJob[] = [];
  const handler = createServeHandler(baseOptions(dispatches));
  const request = await signedRequest(
    "github",
    {
      ref: "refs/heads/main",
      after: "abc123",
      repository: { full_name: "acme/demo" },
      pusher: { name: "tako" },
    },
    {
      "x-github-delivery": "delivery-1",
      "x-github-event": "push",
    },
  );

  const response = await handler(request);

  assertEquals(response.status, 202);
  assertEquals(dispatches.length, 1);
  assertEquals(dispatches[0].id, "github:delivery-1");
  assertEquals(dispatches[0].event.kind, "git-push");
  assertEquals(dispatches[0].event.source, "acme/demo@refs/heads/main");
});

Deno.test("serve rejects invalid signatures before dispatch", async () => {
  const dispatches: WebhookDispatchJob[] = [];
  const handler = createServeHandler(baseOptions(dispatches));
  const response = await handler(
    new Request("http://localhost/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=00",
      },
      body: JSON.stringify({ ref: "refs/heads/main", after: "abc123" }),
    }),
  );

  assertEquals(response.status, 401);
  assertEquals(dispatches.length, 0);
});

Deno.test("serve normalizes GitLab and Gitea push payloads", async () => {
  for (const provider of ["gitlab", "gitea"] as const) {
    const dispatches: WebhookDispatchJob[] = [];
    const handler = createServeHandler(baseOptions(dispatches));
    const body = provider === "gitlab"
      ? {
        ref: "refs/heads/main",
        checkout_sha: "def456",
        repository: { path_with_namespace: "acme/gitlab-demo" },
        user: { username: "octo" },
      }
      : {
        ref: "refs/heads/main",
        after: "def456",
        repository: { full_name: "acme/gitea-demo" },
        pusher: { name: "octo" },
      };

    const response = await handler(await signedRequest(provider, body));

    assertEquals(response.status, 202);
    assertEquals(dispatches.length, 1);
    assertEquals(dispatches[0].provider, provider);
    assertEquals(dispatches[0].event.kind, "git-push");
  }
});

Deno.test("serve deduplicates delivery IDs", async () => {
  const dispatches: WebhookDispatchJob[] = [];
  const handler = createServeHandler(baseOptions(dispatches));
  const body = {
    ref: "refs/heads/main",
    after: "abc123",
    repository: { full_name: "acme/demo" },
  };

  const first = await handler(
    await signedRequest("github", body, { "x-github-delivery": "same" }),
  );
  const second = await handler(
    await signedRequest("github", body, { "x-github-delivery": "same" }),
  );

  assertEquals(first.status, 202);
  assertEquals(second.status, 202);
  assertEquals(await second.json(), {
    ok: true,
    queued: false,
    duplicate: true,
  });
  assertEquals(dispatches.length, 1);
});

Deno.test("serve rate limits before signature work", async () => {
  const handler = createServeHandler({
    ...baseOptions(),
    rateLimit: 1,
  });
  const body = { ref: "refs/heads/main", after: "abc123" };

  const first = await handler(await signedRequest("github", body));
  const second = await handler(await signedRequest("github", body));

  assertEquals(first.status, 202);
  assertEquals(second.status, 429);
});

Deno.test("parseServeArgs reads endpoint token and secret from env", () => {
  const parsed = parseServeArgs(["--port", "9000"], {
    get(key: string) {
      const env: Record<string, string> = {
        TAKOSUMI_ENDPOINT: "https://kernel.example",
        TAKOSUMI_TOKEN: "token",
        TAKOSUMI_GIT_WEBHOOK_SECRET: "secret",
      };
      return env[key];
    },
  });

  assertEquals(parsed.port, 9000);
  assertEquals(parsed.endpoint, "https://kernel.example");
  assertEquals(parsed.token, "token");
  assertEquals(parsed.webhookSecret, "secret");
  assertEquals(parsed.artifactContract, "v1");
});
