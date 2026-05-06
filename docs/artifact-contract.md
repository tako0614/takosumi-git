# Artifact URI Contract

> Stability: v0 Audience: workflow author, CLI implementer Owner: takosumi-git

This document defines how `takosumi-git push` resolves a workflow output into
the artifact URI that is written into the Takosumi manifest. The Takosumi kernel
does not run builds, read workflow files, or interpret `workflowRef`; it only
receives the cleaned manifest over `POST /v1/deployments`.

## Scope

The v0 contract applies when a manifest resource has a private takosumi-git
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

## Producer Rule

The referenced workflow job must declare an `artifact` field and all selected
steps must exit with status `0`. After the job succeeds, `takosumi-git push`
scans captured step stdout chunks from the last step back to the first step and
uses the final non-empty stdout line it finds as the artifact URI.

For a container image, make the final meaningful stdout line the immutable image
URI:

```yaml
version: "0"
jobs:
  - name: image
    steps:
      - name: build
        run: |
          docker build -t ghcr.io/example/app:${GIT_SHA} .
          docker push ghcr.io/example/app:${GIT_SHA}
          echo "ghcr.io/example/app@sha256:0123456789abcdef"
    artifact:
      name: image
```

The v0 resolver intentionally does not parse log formats, environment markers,
JSON envelopes, or files. It also does not validate the URI scheme or digest
pin; a bad URI may be rejected later by Takosumi or by the provider. Workflow
authors should print a digest-pinned OCI image URI for `web-service@v1`.

## Stderr Handling

The default executor captures stderr separately and appends it to logs after a
`[stderr]` separator for human debugging. The URI resolver only reads stdout
before that separator. Printing a URI to stderr does not satisfy this contract.

## Failure Modes

| Condition                                        | Result                                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Referenced workflow file or job is missing       | `push` fails before POST                                                                 |
| A selected step exits non-zero                   | `push` fails before POST and includes the job logs                                       |
| The job has no `artifact` field                  | `push` fails before POST                                                                 |
| Successful job produces no non-empty stdout line | `push` fails with `workflow job '<job>' produced no stdout; cannot resolve artifact URI` |
| URI is present but not digest-pinned             | `push` succeeds; downstream validation/provider may reject                               |

`--dry-run` still executes the workflow and resolves the URI, but it prints the
cleaned manifest instead of sending `POST /v1/deployments`.

## Stability

v0 is intentionally minimal so any build system can implement it with one final
`echo`. A future v1 may add a structured marker such as
`TAKOSUMI_ARTIFACT=<uri>`, stderr markers, or a generated
`.takosumi-git/last-artifact.json` file. Until that v1 is accepted, the final
non-empty stdout line remains the contract.

## Drift Check

- Source of truth: `packages/cli/src/push.ts` (`lastLineArtifactResolver`,
  `setResourceImage`, `stripWorkflowRefs`).
- Contract types: `packages/workflow-contract/src/mod.ts` (`ComputeWorkflowRef`,
  `ResolvedArtifact`, `WorkflowJobSpec`).
- Tests: `packages/cli/src/push_test.ts` and `docs/artifact-contract_test.ts`.
