import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { stringify as stringifyYaml } from "@std/yaml";
import { join } from "@std/path";
import type { StepExecutor } from "@takos/takosumi-git-workflow-runner";
import {
  defaultStepExecutor,
  type GitRunner,
  parsePushArgs,
  push,
} from "./push.ts";

interface Project {
  readonly root: string;
  cleanup(): Promise<void>;
}

async function makeProject(opts: {
  manifest: unknown;
  workflows: Record<string, unknown>;
  appYml?: string;
}): Promise<Project> {
  const root = await Deno.makeTempDir({ prefix: "takosumi-git-push-" });
  const takosumiDir = join(root, ".takosumi");
  const workflowsDir = join(takosumiDir, "workflows");
  await Deno.mkdir(workflowsDir, { recursive: true });
  await Deno.writeTextFile(
    join(takosumiDir, "manifest.yml"),
    stringifyYaml(opts.manifest as Record<string, unknown>),
  );
  if (opts.appYml) {
    await Deno.writeTextFile(join(takosumiDir, "app.yml"), opts.appYml);
  }
  for (const [name, body] of Object.entries(opts.workflows)) {
    await Deno.writeTextFile(
      join(workflowsDir, name),
      stringifyYaml(body as Record<string, unknown>),
    );
  }
  return {
    root,
    async cleanup() {
      await Deno.remove(root, { recursive: true });
    },
  };
}

const fakeOk: StepExecutor = (_run, _ctx) =>
  Promise.resolve({
    stdout:
      "build complete\nTAKOSUMI_ARTIFACT=ghcr.io/example/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n",
    exitCode: 0,
  });

const fakeLegacyOk: StepExecutor = (_run, _ctx) =>
  Promise.resolve({
    stdout:
      "build complete\nghcr.io/example/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n",
    exitCode: 0,
  });

const fakeUnpinnedImage: StepExecutor = (_run, _ctx) =>
  Promise.resolve({
    stdout: "TAKOSUMI_ARTIFACT=ghcr.io/example/app:latest\n",
    exitCode: 0,
  });

const fakeGit: GitRunner = (args) => {
  const key = args.join(" ");
  if (key === "rev-parse HEAD") {
    return Promise.resolve({
      code: 0,
      stdout: "0123456789abcdef0123456789abcdef01234567\n",
    });
  }
  if (key === "rev-parse --abbrev-ref HEAD") {
    return Promise.resolve({ code: 0, stdout: "main\n" });
  }
  if (key === "config --get remote.origin.url") {
    return Promise.resolve({
      code: 0,
      stdout: "https://github.com/acme/demo.git\n",
    });
  }
  return Promise.resolve({ code: 1, stdout: "" });
};

function restoreEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
}

const SERVICE_IMPORT_APP_YML = `apiVersion: app.takosumi.dev/v1
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
  bootstrap:
    type: install-launch-token@v1
    required: true
    consumePath: /_takosumi/launch
serviceImports:
  - binding: account-auth
    service: takosumi.account.auth@v1
    endpointRoles:
      - oidc-issuer
    refreshPolicy:
      kind: ttl
      ttl: 300s
install:
  healthcheckPath: /health
  postInstallLaunchPath: /_takosumi/launch
permissions:
  requested: []
`;

