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

const APP_YML_WITH_LAUNCH = APP_YML.replace(
  "bindings:\n",
  `bindings:
  bootstrap:
    type: install-launch-token@v1
    required: true
    consumePath: /_takosumi/launch
`,
);

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

function opaqueLaunchTokenConfig(
  installationId: string,
): Record<string, unknown> {
  const accountsBaseUrl = "http://accounts.example";
  const redirectUri = "https://hello.example.test/_takosumi/launch";
  const consumePath = "/_takosumi/launch";
  return {
    accountsBaseUrl,
    installationId,
    redirectUri,
    consumePath,
    maxLifetimeSeconds: 300,
    env: {
      ACCOUNTS_BASE_URL: accountsBaseUrl,
      INSTALL_LAUNCH_INSTALLATION_ID: installationId,
      INSTALL_LAUNCH_REDIRECT_URI: redirectUri,
      INSTALL_LAUNCH_CONSUME_PATH: consumePath,
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

Deno.test("serve ignores signed non-push webhook events", async () => {
  const cases = [
    {
      provider: "github",
      headers: { "x-github-event": "ping" },
    },
    {
      provider: "gitlab",
      headers: { "x-gitlab-event": "Merge Request Hook" },
    },
    {
      provider: "gitea",
      headers: { "x-gitea-event": "pull_request" },
    },
  ] as const;

  for (const testCase of cases) {
    const dispatches: WebhookDispatchJob[] = [];
    const handler = createServeHandler(baseOptions(dispatches));
    const response = await handler(
      await signedRequest(
        testCase.provider,
        { ref: "refs/heads/main", after: "abc123" },
        testCase.headers,
      ),
    );

    assertEquals(response.status, 202);
    assertEquals(await response.json(), {
      ok: true,
      queued: false,
      ignored: true,
      reason: "unsupported_event",
    });
    assertEquals(dispatches.length, 0);
  }
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
      APP_YML_WITH_LAUNCH,
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
      APP_YML_WITH_LAUNCH,
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
      runtimeBaseUrl: "https://hello.example.test",
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
        const request = new Request(input, init);
        requests.push(request);
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
        if (
          url.endsWith("/v1/installations/inst_1/launch-token") &&
          request.method === "GET"
        ) {
          return Promise.resolve(Response.json(opaqueLaunchTokenConfig(
            "inst_1",
          )));
        }
        if (
          url.endsWith("/v1/installations/inst_1/launch-token") &&
          request.method === "POST"
        ) {
          return Promise.resolve(Response.json({
            url:
              "https://hello.example.test/_takosumi/launch?launch_token=opaque-launch",
            token: "opaque-launch",
          }));
        }
        return Promise.resolve(Response.json({
          installation: { id: "inst_1" },
          bindings: [{
            name: "bootstrap",
            kind: "install-launch-token@v1",
            config_ref:
              "takosumi-accounts://installations/inst_1/bindings/bootstrap/launch-token",
            secret_refs: [],
          }],
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
    assertEquals(
      body.launch.url,
      "https://hello.example.test/_takosumi/launch?launch_token=opaque-launch",
    );
    assertEquals(requests.length, 5);
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
    assertEquals(installBody.confirm.costAck, false);
    assertEquals(
      String(installBody.confirm.previewId).startsWith("preview_"),
      true,
    );
    assertEquals(
      String(installBody.confirm.permissionDigest).startsWith("sha256:"),
      true,
    );
    assertEquals(
      requests[1].url,
      "http://accounts.example/v1/installations/inst_1/launch-token",
    );
    assertEquals(requests[1].method, "GET");
    assertEquals(requests[2].url, "http://kernel.example/v1/deployments");
    assertEquals(
      requests[2].headers.get("authorization"),
      "Bearer deploy-token",
    );
    assertEquals(
      requests[3].url,
      "http://accounts.example/v1/installations/inst_1/status",
    );
    assertEquals(
      requests[4].url,
      "http://accounts.example/v1/installations/inst_1/launch-token",
    );
    assertEquals(requests[4].method, "POST");
    assertEquals(await requests[4].json(), {
      purpose: "install-bootstrap",
      ttlSeconds: 120,
      redirectUri: "https://hello.example.test/_takosumi/launch",
    });
  } finally {
    await Deno.remove(checkoutRoot, { recursive: true }).catch(() => {});
  }
});

Deno.test("serve completes Git URL preview approval to ready AppInstallation within five minutes", async () => {
  const checkoutRoot = await Deno.makeTempDir({
    prefix: "takosumi-git-serve-preview-apply-",
  });
  const requests: Request[] = [];
  const startedAt = Date.now();
  let observedStatus: string | undefined;
  try {
    await Deno.mkdir(join(checkoutRoot, ".takosumi"));
    await Deno.writeTextFile(
      join(checkoutRoot, ".takosumi", "app.yml"),
      APP_YML_WITH_LAUNCH,
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
      runtimeBaseUrl: "https://hello.example.test",
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
      installApplyFetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const url = String(input);
        if (url.includes("/v1/deployments")) {
          return Response.json({
            status: "ok",
            outcome: { status: "succeeded" },
          });
        }
        if (url.includes("/status")) {
          const statusBody = await request.clone().json();
          observedStatus = String(statusBody.status);
          return Response.json({
            installation: { id: "inst_approval", status: "ready" },
          });
        }
        if (
          url.endsWith("/v1/installations/inst_approval/launch-token") &&
          request.method === "GET"
        ) {
          return Response.json(opaqueLaunchTokenConfig("inst_approval"));
        }
        if (
          url.endsWith("/v1/installations/inst_approval/launch-token") &&
          request.method === "POST"
        ) {
          return Response.json({
            url:
              "https://hello.example.test/_takosumi/launch?launch_token=opaque-launch",
            token: "opaque-launch",
          });
        }
        return Response.json({
          installation: { id: "inst_approval" },
          bindings: [{
            name: "bootstrap",
            kind: "install-launch-token@v1",
            config_ref:
              "takosumi-accounts://installations/inst_approval/bindings/bootstrap/launch-token",
            secret_refs: [],
          }],
        }, { status: 202 });
      },
    });

    const previewResponse = await handler(
      new Request("http://localhost/v1/install/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          gitUrl: "https://github.com/example/hello",
          ref: "v1.2.3",
        }),
      }),
    );

    assertEquals(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assertEquals(String(preview.previewId).startsWith("preview_"), true);
    assertEquals(
      String(preview.permissionDigest).startsWith("sha256:"),
      true,
    );
    assertEquals(
      preview.source.commit,
      "0123456789abcdef0123456789abcdef01234567",
    );

    const applyResponse = await handler(
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
          previewId: preview.previewId,
          permissionDigest: preview.permissionDigest,
          sourceCommit: preview.source.commit,
          costAck: true,
        }),
      }),
    );

    assertEquals(applyResponse.status, 202);
    const body = await applyResponse.json();
    assertEquals(body.kind, "takosumi-git.install-apply@v1");
    assertEquals(body.response.status, 202);
    assertEquals(body.accounts.installationId, "inst_approval");
    assertEquals(body.statusTransition.body.installation.status, "ready");
    assertEquals(observedStatus, "ready");
    assertEquals(Date.now() - startedAt < 5 * 60_000, true);
    assertEquals(requests.length, 5);

    const installBody = await requests[0].json();
    assertEquals(installBody.confirm.previewId, preview.previewId);
    assertEquals(
      installBody.confirm.permissionDigest,
      preview.permissionDigest,
    );
    assertEquals(installBody.confirm.costAck, true);
    assertEquals(installBody.source.commit, preview.source.commit);
    assertEquals(
      requests[3].url,
      "http://accounts.example/v1/installations/inst_approval/status",
    );
    assertEquals(await requests[3].json(), {
      status: "ready",
      reason: "kernel deploy HTTP 200",
    });
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

