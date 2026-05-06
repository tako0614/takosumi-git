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
the manifest is posted to the kernel. The resolved URI is written to
`resources[i].spec.image`.

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
          echo "TAKOSUMI_ARTIFACT=ghcr.io/example/app@sha256:0123456789abcdef"
    artifact:
      name: image
```

The v1 resolver intentionally does not parse JSON envelopes, files, or shell
environment state from the child process. The marker must be printed to stdout.
It also does not validate the URI scheme or digest pin; a bad URI may be
rejected later by Takosumi or by the provider. Workflow authors should print a
digest-pinned OCI image URI for `web-service@v1`.

## Legacy v0 Contract

v0 used the final non-empty stdout line as the artifact URI. It is retained for
older projects through `--artifact-contract v0`:

```bash
takosumi-git push --artifact-contract v0
```

`--artifact-contract auto` first looks for the v1 `TAKOSUMI_ARTIFACT=<uri>`
marker, then falls back to the v0 final non-empty stdout line. New projects
scaffolded by `takosumi-git init` use v1 and should not rely on auto fallback.

## Stderr Handling

The default executor captures stderr separately and appends it to logs after a
`[stderr]` separator for human debugging. The URI resolver only reads stdout
before that separator. Printing a URI to stderr does not satisfy this contract.

## Failure Modes

| Condition                                  | Result                                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Referenced workflow file or job is missing | `push` fails before POST                                                                                         |
| A selected step exits non-zero             | `push` fails before POST and includes the job logs                                                               |
| The job has no `artifact` field            | `push` fails before POST                                                                                         |
| v1 job produces no marker                  | `push` fails with `workflow job '<job>' produced no TAKOSUMI_ARTIFACT=<uri> marker; cannot resolve artifact URI` |
| v0 job produces no non-empty stdout line   | `push` fails with `workflow job '<job>' produced no stdout; cannot resolve artifact URI`                         |
| URI is present but not digest-pinned       | `push` succeeds; downstream validation/provider may reject                                                       |

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

## Stability

v1 is the default artifact URI contract. v0 remains a legacy resolver for the
transition window and must be selected explicitly with `--artifact-contract v0`
or `--artifact-contract auto`.

## Drift Check

- Source of truth: `packages/cli/src/push.ts` (`artifactContractResolver`,
  `lastLineArtifactResolver`, `parseArtifactContract`, `setResourceImage`,
  `setResourceProvenanceMetadata`, `stripWorkflowRefs`).
- Contract types: `packages/workflow-contract/src/mod.ts` (`ComputeWorkflowRef`,
  `ResolvedArtifact`, `WorkflowJobSpec`).
- Tests: `packages/cli/src/push_test.ts` and `docs/artifact-contract_test.ts`.
