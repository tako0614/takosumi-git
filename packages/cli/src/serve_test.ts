import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  createServeHandler,
  hmacSha256Hex,
  parseServeArgs,
  type WebhookDispatchJob,
} from "./serve.ts";

const APP_YML = `apiVersion: app.takosumi.dev/v1
kind: InstallableApp
metadata:
  id: example.hello
  name: Hello
  description: Minimal example app
  publisher: example
  homepage: https://example.com
source:
  git: https://github.com/example/hello
  ref: v1.2.3
entry:
  manifest: .takosumi/manifest.yml
runtime:
  modes:
    - shared-cell
bindings:
  auth:
    type: identity.oidc@v1
    required: true
    redirectPaths:
      - /auth/oidc/callback
install:
  healthcheckPath: /health
  postInstallLaunchPath: /_takosumi/launch
permissions:
  requested:
    - logs.read.own
`;

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

Deno.test("serve exposes non-mutating install preview API", async () => {
  const dispatches: WebhookDispatchJob[] = [];
  const handler = createServeHandler(baseOptions(dispatches));
  const response = await handler(
    new Request("http://localhost/v1/install/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appYml: APP_YML,
        manifestYml: 'apiVersion: "1.0"\nkind: Manifest\nresources: []\n',
      }),
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(dispatches.length, 0);
  const body = await response.json();
  assertEquals(body.kind, "takosumi-git.install-preview@v1");
  assertEquals(body.app.id, "example.hello");
  assertEquals(body.source.pinned, true);
  assertEquals(body.permissions.requested, ["logs.read.own"]);
});

Deno.test("serve preview API accepts Git URL source", async () => {
  const checkoutRoot = await Deno.makeTempDir({
    prefix: "takosumi-git-serve-preview-",
  });
  try {
    await Deno.mkdir(join(checkoutRoot, ".takosumi"));
    await Deno.writeTextFile(
      join(checkoutRoot, ".takosumi", "app.yml"),
      APP_YML,
    );
    await Deno.writeTextFile(
      join(checkoutRoot, ".takosumi", "manifest.yml"),
      'apiVersion: "1.0"\nkind: Manifest\nresources: []\n',
    );
    const handler = createServeHandler({
      ...baseOptions(),
      installPreviewCheckoutSource: (request) => {
        assertEquals(request, {
          gitUrl: "https://github.com/example/hello",
          ref: "v1.2.3",
        });
        return Promise.resolve({
          root: checkoutRoot,
          commit: "0123456789abcdef0123456789abcdef01234567",
          cleanup: () => Promise.resolve(),
        });
      },
    });

    const response = await handler(
      new Request("http://localhost/v1/install/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          gitUrl: "https://github.com/example/hello",
          ref: "v1.2.3",
        }),
      }),
    );

    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.kind, "takosumi-git.install-preview@v1");
    assertEquals(
      body.source.commit,
      "0123456789abcdef0123456789abcdef01234567",
    );
    assertEquals(
      body.source.compiledManifestDigest.startsWith("sha256:"),
      true,
    );
  } finally {
    await Deno.remove(checkoutRoot, { recursive: true }).catch(() => {});
  }
});

