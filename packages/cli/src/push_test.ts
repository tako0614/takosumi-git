import { assert, assertEquals, assertRejects } from "@std/assert";
import { stringify as stringifyYaml } from "@std/yaml";
import { join } from "@std/path";
import type { StepExecutor } from "@takos/takosumi-git-workflow-runner";
import { push } from "./push.ts";

interface Project {
  readonly root: string;
  cleanup(): Promise<void>;
}

async function makeProject(opts: {
  manifest: unknown;
  workflows: Record<string, unknown>;
}): Promise<Project> {
  const root = await Deno.makeTempDir({ prefix: "takosumi-git-push-" });
  const takosumiDir = join(root, ".takosumi");
  const workflowsDir = join(takosumiDir, "workflows");
  await Deno.mkdir(workflowsDir, { recursive: true });
  await Deno.writeTextFile(
    join(takosumiDir, "manifest.yml"),
    stringifyYaml(opts.manifest as Record<string, unknown>),
  );
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
    stdout: "ghcr.io/example/app@sha256:deadbeef\n",
    exitCode: 0,
  });

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
    assertEquals(spec.image, "ghcr.io/example/app@sha256:deadbeef");
    assert(!("workflowRef" in web), "workflowRef must be stripped");
    assertEquals(result.resolved.length, 1);
    assertEquals(result.resolved[0].resource, "web");
    assertEquals(
      result.resolved[0].artifact.uri,
      "ghcr.io/example/app@sha256:deadbeef",
    );
    assert(dryRunOutput.includes("ghcr.io/example/app@sha256:deadbeef"));
    assertEquals(fetchCalls, 0, "dry-run must not call fetch");
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
      manifest: { resources: Array<Record<string, unknown>> };
    };
    assertEquals(body.mode, "apply");
    const api = body.manifest.resources[0];
    const spec = api.spec as Record<string, unknown>;
    assertEquals(spec.image, "ghcr.io/example/app@sha256:deadbeef");
    assert(
      !("workflowRef" in api),
      "workflowRef must be stripped from POST body",
    );
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
      "ghcr.io/example/app@sha256:deadbeef",
    );
    // The static resource never had workflowRef; should be unchanged.
    assert(!("workflowRef" in staticEntry));
    assert(!("workflowRef" in apiEntry));
  } finally {
    await project.cleanup();
  }
});
