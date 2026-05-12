# Artifact URI Contract

> Stability: v1 Audience: workflow author, CLI implementer Owner: takosumi-git

This document defines how `takosumi-git push` resolves a workflow output into
the artifact URI that is written into the Takosumi manifest. The Takosumi kernel
does not run builds, read workflow files, or interpret `workflowRef`; it only
receives the cleaned manifest plus opaque deploy provenance over
`POST /v1/deployments`.

## Scope

The contract applies when a manifest resource has a private takosumi-git
extension:

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

`resources[i].workflowRef` is read by `takosumi-git push`, then stripped before
the manifest is posted to the kernel. By default, the resolved URI is written to
`resources[i].spec.image`. A resource can set `workflowRef.target` to another
dotted field below `spec`, such as `spec.artifact.hash`, when the provider
expects a different artifact field.

## v1 Producer Rule

The referenced workflow job must declare an `artifact` field and all selected
steps must exit with status `0`. After the job succeeds, `takosumi-git push`
scans captured step stdout chunks from the last step back to the first step and
uses the final `TAKOSUMI_ARTIFACT=<uri>` marker it finds as the artifact URI.

For a container image, print the immutable image URI through that marker:

```yaml
version: "0"
jobs:
  - name: image
    steps:
      - name: build
        run: |
          docker build -t ghcr.io/example/app:${GIT_SHA} .
          docker push ghcr.io/example/app:${GIT_SHA}
          echo "TAKOSUMI_ARTIFACT=ghcr.io/example/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    artifact:
      name: image
```

The v1 resolver intentionally does not parse JSON envelopes, files, or shell
environment state from the child process. The marker must be printed to stdout.
When the artifact is written to `spec.image` (the default target), the URI must
be digest-pinned as `<image>@sha256:<64-hex>`. A resource can use
`workflowRef.target` for provider-specific immutable artifact references that
are not OCI image URIs.

## Stderr Handling

The default executor captures stderr separately and appends it to logs after a
`[stderr]` separator for human debugging. The URI resolver only reads stdout
before that separator. Printing a URI to stderr does not satisfy this contract.

## Build Environment

The default workflow executor runs build steps with a cleared process
environment and only a small allowlist needed to locate shell tools and
temporary directories (`PATH`, `HOME`, `TMPDIR`, `TMP`, `TEMP`, `USER`,
`LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `TERM`). Runtime credentials and operator
tokens such as `TAKOS_TOKEN`, `TAKOSUMI_TOKEN`, `OIDC_CLIENT_SECRET`, or
`DATABASE_URL` are not inherited by workflow steps. Build workflows must receive
publish credentials through a future explicit build-secret mechanism, not
through the operator process environment. `workflowRef.file` must be a relative
path inside `.takosumi/workflows`; paths that escape the workflows directory,
including symlink escapes, are rejected before execution.

## Failure Modes

| Condition                                  | Result                                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Referenced workflow file or job is missing | `push` fails before POST                                                                                         |
| A selected step exits non-zero             | `push` fails before POST and includes the job logs                                                               |
| The job has no `artifact` field            | `push` fails before POST                                                                                         |
| v1 job produces no marker                  | `push` fails with `workflow job '<job>' produced no TAKOSUMI_ARTIFACT=<uri> marker; cannot resolve artifact URI` |
| `spec.image` URI is not digest-pinned      | `push` fails before POST                                                                                         |

`--dry-run` still executes the workflow and resolves the URI, but it prints the
cleaned manifest instead of sending `POST /v1/deployments`.

## Provenance Chain

For every resolved artifact, `takosumi-git push` records:

- workflow run id (`takosumi-git:run:<uuid>`)
- git repository / ref / commit metadata when available
- resource name, workflow file/job/artifact, resolved artifact URI, and optional
  artifact digest
- per-step stdout digest, byte count, exit code, and step name

The resource receives `metadata.takosumiGitProvenance` with the workflow run id,
git commit SHA, artifact URI, provenance digest, and step log digests. The
`POST /v1/deployments` body also includes a top-level
`takosumi-git.deployment-provenance@v1` object. The Takosumi kernel persists
that JSON as opaque WAL evidence; it does not execute or interpret the workflow.

## Drift Check

- Source of truth: `packages/cli/src/push.ts` (`artifactContractResolver`,
  `lastLineArtifactResolver`, `parseArtifactContract`,
  `setResourceArtifactTarget`, `setResourceProvenanceMetadata`,
  `stripWorkflowRefs`).
- Contract types: `packages/workflow-contract/src/mod.ts` (`ComputeWorkflowRef`,
  `ResolvedArtifact`, `WorkflowJobSpec`).
- Tests: `packages/cli/src/push_test.ts` and `docs/artifact-contract_test.ts`.
