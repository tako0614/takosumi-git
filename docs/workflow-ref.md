# WorkflowRef

> Stability: v0 Audience: workflow author, CLI implementer Owner: takosumi-git

`workflowRef` is a private takosumi-git extension placed on a Takosumi v1
manifest resource. It is not part of the Takosumi kernel manifest schema and is
always stripped before `POST /v1/deployments`.

## Shape

```ts
interface ComputeWorkflowRef {
  readonly file: string;
  readonly job: string;
  readonly artifact: string;
  readonly target?: `spec.${string}`;
}
```

Placement:

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
      # Optional. Defaults to spec.image.
      target: spec.image
```

| Field      | Meaning                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------- |
| `file`     | Workflow YAML file name resolved relative to `--workflows-dir` (default `.takosumi/workflows`)      |
| `job`      | Job name inside the workflow file                                                                   |
| `artifact` | Artifact name expected from the job; used as the fallback resolved artifact name                    |
| `target`   | Optional dotted field path below `spec`; defaults to `spec.image`, for example `spec.artifact.hash` |

## Resolution Flow

1. `takosumi-git push` reads `.takosumi/manifest.yml`.
2. It finds every `resources[i].workflowRef`.
3. It loads `workflowRef.file` from the workflows directory.
4. It runs `workflowRef.job`.
5. It resolves the job artifact URI according to
   [Artifact URI Contract](./artifact-contract.md).
6. It writes the URI to `workflowRef.target`, or to `resources[i].spec.image`
   when `target` is omitted.
7. It adds resource-level `metadata.takosumiGitProvenance` with digests for the
   resolved artifact chain.
8. It deletes `workflowRef` from every resource entry.
9. It submits the cleaned manifest plus top-level deployment provenance to the
   kernel unless `--dry-run` was passed.

Resource entries without `workflowRef` are left unchanged.

## Kernel Boundary

Takosumi kernel only sees this:

```yaml
resources:
  - name: web
    shape: web-service@v1
    provider: "@takos/aws-fargate"
    spec:
      port: 8080
      image: ghcr.io/example/demo@sha256:0123456789abcdef
    metadata:
      takosumiGitProvenance:
        kind: takosumi-git.resource-provenance@v1
        provenanceDigest: sha256:...
        workflowRunId: takosumi-git:run:...
        gitCommitSha: 0123456789abcdef0123456789abcdef01234567
        artifactUri: ghcr.io/example/demo@sha256:0123456789abcdef
        stepLogDigests:
          - sha256:...
```

The kernel also receives an optional top-level
`takosumi-git.deployment-provenance@v1` JSON object containing the workflow run
id, git metadata, artifact URI, and per-step stdout digests. That payload is
opaque audit evidence: the kernel records it in its WAL but does not load
workflow files, execute jobs, parse build logs, or interpret git semantics.
Build and git concerns stay in takosumi-git.

## Validation and Errors

`push` requires `file`, `job`, and `artifact` to be strings. `target`, when
present, must be a dotted field path below `spec`. Invalid entries fail before
the kernel request with:

```text
resources[i].workflowRef must have string {file, job, artifact, target?}
resources[i].workflowRef.target must be a dotted field path below spec, such as spec.image or spec.artifact.hash
```

If the workflow job is missing, a step fails, or no artifact URI can be
resolved, `push` fails before `POST /v1/deployments`. See
[Artifact URI Contract](./artifact-contract.md) for artifact-specific failure
modes.