Deno.test("serve revision API previews and applies existing installation changes", async () => {
  const checkoutRoot = await Deno.makeTempDir({
    prefix: "takosumi-git-serve-revision-",
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
    const commits = new Map([
      ["v1.2.4", "1111111111111111111111111111111111111111"],
      ["v1.2.2", "2222222222222222222222222222222222222222"],
    ]);
    const handler = createServeHandler({
      ...baseOptions(),
      token: "serve-token",
      accountsUrl: "http://accounts.example",
      accountsToken: "accounts-token",
      installPreviewCheckoutSource: async (request) => {
        assertEquals(request.gitUrl, "https://github.com/example/hello");
        const commit = commits.get(request.ref);
        if (!commit) throw new Error(`unexpected ref ${request.ref}`);
        await Deno.writeTextFile(
          join(checkoutRoot, ".takosumi", "app.yml"),
          APP_YML.replace("ref: v1.2.3", `ref: ${request.ref}`),
        );
        return {
          root: checkoutRoot,
          commit,
          cleanup: () => Promise.resolve(),
        };
      },
      installApplyFetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const url = String(input);
        if (url.endsWith("/v1/installations/inst_1")) {
          return Response.json({
            installation: {
              id: "inst_1",
              app_id: "example.hello",
              source: {
                url: "https://github.com/example/hello",
                ref: "v1.2.3",
                commit: "0000000000000000000000000000000000000000",
              },
              app_manifest_digest: "sha256:old-app",
              compiled_manifest_digest: "sha256:old-manifest",
              status: "ready",
            },
            bindings: [{
              name: "auth",
              kind: "identity.oidc@v1",
            }],
            grants: [{
              capability: "logs.read.own",
              revoked_at: null,
            }],
          });
        }
        if (url.endsWith("/v1/installations/inst_1/rollback")) {
          const body = await request.clone().json();
          return Response.json({
            operation: "rollback",
            installation: {
              id: "inst_1",
              status: "ready",
              source: body.source,
            },
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    });

    const previewResponse = await handler(
      new Request("http://localhost/v1/install/revision/preview", {
        method: "POST",
        headers: {
          "authorization": "Bearer serve-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          operation: "upgrade",
          installationId: "inst_1",
          ref: "v1.2.4",
        }),
      }),
    );

    assertEquals(previewResponse.status, 200);
    const previewBody = await previewResponse.json();
    assertEquals(
      previewBody.kind,
      "takosumi-git.install-revision-preview@v1",
    );
    assertEquals(previewBody.preview.operation, "upgrade");
    assertEquals(previewBody.preview.next.source.ref, "v1.2.4");
    assertEquals(
      previewBody.preview.next.source.commit,
      "1111111111111111111111111111111111111111",
    );
    assertEquals(requests.length, 1);
    assertEquals(
      requests[0].url,
      "http://accounts.example/v1/installations/inst_1",
    );
    assertEquals(
      requests[0].headers.get("authorization"),
      "Bearer accounts-token",
    );

    const applyResponse = await handler(
      new Request("http://localhost/v1/install/revision/apply", {
        method: "POST",
        headers: {
          "authorization": "Bearer serve-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          operation: "rollback",
          installationId: "inst_1",
          to: "v1.2.2",
          reason: "operator rollback",
        }),
      }),
    );

    assertEquals(applyResponse.status, 202);
    const applyBody = await applyResponse.json();
    assertEquals(
      applyBody.kind,
      "takosumi-git.install-revision-apply@v1",
    );
    assertEquals(applyBody.preview.operation, "rollback");
    assertEquals(applyBody.response.status, 200);
    assertEquals(requests.length, 3);
    assertEquals(
      requests[2].url,
      "http://accounts.example/v1/installations/inst_1/rollback",
    );
    const rollbackBody = await requests[2].json();
    assertEquals(rollbackBody.appId, "example.hello");
    assertEquals(rollbackBody.source.ref, "v1.2.2");
    assertEquals(
      rollbackBody.source.commit,
      "2222222222222222222222222222222222222222",
    );
    assertEquals(rollbackBody.reason, "operator rollback");
  } finally {
    await Deno.remove(checkoutRoot, { recursive: true }).catch(() => {});
  }
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

Deno.test("parseServeArgs rejects removed artifact contracts", () => {
  const env = {
    get(key: string) {
      const values: Record<string, string> = {
        TAKOSUMI_ENDPOINT: "https://kernel.example",
        TAKOSUMI_TOKEN: "token",
        TAKOSUMI_GIT_WEBHOOK_SECRET: "secret",
      };
      return values[key];
    },
  };

  for (const removed of ["v0", "auto"]) {
    assertThrows(
      () => parseServeArgs(["--artifact-contract", removed], env),
      Error,
      "--artifact-contract must be v1",
    );
  }
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