Deno.test("push --dry-run resolves workflowRef into spec.image and strips workflowRef", async () => {
  const project = await makeProject({
    manifest: {
      apiVersion: "1.0",
      kind: "Manifest",
      metadata: { name: "demo" },
      resources: [
        {
          shape: "web-service@v1",
          name: "web",
          provider: "@takos/cloudflare-container",
          spec: {
            image: "PLACEHOLDER",
            port: 8080,
          },
          workflowRef: {
            file: "build.yml",
            job: "build-image",
            artifact: "image",
          },
        },
      ],
    },
    workflows: {
      "build.yml": {
        version: "0",
        jobs: [
          {
            name: "build-image",
            steps: [
              { name: "compile", run: "true" },
              { name: "publish", run: "true" },
            ],
            artifact: { name: "image" },
          },
        ],
      },
    },
  });

  let dryRunOutput = "";
  let fetchCalls = 0;
  try {
    const result = await push({
      endpoint: "http://nope",
      token: "x",
      manifestPath: join(project.root, ".takosumi", "manifest.yml"),
      workflowsDir: join(project.root, ".takosumi", "workflows"),
      mode: "apply",
      dryRun: true,
      executorFactory: () => fakeOk,
      workflowRunIdFactory: () => "takosumi-git:run:test",
      now: () => "2026-05-07T00:00:00.000Z",
      git: fakeGit,
      stdout: (s) => {
        dryRunOutput += s;
      },
      fetch: (() => {
        fetchCalls++;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch,
    });

    const resources = result.manifest.resources as Array<
      Record<string, unknown>
    >;
    const web = resources[0];
    const spec = web.spec as Record<string, unknown>;
    const metadata = web.metadata as Record<string, unknown>;
    const provenance = metadata.takosumiGitProvenance as Record<
      string,
      unknown
    >;
    assertEquals(
      spec.image,
      "ghcr.io/example/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    assertEquals(provenance.workflowRunId, "takosumi-git:run:test");
    assertEquals(
      provenance.gitCommitSha,
      "0123456789abcdef0123456789abcdef01234567",
    );
    assert(!("workflowRef" in web), "workflowRef must be stripped");
    assertEquals(result.resolved.length, 1);
    assertEquals(result.resolved[0].resource, "web");
    assertEquals(
      result.resolved[0].artifact.uri,
      "ghcr.io/example/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    assert(
      dryRunOutput.includes(
        "ghcr.io/example/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      ),
    );
    assertEquals(fetchCalls, 0, "dry-run must not call fetch");
  } finally {
    await project.cleanup();
  }
});

Deno.test("push rejects workflowRef files outside the workflows directory", async () => {
  const project = await makeProject({
    manifest: {
      apiVersion: "1.0",
      kind: "Manifest",
      metadata: { name: "demo" },
      resources: [
        {
          shape: "web-service@v1",
          name: "web",
          provider: "@takos/cloudflare-container",
          spec: { image: "PLACEHOLDER", port: 8080 },
          workflowRef: {
            file: "../outside.yml",
            job: "build-image",
            artifact: "image",
          },
        },
      ],
    },
    workflows: {},
  });
  try {
    await Deno.writeTextFile(
      join(project.root, ".takosumi", "outside.yml"),
      stringifyYaml({
        version: "0",
        jobs: [
          {
            name: "build-image",
            steps: [{ name: "compile", run: "true" }],
            artifact: { name: "image" },
          },
        ],
      }),
    );

    await assertRejects(
      () =>
        push({
          endpoint: "http://nope",
          token: "x",
          manifestPath: join(project.root, ".takosumi", "manifest.yml"),
          workflowsDir: join(project.root, ".takosumi", "workflows"),
          mode: "apply",
          dryRun: true,
          executorFactory: () => fakeOk,
          git: fakeGit,
        }),
      Error,
      "resources[0].workflowRef.file must be a relative path inside workflows directory",
    );
  } finally {
    await project.cleanup();
  }
});

Deno.test("default workflow executor does not inherit runtime secrets", async () => {
  const root = await Deno.makeTempDir({ prefix: "takosumi-git-sandbox-" });
  const previous = {
    TAKOS_TOKEN: Deno.env.get("TAKOS_TOKEN"),
    OIDC_CLIENT_SECRET: Deno.env.get("OIDC_CLIENT_SECRET"),
    DATABASE_URL: Deno.env.get("DATABASE_URL"),
  };
  Deno.env.set("TAKOS_TOKEN", "takos-token-secret");
  Deno.env.set("OIDC_CLIENT_SECRET", "oidc-client-secret");
  Deno.env.set("DATABASE_URL", "postgres://secret@example/db");
  try {
    const executor = defaultStepExecutor(root);
    const outcome = await executor(
      `
if [ -n "$TAKOS_TOKEN$OIDC_CLIENT_SECRET$DATABASE_URL" ]; then
  echo "leaked:$TAKOS_TOKEN:$OIDC_CLIENT_SECRET:$DATABASE_URL"
else
  echo "isolated"
fi
echo "TAKOSUMI_ARTIFACT=ghcr.io/example/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
`,
      {
        job: "build-image",
        step: "probe-env",
        event: { kind: "manual", source: "test" },
      },
    );

    assertEquals(outcome.exitCode, 0);
    assert(outcome.stdout.includes("isolated"));
    assert(!outcome.stdout.includes("takos-token-secret"));
    assert(!outcome.stdout.includes("oidc-client-secret"));
    assert(!outcome.stdout.includes("postgres://secret@example/db"));
  } finally {
    restoreEnv(previous);
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("push can write workflow artifacts to a workflowRef target path", async () => {
  const project = await makeProject({
    manifest: {
      apiVersion: "1.0",
      kind: "Manifest",
      metadata: { name: "worker-demo" },
      resources: [
        {
          shape: "worker@v1",
          name: "web",
          provider: "@takos/cloudflare-workers",
          spec: {
            artifact: {
              kind: "js-bundle",
              hash: "PLACEHOLDER",
            },
            compatibilityDate: "2026-05-09",
          },
          workflowRef: {
            file: "build.yml",
            job: "build-worker",
            artifact: "bundle",
            target: "spec.artifact.hash",
          },
        },
      ],
    },
    workflows: {
      "build.yml": {
        version: "0",
        jobs: [
          {
            name: "build-worker",
            steps: [{ name: "build", run: "true" }],
            artifact: { name: "bundle" },
          },
        ],
      },
    },
  });

  const workerBundle: StepExecutor = () =>
    Promise.resolve({
      stdout: "TAKOSUMI_ARTIFACT=sha256:bundledeadbeef\n",
      exitCode: 0,
    });

  try {
    const result = await push({
      endpoint: "http://nope",
      token: "x",
      manifestPath: join(project.root, ".takosumi", "manifest.yml"),
      workflowsDir: join(project.root, ".takosumi", "workflows"),
      mode: "apply",
      dryRun: true,
      executorFactory: () => workerBundle,
      workflowRunIdFactory: () => "takosumi-git:run:worker-target",
      now: () => "2026-05-09T00:00:00.000Z",
      git: fakeGit,
      stdout: () => {},
    });

    const resources = result.manifest.resources as Array<
      Record<string, unknown>
    >;
    const worker = resources[0];
    const spec = worker.spec as Record<string, unknown>;
    const artifact = spec.artifact as Record<string, unknown>;
    assertEquals(artifact.kind, "js-bundle");
    assertEquals(artifact.hash, "sha256:bundledeadbeef");
    assertEquals(spec.image, undefined);
    assert(!("workflowRef" in worker), "workflowRef must be stripped");
  } finally {
    await project.cleanup();
  }
});

Deno.test("push rejects workflowRef target paths outside spec", async () => {
  const project = await makeProject({
    manifest: {
      apiVersion: "1.0",
      kind: "Manifest",
      metadata: { name: "bad-target" },
      resources: [
        {
          shape: "worker@v1",
          name: "worker",
          provider: "@takos/cloudflare-workers",
          spec: {
            artifact: {
              kind: "js-bundle",
              hash: "PLACEHOLDER",
            },
            compatibilityDate: "2026-05-09",
          },
          workflowRef: {
            file: "build.yml",
            job: "build-worker",
            artifact: "bundle",
            target: "metadata.artifactHash",
          },
        },
      ],
    },
    workflows: {
      "build.yml": {
        version: "0",
        jobs: [
          {
            name: "build-worker",
            steps: [{ name: "build", run: "true" }],
            artifact: { name: "bundle" },
          },
        ],
      },
    },
  });

  try {
    await assertRejects(
      () =>
        push({
          endpoint: "http://nope",
          token: "x",
          manifestPath: join(project.root, ".takosumi", "manifest.yml"),
          workflowsDir: join(project.root, ".takosumi", "workflows"),
          mode: "apply",
          dryRun: true,
          executorFactory: () => fakeOk,
          stdout: () => {},
        }),
      Error,
      "workflowRef.target must be a dotted field path below spec",
    );
  } finally {
    await project.cleanup();
  }
});

Deno.test("push posts cleaned manifest body to takosumi /v1/deployments", async () => {
  const project = await makeProject({
    manifest: {
      apiVersion: "1.0",
      kind: "Manifest",
      resources: [
        {
          shape: "web-service@v1",
          name: "api",
          provider: "@takos/cloudflare-container",
          spec: { image: "old", port: 8080 },
          workflowRef: {
            file: "build.yml",
            job: "build-image",
            artifact: "image",
          },
        },
      ],
    },
    workflows: {
      "build.yml": {
        version: "0",
        jobs: [
          {
            name: "build-image",
            steps: [{ name: "build", run: "true" }],
            artifact: { name: "image" },
          },
        ],
      },
    },
  });

  let postedUrl = "";
  let postedBody: unknown = null;
  let postedAuth = "";
  try {
    await push({
      endpoint: "http://kernel.example/",
      token: "secret",
      manifestPath: join(project.root, ".takosumi", "manifest.yml"),
      workflowsDir: join(project.root, ".takosumi", "workflows"),
      mode: "apply",
      dryRun: false,
      executorFactory: () => fakeOk,
      workflowRunIdFactory: () => "takosumi-git:run:post-test",
      now: () => "2026-05-07T00:00:00.000Z",
      git: fakeGit,
      stdout: () => {},
      fetch: ((url: string | URL | Request, init?: RequestInit) => {
        postedUrl = url.toString();
        postedAuth = (init?.headers as Record<string, string>)
          ?.["authorization"] ?? "";
        postedBody = JSON.parse(init?.body as string);
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), { status: 202 }),
        );
      }) as typeof fetch,
    });

    assertEquals(postedUrl, "http://kernel.example/v1/deployments");
    assertEquals(postedAuth, "Bearer secret");
    const body = postedBody as {
      mode: string;
      provenance: {
        workflowRunId: string;
        git: { commitSha: string };
        resourceArtifacts: Array<{
          resourceName: string;
          artifactUri: string;
          stepLogs: Array<{ stepName: string; stdoutDigest: string }>;
        }>;
      };
      manifest: { resources: Array<Record<string, unknown>> };
    };
    assertEquals(body.mode, "apply");
    assertEquals(body.provenance.workflowRunId, "takosumi-git:run:post-test");
    assertEquals(
      body.provenance.git.commitSha,
      "0123456789abcdef0123456789abcdef01234567",
    );
    assertEquals(body.provenance.resourceArtifacts[0].resourceName, "api");
    assertEquals(
      body.provenance.resourceArtifacts[0].artifactUri,
      "ghcr.io/example/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    assertEquals(
      body.provenance.resourceArtifacts[0].stepLogs[0].stepName,
      "build",
    );
    assert(
      body.provenance.resourceArtifacts[0].stepLogs[0].stdoutDigest
        .startsWith("sha256:"),
    );
    const api = body.manifest.resources[0];
    const spec = api.spec as Record<string, unknown>;
    const metadata = api.metadata as Record<string, unknown>;
    const resourceProvenance = metadata.takosumiGitProvenance as Record<
      string,
      unknown
    >;
    assertEquals(
      spec.image,
      "ghcr.io/example/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    assertEquals(
      resourceProvenance.workflowRunId,
      "takosumi-git:run:post-test",
    );
    assert(
      !("workflowRef" in api),
      "workflowRef must be stripped from POST body",
    );
  } finally {
    await project.cleanup();
  }
});

Deno.test("push rejects app.yml serviceImports before deploy", async () => {
  const project = await makeProject({
    appYml: SERVICE_IMPORT_APP_YML,
    manifest: {
      apiVersion: "1.0",
      kind: "Manifest",
      metadata: { name: "demo" },
      resources: [],
    },
    workflows: {},
  });

  try {
    await assertRejects(
      () =>
        push({
          endpoint: "http://nope",
          token: "x",
          manifestPath: join(project.root, ".takosumi", "manifest.yml"),
          workflowsDir: join(project.root, ".takosumi", "workflows"),
          mode: "apply",
          dryRun: true,
          stdout: () => {},
        }),
      Error,
      "$.serviceImports is not allowed",
    );
  } finally {
    await project.cleanup();
  }
});

Deno.test("push rejects forbidden manifest import fields", async () => {
  const project = await makeProject({
    manifest: {
      apiVersion: "1.0",
      kind: "Manifest",
      imports: [{
        alias: "account-auth",
        service: "takosumi.account.auth@v1",
      }],
      resources: [],
    },
    workflows: {},
  });

  try {
    await assertRejects(
      () =>
        push({
          endpoint: "http://nope",
          token: "x",
          manifestPath: join(project.root, ".takosumi", "manifest.yml"),
          workflowsDir: join(project.root, ".takosumi", "workflows"),
          mode: "apply",
          dryRun: true,
          stdout: () => {},
        }),
      Error,
      "manifest.imports is forbidden",
    );
  } finally {
    await project.cleanup();
  }
});

Deno.test("push rejects unresolved installer placeholders without app.yml", async () => {
  const project = await makeProject({
    manifest: {
      apiVersion: "1.0",
      kind: "Manifest",
      metadata: { name: "demo" },
      resources: [{
        shape: "web-service@v1",
        name: "web",
        spec: {
          image:
            "ghcr.io/example/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          port: 8080,
          env: {
            OIDC_CLIENT_ID: "${bindings.auth.clientId}",
          },
        },
      }],
    },
    workflows: {},
  });

  let fetchCalls = 0;
  try {
    await assertRejects(
      () =>
        push({
          endpoint: "http://kernel.example",
          token: "x",
          manifestPath: join(project.root, ".takosumi", "manifest.yml"),
          workflowsDir: join(project.root, ".takosumi", "workflows"),
          mode: "apply",
          dryRun: false,
          fetch: (() => {
            fetchCalls++;
            return Promise.resolve(new Response(null, { status: 204 }));
          }) as typeof fetch,
          stdout: () => {},
        }),
      Error,
      "unresolved installer placeholder",
    );
    assertEquals(fetchCalls, 0, "placeholder validation must run before POST");
  } finally {
    await project.cleanup();
  }
});

Deno.test("push surfaces non-zero step exit as error", async () => {
  const project = await makeProject({
    manifest: {
      apiVersion: "1.0",
      kind: "Manifest",
      resources: [
        {
          shape: "web-service@v1",
          name: "web",
          provider: "@takos/cloudflare-container",
          spec: { image: "x", port: 8080 },
          workflowRef: {
            file: "build.yml",
            job: "build",
            artifact: "image",
          },
        },
      ],
    },
    workflows: {
      "build.yml": {
        version: "0",
        jobs: [
          {
            name: "build",
            steps: [{ name: "fail", run: "false" }],
            artifact: { name: "image" },
          },
        ],
      },
    },
  });

  const failing: StepExecutor = () =>
    Promise.resolve({ stdout: "boom\n", exitCode: 1 });

  try {
    await assertRejects(
      () =>
        push({
          endpoint: "http://nope",
          token: "x",
          manifestPath: join(project.root, ".takosumi", "manifest.yml"),
          workflowsDir: join(project.root, ".takosumi", "workflows"),
          mode: "apply",
          dryRun: true,
          executorFactory: () => failing,
          stdout: () => {},
        }),
      Error,
      "failed",
    );
  } finally {
    await project.cleanup();
  }
});

Deno.test("push leaves resource entries without workflowRef untouched", async () => {
  const project = await makeProject({
    manifest: {
      apiVersion: "1.0",
      kind: "Manifest",
      resources: [
        {
          shape: "object-store@v1",
          name: "static",
          provider: "@takos/cloudflare-r2",
          spec: { name: "static-assets" },
        },
        {
          shape: "web-service@v1",
          name: "api",
          provider: "@takos/cloudflare-container",
          spec: { image: "PLACEHOLDER", port: 8080 },
          workflowRef: {
            file: "build.yml",
            job: "build",
            artifact: "image",
          },
        },
      ],
    },
    workflows: {
      "build.yml": {
        version: "0",
        jobs: [
          {
            name: "build",
            steps: [{ name: "s", run: "true" }],
            artifact: { name: "image" },
          },
        ],
      },
    },
  });

  try {
    const result = await push({
      endpoint: "http://nope",
      token: "x",
      manifestPath: join(project.root, ".takosumi", "manifest.yml"),
      workflowsDir: join(project.root, ".takosumi", "workflows"),
      mode: "apply",
      dryRun: true,
      executorFactory: () => fakeOk,
      stdout: () => {},
    });
    const resources = result.manifest.resources as Array<
      Record<string, unknown>
    >;
    const staticEntry = resources[0];
    const apiEntry = resources[1];
    assertEquals(
      (staticEntry.spec as Record<string, unknown>).name,
      "static-assets",
    );
    assertEquals(
      (apiEntry.spec as Record<string, unknown>).image,
      "ghcr.io/example/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    // The static resource never had workflowRef; should be unchanged.
    assert(!("workflowRef" in staticEntry));
    assert(!("workflowRef" in apiEntry));
  } finally {
    await project.cleanup();
  }
});

Deno.test("push defaults artifact contract to v1 marker detection", () => {
  const parsed = parsePushArgs(["--dry-run"], {
    get: () => undefined,
  });
  assertEquals(parsed.artifactContract, "v1");

  const explicit = parsePushArgs(["--dry-run", "--artifact-contract", "v1"], {
    get: () => undefined,
  });
  assertEquals(explicit.artifactContract, "v1");
});

Deno.test("push rejects removed artifact contracts", () => {
  for (const removed of ["v0", "auto"]) {
    assertThrows(
      () =>
        parsePushArgs(["--dry-run", "--artifact-contract", removed], {
          get: () => undefined,
        }),
      Error,
      "--artifact-contract must be v1",
    );
  }
});

Deno.test("push rejects removed service resolver flags", () => {
  assertThrows(
    () =>
      parsePushArgs([
        "--dry-run",
        "--service-resolver-url",
        "https://anchor.example.test/v1/services",
      ], { get: () => undefined }),
    Error,
    "service resolver options were removed",
  );
});

Deno.test("push rejects v1 workflows that only emit legacy stdout artifacts", async () => {
  const project = await makeProject({
    manifest: {
      apiVersion: "1.0",
      kind: "Manifest",
      resources: [
        {
          shape: "web-service@v1",
          name: "api",
          provider: "@takos/cloudflare-container",
          spec: { image: "PLACEHOLDER", port: 8080 },
          workflowRef: {
            file: "build.yml",
            job: "build",
            artifact: "image",
          },
        },
      ],
    },
    workflows: {
      "build.yml": {
        version: "0",
        jobs: [
          {
            name: "build",
            steps: [{ name: "s", run: "true" }],
            artifact: { name: "image" },
          },
        ],
      },
    },
  });

  try {
    await assertRejects(
      () =>
        push({
          endpoint: "http://nope",
          token: "x",
          manifestPath: join(project.root, ".takosumi", "manifest.yml"),
          workflowsDir: join(project.root, ".takosumi", "workflows"),
          mode: "apply",
          dryRun: true,
          executorFactory: () => fakeLegacyOk,
          stdout: () => {},
        }),
      Error,
      "produced no TAKOSUMI_ARTIFACT=<uri> marker",
    );
  } finally {
    await project.cleanup();
  }
});

Deno.test("push rejects non-digest-pinned spec.image artifacts", async () => {
  const project = await makeProject({
    manifest: {
      apiVersion: "1.0",
      kind: "Manifest",
      resources: [
        {
          shape: "web-service@v1",
          name: "api",
          provider: "@takos/cloudflare-container",
          spec: { image: "PLACEHOLDER", port: 8080 },
          workflowRef: {
            file: "build.yml",
            job: "build",
            artifact: "image",
          },
        },
      ],
    },
    workflows: {
      "build.yml": {
        version: "0",
        jobs: [
          {
            name: "build",
            steps: [{ name: "s", run: "true" }],
            artifact: { name: "image" },
          },
        ],
      },
    },
  });

  try {
    await assertRejects(
      () =>
        push({
          endpoint: "http://nope",
          token: "x",
          manifestPath: join(project.root, ".takosumi", "manifest.yml"),
          workflowsDir: join(project.root, ".takosumi", "workflows"),
          mode: "apply",
          dryRun: true,
          executorFactory: () => fakeUnpinnedImage,
          stdout: () => {},
        }),
      Error,
      "spec.image artifacts must be digest-pinned",
    );
  } finally {
    await project.cleanup();
  }
});

Deno.test("push rejects explicit v0 and auto fallback artifact contracts", async () => {
  const project = await makeProject({
    manifest: {
      apiVersion: "1.0",
      kind: "Manifest",
      resources: [
        {
          shape: "web-service@v1",
          name: "api",
          provider: "@takos/cloudflare-container",
          spec: { image: "PLACEHOLDER", port: 8080 },
          workflowRef: {
            file: "build.yml",
            job: "build",
            artifact: "image",
          },
        },
      ],
    },
    workflows: {
      "build.yml": {
        version: "0",
        jobs: [
          {
            name: "build",
            steps: [{ name: "s", run: "true" }],
            artifact: { name: "image" },
          },
        ],
      },
    },
  });

  try {
    for (const artifactContract of ["v0", "auto"] as const) {
      await assertRejects(
        () =>
          push({
            endpoint: "http://nope",
            token: "x",
            manifestPath: join(project.root, ".takosumi", "manifest.yml"),
            workflowsDir: join(project.root, ".takosumi", "workflows"),
            mode: "apply",
            dryRun: true,
            artifactContract: artifactContract as "v1",
            executorFactory: () => fakeLegacyOk,
            stdout: () => {},
          }),
        Error,
        "produced no TAKOSUMI_ARTIFACT=<uri> marker",
      );
    }
  } finally {
    await project.cleanup();
  }
});
