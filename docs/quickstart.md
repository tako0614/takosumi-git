# Quickstart

> Stability: v1 Audience: workflow author Owner: takosumi-git

This quickstart uses the source checkout. After the JSR publish step lands, the
same flow should work through
`deno install -gA -n takosumi-git
jsr:@takos/takosumi-git-cli`. The installed
command equivalents are `takosumi-git init` and `takosumi-git push`.

## 1. Scaffold

From the root of the app repository:

```bash
deno run -A /path/to/takosumi-git/packages/cli/src/main.ts init --name demo
```

This writes:

```text
.takosumi/
├── manifest.yml
└── workflows/
    └── build.yml
```

The Takosumi kernel does not read this directory. It is a takosumi-git project
convention.

## 2. Edit the Manifest

Open `.takosumi/manifest.yml` and set the resource shape, provider, and spec.
Resources that need a build output use `resources[i].workflowRef`:

```yaml
resources:
  - name: web
    shape: web-service@v1
    provider: "@takos/aws-fargate"
    spec:
      port: 8080
    workflowRef:
      file: build.yml
      job: image
      artifact: image
```

See [WorkflowRef](./workflow-ref.md) for the field contract.

## 3. Make the Workflow Print an Artifact URI Marker

Open `.takosumi/workflows/build.yml`. Artifact URI v1 is the default contract:
the successful workflow must print `TAKOSUMI_ARTIFACT=<uri>` to stdout.

```yaml
version: "0"
jobs:
  - name: image
    steps:
      - name: build
        run: |
          docker build -t ghcr.io/example/demo:${GIT_SHA} .
          docker push ghcr.io/example/demo:${GIT_SHA}
          echo "TAKOSUMI_ARTIFACT=ghcr.io/example/demo@sha256:0123456789abcdef"
    artifact:
      name: image
```

See [Artifact URI Contract](./artifact-contract.md) for v1 marker, legacy v0,
and failure semantics.

## 4. Dry Run

Dry-run executes workflows, strips `workflowRef`, writes the resolved URI into
`resources[i].spec.image`, and prints the cleaned manifest without sending it to
the kernel:

```bash
deno run -A /path/to/takosumi-git/packages/cli/src/main.ts push --dry-run
```

## 5. Apply

When the manifest looks correct, submit it to a Takosumi kernel:

```bash
deno run -A /path/to/takosumi-git/packages/cli/src/main.ts push \
  --endpoint "$TAKOSUMI_ENDPOINT" \
  --token "$TAKOSUMI_TOKEN"
```

`push` sends the cleaned Takosumi v1 manifest and an opaque
`takosumi-git.deployment-provenance@v1` chain to `POST /v1/deployments`. The
kernel never receives `.takosumi/workflows/*.yml` or `workflowRef`, and it does
not execute or interpret workflows; it only records the provenance JSON for
audit.
