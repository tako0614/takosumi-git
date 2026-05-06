import { assert, assertEquals } from "@std/assert";
import {
  type ManifestEnvelope,
  manualEvent,
  postDeployment,
  type ResolvedArtifact,
  runWorkflow,
  type WorkflowFile,
} from "./mod.ts";

const workflow: WorkflowFile = {
  version: "0",
  jobs: [
    {
      name: "build-image",
      steps: [
        { name: "build", run: "echo build" },
        { name: "push", run: "echo push" },
      ],
      artifact: { name: "app-image" },
    },
  ],
};

Deno.test("E2E: workflow runs, manifest is generated, kernel receives it", async () => {
  const event = manualEvent("ci");
  const expectedArtifact: ResolvedArtifact = {
    name: "app-image",
    uri: "ghcr.io/example/app@sha256:0123456789",
    digest: "sha256:0123456789",
  };

  const result = await runWorkflow({
    file: workflow,
    job: "build-image",
    event,
    executor: () => Promise.resolve({ stdout: "ok", exitCode: 0 }),
    resolveArtifact: () => Promise.resolve(expectedArtifact),
  });

  assert(result.success, "workflow should succeed");
  assertEquals(result.artifact, expectedArtifact);

  const manifest: ManifestEnvelope = {
    apiVersion: "1.0",
    kind: "Manifest",
    metadata: { name: "app" },
    resources: [
      {
        shape: "web-service@v1",
        name: "app",
        provider: "@takos/cloudflare-container",
        spec: { image: result.artifact!.uri, port: 8080 },
      },
    ],
  };

  const captured: { url: string; bodyJson: unknown }[] = [];
  const mockFetch: typeof fetch = (input, init) => {
    const url = typeof input === "string"
      ? input
      : (input as URL | Request).toString();
    const rawBody = (init as { body?: BodyInit | null } | undefined)?.body;
    const bodyJson = typeof rawBody === "string" ? JSON.parse(rawBody) : null;
    captured.push({ url, bodyJson });
    return Promise.resolve(
      new Response(JSON.stringify({ accepted: true }), { status: 202 }),
    );
  };

  const response = await postDeployment(
    {
      endpoint: "https://kernel.example.com",
      token: "test-token",
      fetch: mockFetch,
    },
    { mode: "apply", manifest },
  );

  assertEquals(response.status, 202);
  assertEquals(captured.length, 1);
  assertEquals(captured[0].url, "https://kernel.example.com/v1/deployments");
  assertEquals(captured[0].bodyJson, { mode: "apply", manifest });
});

Deno.test("workflow runner reports unknown job", async () => {
  const result = await runWorkflow({
    file: workflow,
    job: "missing",
    event: manualEvent("ci"),
    executor: () => Promise.resolve({ stdout: "", exitCode: 0 }),
    resolveArtifact: () =>
      Promise.resolve({ name: "x", uri: "x" } satisfies ResolvedArtifact),
  });
  assertEquals(result.success, false);
  assertEquals(result.job, "missing");
});
