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
```

| Field      | Meaning                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `file`     | Workflow YAML file name resolved relative to `--workflows-dir` (default `.takosumi/workflows`) |
| `job`      | Job name inside the workflow file                                                              |
| `artifact` | Artifact name expected from the job; used as the fallback resolved artifact name               |

## Resolution Flow

1. `takosumi-git push` reads `.takosumi/manifest.yml`.
2. It finds every `resources[i].workflowRef`.
3. It loads `workflowRef.file` from the workflows directory.
4. It runs `workflowRef.job`.
5. It resolves the job artifact URI according to
   [Artifact URI Contract](./artifact-contract.md).
6. It writes the URI to `resources[i].spec.image`.
7. It deletes `workflowRef` from every resource entry.
8. It submits the cleaned manifest to the kernel unless `--dry-run` was passed.

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
```

It does not know the workflow file, job name, artifact name, git repository, or
build logs. Build and git concerns stay in takosumi-git.

## Validation and Errors

`push` requires `file`, `job`, and `artifact` to be strings. Invalid entries
fail before the kernel request with:

```text
resources[i].workflowRef must have string {file, job, artifact}
```

If the workflow job is missing, a step fails, or no artifact URI can be
resolved, `push` fails before `POST /v1/deployments`. See
[Artifact URI Contract](./artifact-contract.md) for artifact-specific failure
modes.