Deno.test("serve apply API runs install apply pipeline from Git source", async () => {
  const checkoutRoot = await Deno.makeTempDir({
    prefix: "takosumi-git-serve-apply-",
  });
  const requests: Request[] = [];
  try {
    await Deno.mkdir(join(checkoutRoot, ".takosumi"));
    await Deno.writeTextFile(
      join(checkoutRoot, ".takosumi", "app.yml"),
      APP_YML,
    );
    await Deno.writeTextFile(
      join(checkoutRoot, ".takosumi", "manifest.yml"),
      'apiVersion: "1.0"\nkind: Manifest\nresources: []\n',
    );
    const handler = createServeHandler({
      ...baseOptions(),
      endpoint: "http://kernel.example",
      token: "serve-token",
      accountsUrl: "http://accounts.example",
      accountsToken: "accounts-token",
      deployToken: "deploy-token",
      accountId: "acct_default",
      spaceId: "space_default",
      subject: "tsub_default",
      installPreviewCheckoutSource: (request) => {
        assertEquals(request, {
          gitUrl: "https://github.com/example/hello",
          ref: "v1.2.3",
        });
        return Promise.resolve({
          root: checkoutRoot,
          commit: "0123456789abcdef0123456789abcdef01234567",
          cleanup: () => Promise.resolve(),
        });
      },
      installApplyFetch: (input, init) => {
        requests.push(new Request(input, init));
        const url = String(input);
        if (url.includes("/v1/deployments")) {
          return Promise.resolve(Response.json({
            status: "ok",
            outcome: { status: "succeeded" },
          }));
        }
        if (url.includes("/status")) {
          return Promise.resolve(Response.json({
            installation: { id: "inst_1", status: "ready" },
          }));
        }
        return Promise.resolve(Response.json({
          installation: { id: "inst_1" },
        }, { status: 202 }));
      },
    });

    const response = await handler(
      new Request("http://localhost/v1/install/apply", {
        method: "POST",
        headers: {
          "authorization": "Bearer serve-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          gitUrl: "https://github.com/example/hello",
          ref: "v1.2.3",
          accountId: "acct_1",
          spaceId: "space_1",
          subject: "tsub_owner",
        }),
      }),
    );

    assertEquals(response.status, 202);
    const body = await response.json();
    assertEquals(body.kind, "takosumi-git.install-apply@v1");
    assertEquals(body.response.status, 202);
    assertEquals(body.accounts.installationId, "inst_1");
    assertEquals(requests.length, 3);
    assertEquals(requests[0].url, "http://accounts.example/v1/installations");
    assertEquals(
      requests[0].headers.get("authorization"),
      "Bearer accounts-token",
    );
    const installBody = await requests[0].json();
    assertEquals(installBody.accountId, "acct_1");
    assertEquals(installBody.spaceId, "space_1");
    assertEquals(installBody.createdBySubject, "tsub_owner");
    assertEquals(
      installBody.source.commit,
      "0123456789abcdef0123456789abcdef01234567",
    );
    assertEquals(requests[1].url, "http://kernel.example/v1/deployments");
    assertEquals(
      requests[1].headers.get("authorization"),
      "Bearer deploy-token",
    );
    assertEquals(
      requests[2].url,
      "http://accounts.example/v1/installations/inst_1/status",
    );
  } finally {
    await Deno.remove(checkoutRoot, { recursive: true }).catch(() => {});
  }
});

Deno.test("serve apply API requires bearer token", async () => {
  const handler = createServeHandler({
    ...baseOptions(),
    token: "serve-token",
    accountsUrl: "http://accounts.example",
    accountsToken: "accounts-token",
  });
  const response = await handler(
    new Request("http://localhost/v1/install/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gitUrl: "https://github.com/example/hello",
        ref: "v1.2.3",
      }),
    }),
  );

  assertEquals(response.status, 401);
});

