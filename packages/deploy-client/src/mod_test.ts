import assert from "node:assert/strict";
import { type DeployRequest, postDeployment } from "./mod.ts";

const request: DeployRequest = {
  mode: "apply",
  manifest: {
    apiVersion: "1.0",
    kind: "Manifest",
    metadata: { name: "app" },
  },
};

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

function headersOf(init: FetchInit | undefined): Headers {
  return new Headers(
    (init as { headers?: HeadersInit } | undefined)?.headers,
  );
}

function bodyOf(init: FetchInit | undefined): string {
  return String((init as { body?: BodyInit | null } | undefined)?.body ?? "");
}

Deno.test("postDeployment sends bearer auth and idempotency key", async () => {
  const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const response = await postDeployment(
    {
      endpoint: "https://kernel.example.com",
      token: "token-1",
      idempotencyKey: "idem-1",
      fetch: ((input, init) => {
        calls.push({
          url: input.toString(),
          headers: headersOf(init),
          body: JSON.parse(bodyOf(init)),
        });
        return Promise.resolve(
          new Response(JSON.stringify({ accepted: true }), { status: 202 }),
        );
      }) as typeof fetch,
    },
    request,
  );

  assert.equal(response.status, 202);
  assert.equal(response.attempts, 1);
  assert.equal(response.idempotencyKey, "idem-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://kernel.example.com/v1/deployments");
  assert.equal(calls[0].headers.get("authorization"), "Bearer token-1");
  assert.equal(calls[0].headers.get("x-idempotency-key"), "idem-1");
  assert.deepEqual(calls[0].body, request);
});

Deno.test("postDeployment retries transient HTTP statuses with the same idempotency key", async () => {
  const statuses = [503, 202];
  const seenKeys: string[] = [];
  const delays: number[] = [];
  const response = await postDeployment(
    {
      endpoint: "https://kernel.example.com",
      token: "token-1",
      idempotencyKey: "idem-retry",
      retry: {
        attempts: 3,
        baseDelayMs: 10,
        sleep: (delayMs) => {
          delays.push(delayMs);
          return Promise.resolve();
        },
      },
      fetch: ((_input, init) => {
        seenKeys.push(headersOf(init).get("x-idempotency-key") ?? "");
        const status = statuses.shift() ?? 500;
        return Promise.resolve(
          new Response(JSON.stringify({ status }), { status }),
        );
      }) as typeof fetch,
    },
    request,
  );

  assert.equal(response.status, 202);
  assert.equal(response.attempts, 2);
  assert.deepEqual(seenKeys, ["idem-retry", "idem-retry"]);
  assert.deepEqual(delays, [10]);
});

Deno.test("postDeployment retries network errors", async () => {
  const delays: number[] = [];
  let calls = 0;
  const response = await postDeployment(
    {
      endpoint: "https://kernel.example.com",
      token: "token-1",
      retry: {
        attempts: 2,
        baseDelayMs: 5,
        sleep: (delayMs) => {
          delays.push(delayMs);
          return Promise.resolve();
        },
      },
      fetch: (() => {
        calls++;
        if (calls === 1) return Promise.reject(new TypeError("socket closed"));
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch,
    },
    request,
  );

  assert.equal(response.status, 200);
  assert.equal(response.attempts, 2);
  assert.deepEqual(delays, [5]);
});

Deno.test("postDeployment does not retry non-transient 409 responses", async () => {
  let calls = 0;
  const response = await postDeployment(
    {
      endpoint: "https://kernel.example.com",
      token: "token-1",
      retry: {
        attempts: 3,
        sleep: () => {
          throw new Error("should not sleep");
        },
      },
      fetch: (() => {
        calls++;
        return Promise.resolve(
          new Response(JSON.stringify({ error: "conflict" }), { status: 409 }),
        );
      }) as typeof fetch,
    },
    request,
  );

  assert.equal(response.status, 409);
  assert.equal(response.attempts, 1);
  assert.equal(calls, 1);
});

Deno.test("postDeployment surfaces the final network error", async () => {
  await assert.rejects(
    () =>
      postDeployment(
        {
          endpoint: "https://kernel.example.com",
          token: "token-1",
          retry: { attempts: 2, sleep: () => Promise.resolve() },
          fetch:
            (() => Promise.reject(new TypeError("offline"))) as typeof fetch,
        },
        request,
      ),
    { name: "TypeError", message: "offline" },
  );
});
