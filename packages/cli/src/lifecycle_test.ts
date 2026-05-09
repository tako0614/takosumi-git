import { assertEquals } from "@std/assert";
import { parseLifecycleArgs, runLifecycle } from "./lifecycle.ts";

Deno.test("parseLifecycleArgs reads materialize options from env", () => {
  const parsed = parseLifecycleArgs("materialize", [
    "inst_1",
    "--region",
    "tokyo",
    "--compute",
    "small",
    "--database",
    "small",
    "--object-store",
    "standard",
    "--cutover-strategy",
    "blue-green",
    "--drain-seconds",
    "30",
    "--cost-ack",
  ], {
    get(key: string) {
      const env: Record<string, string> = {
        TAKOSUMI_ACCOUNTS_URL: "http://accounts.example",
        TAKOS_TOKEN: "secret",
      };
      return env[key];
    },
  });

  assertEquals(parsed.operation, "materialize");
  assertEquals(parsed.installationId, "inst_1");
  assertEquals(parsed.accountsUrl, "http://accounts.example");
  assertEquals(parsed.token, "secret");
  assertEquals(parsed.materialize?.region, "tokyo");
  assertEquals(parsed.materialize?.plan, {
    compute: "small",
    database: "small",
    objectStore: "standard",
  });
  assertEquals(parsed.materialize?.cutover, {
    strategy: "blue-green",
    drainSeconds: 30,
  });
});

Deno.test("parseLifecycleArgs requires explicit materialize cost ack", () => {
  assertEquals(
    (() => {
      try {
        parseLifecycleArgs("materialize", [
          "inst_1",
          "--region",
          "tokyo",
          "--accounts-url",
          "http://accounts.example",
        ]);
        return "ok";
      } catch (error) {
        return (error as Error).message;
      }
    })(),
    "--cost-ack is required",
  );
});

Deno.test("runLifecycle posts a materialize operation", async () => {
  const requests: Request[] = [];
  const result = await runLifecycle({
    operation: "materialize",
    installationId: "inst_1",
    accountsUrl: "http://accounts.example/",
    token: "secret",
    idempotencyKey: "idem-materialize",
    json: true,
    materialize: {
      region: "tokyo",
      plan: {
        compute: "small",
        database: "small",
        objectStore: "standard",
      },
      cutover: {
        strategy: "blue-green",
        drainSeconds: 30,
      },
      permissionDigest: "sha256:permissions",
    },
    fetch: (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Promise.resolve(Response.json({
        operationId: "op_materialize",
        installationId: "inst_1",
        fromMode: "shared-cell",
        toMode: "dedicated",
        trackingUrl:
          "/v1/installations/inst_1/events?types=installation.materialize-requested",
      }, { status: 202 }));
    },
  });

  assertEquals(result.response.status, 202);
  assertEquals(
    requests[0].url,
    "http://accounts.example/v1/installations/inst_1/materialize",
  );
  assertEquals(requests[0].method, "POST");
  assertEquals(requests[0].headers.get("authorization"), "Bearer secret");
  assertEquals(
    requests[0].headers.get("idempotency-key"),
    "idem-materialize",
  );
  assertEquals(await requests[0].json(), {
    mode: "dedicated",
    region: "tokyo",
    plan: {
      compute: "small",
      database: "small",
      objectStore: "standard",
    },
    cutover: {
      strategy: "blue-green",
      drainSeconds: 30,
    },
    confirm: {
      costAck: true,
      permissionDigest: "sha256:permissions",
    },
  });
});

Deno.test("parseLifecycleArgs reads export options", () => {
  const parsed = parseLifecycleArgs("export", [
    "inst_1",
    "--include-data",
    "--encryption-method",
    "age",
    "--recipient",
    "age1one,age1two",
    "--data",
    "postgres,blobs",
    "--secrets",
    "templates-only",
    "--accounts-url",
    "http://accounts.example",
  ]);

  assertEquals(parsed.operation, "export");
  assertEquals(parsed.export?.includeData, true);
  assertEquals(parsed.export?.encryption, {
    method: "age",
    recipients: ["age1one", "age1two"],
  });
  assertEquals(parsed.export?.scope, {
    data: ["postgres", "blobs"],
    secrets: "templates-only",
  });
});

Deno.test("parseLifecycleArgs requires age recipients", () => {
  assertEquals(
    (() => {
      try {
        parseLifecycleArgs("export", [
          "inst_1",
          "--encryption-method",
          "age",
          "--accounts-url",
          "http://accounts.example",
        ]);
        return "ok";
      } catch (error) {
        return (error as Error).message;
      }
    })(),
    "--recipient is required when --encryption-method age",
  );
});

Deno.test("runLifecycle posts an export operation", async () => {
  const requests: Request[] = [];
  const result = await runLifecycle({
    operation: "export",
    installationId: "inst_1",
    accountsUrl: "http://accounts.example/",
    token: "secret",
    idempotencyKey: "idem-export",
    json: true,
    export: {
      includeData: true,
      encryption: {
        method: "age",
        recipients: ["age1one", "age1two"],
      },
      scope: {
        data: ["postgres", "blobs"],
        secrets: "templates-only",
      },
    },
    fetch: (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Promise.resolve(Response.json({
        operationId: "op_export",
        status: "preparing",
        trackingUrl:
          "/v1/installations/inst_1/events?types=installation.export-requested",
        downloadUrl: null,
        downloadExpiresAt: null,
      }, { status: 202 }));
    },
  });

  assertEquals(result.response.status, 202);
  assertEquals(
    requests[0].url,
    "http://accounts.example/v1/installations/inst_1/export",
  );
  assertEquals(requests[0].method, "POST");
  assertEquals(requests[0].headers.get("authorization"), "Bearer secret");
  assertEquals(requests[0].headers.get("idempotency-key"), "idem-export");
  assertEquals(await requests[0].json(), {
    includeData: true,
    format: "bundle",
    encryption: {
      method: "age",
      recipients: ["age1one", "age1two"],
    },
    scope: {
      data: ["postgres", "blobs"],
      secrets: "templates-only",
    },
  });
});