Deno.test("serve can dispatch webhooks through install apply", async () => {
  const root = await Deno.makeTempDir({
    prefix: "takosumi-git-serve-install-webhook-",
  });
  const requests: Request[] = [];
  try {
    await Deno.mkdir(join(root, ".takosumi"));
    await Deno.writeTextFile(join(root, ".takosumi", "app.yml"), APP_YML);
    await Deno.writeTextFile(
      join(root, ".takosumi", "manifest.yml"),
      'apiVersion: "1.0"\nkind: Manifest\nresources: []\n',
    );
    const { dispatch: _dispatch, ...options } = baseOptions();
    const handler = createServeHandler({
      ...options,
      webhookMode: "install",
      manifestPath: join(root, ".takosumi", "manifest.yml"),
      endpoint: "http://kernel.example",
      token: "serve-token",
      accountsUrl: "http://accounts.example",
      accountsToken: "accounts-token",
      deployToken: "deploy-token",
      accountId: "acct_1",
      spaceId: "space_1",
      subject: "tsub_owner",
      installApplyFetch: (input, init) => {
        requests.push(new Request(input, init));
        const url = String(input);
        if (url.includes("/v1/deployments")) {
          return Promise.resolve(Response.json({
            status: "ok",
            outcome: { status: "succeeded" },
          }));
        }
        if (url.includes("/status")) {
          return Promise.resolve(Response.json({
            installation: { id: "inst_webhook", status: "ready" },
          }));
        }
        return Promise.resolve(Response.json({
          installation: { id: "inst_webhook" },
        }, { status: 202 }));
      },
    });

    const response = await handler(
      await signedRequest(
        "github",
        {
          ref: "refs/tags/v1.2.3",
          after: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
          repository: { full_name: "example/hello" },
        },
        { "x-github-delivery": "install-delivery-1" },
      ),
    );

    assertEquals(response.status, 202);
    assertEquals(requests.length, 3);
    assertEquals(requests[0].url, "http://accounts.example/v1/installations");
    const installBody = await requests[0].json();
    assertEquals(installBody.accountId, "acct_1");
    assertEquals(installBody.spaceId, "space_1");
    assertEquals(installBody.createdBySubject, "tsub_owner");
    assertEquals(
      installBody.source.commit,
      "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    );
    assertEquals(requests[1].url, "http://kernel.example/v1/deployments");
    assertEquals(
      requests[2].url,
      "http://accounts.example/v1/installations/inst_webhook/status",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("serve preview API returns validation issues", async () => {
  const handler = createServeHandler(baseOptions());
  const response = await handler(
    new Request("http://localhost/v1/install/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appYml: APP_YML.replace("ref: v1.2.3", "ref: main"),
      }),
    }),
  );

  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.error, "invalid_installable_app");
});

Deno.test("parseServeArgs reads endpoint token and secret from env", () => {
  const parsed = parseServeArgs(["--port", "9000"], {
    get(key: string) {
      const env: Record<string, string> = {
        TAKOSUMI_ENDPOINT: "https://kernel.example",
        TAKOSUMI_TOKEN: "token",
        TAKOSUMI_GIT_WEBHOOK_SECRET: "secret",
        TAKOSUMI_GIT_WEBHOOK_MODE: "install",
        TAKOSUMI_ACCOUNTS_URL: "https://accounts.example",
        TAKOSUMI_ACCOUNTS_TOKEN: "accounts-token",
        TAKOS_ACCOUNT_ID: "acct_1",
        TAKOS_SPACE_ID: "space_1",
        TAKOSUMI_SUBJECT: "tsub_owner",
        TAKOSUMI_RUNTIME_BASE_URL: "https://app.example",
        TAKOSUMI_DEPLOY_TOKEN: "deploy-token",
      };
      return env[key];
    },
  });

  assertEquals(parsed.port, 9000);
  assertEquals(parsed.endpoint, "https://kernel.example");
  assertEquals(parsed.token, "token");
  assertEquals(parsed.webhookSecret, "secret");
  assertEquals(parsed.webhookMode, "install");
  assertEquals(parsed.artifactContract, "v1");
  assertEquals(parsed.accountsUrl, "https://accounts.example");
  assertEquals(parsed.accountsToken, "accounts-token");
  assertEquals(parsed.accountId, "acct_1");
  assertEquals(parsed.spaceId, "space_1");
  assertEquals(parsed.subject, "tsub_owner");
  assertEquals(parsed.runtimeBaseUrl, "https://app.example");
  assertEquals(parsed.deployToken, "deploy-token");
});

Deno.test("parseServeArgs rejects removed service resolver flags", () => {
  assertThrows(
    () =>
      parseServeArgs([
        "--service-resolver-url",
        "https://anchor.example.test/v1/services",
      ], {
        get(key: string) {
          const env: Record<string, string> = {
            TAKOSUMI_ENDPOINT: "https://kernel.example",
            TAKOSUMI_TOKEN: "token",
            TAKOSUMI_GIT_WEBHOOK_SECRET: "secret",
          };
          return env[key];
        },
      }),
    Error,
    "service resolver options were removed",
  );
});
