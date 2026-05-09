# takosumi-git

`takosumi-git` is a sibling product of
[`takosumi`](https://github.com/tako0614/takosumi) that bridges git repositories
and the takosumi manifest deploy engine.

## What it does

1. Watches a git repository (push / PR / tag) or receives webhook events.
2. Runs the build pipeline declared under `.takosumi/workflows/` (image build,
   artifact upload).
3. Resolves artifact URIs and generates a `Manifest` document.
4. Submits the manifest and opaque deployment provenance to a takosumi kernel
   via `POST /v1/deployments`.
5. Treats the git history of the manifest as the authoritative version history.

The takosumi kernel itself remains a pure manifest deploy engine — it never sees
workflow definitions, never schedules anything, never runs workflow steps, and
never interprets git semantics. `takosumi-git` may attach an opaque
`takosumi-git.deployment-provenance@v1` JSON chain so the kernel WAL can record
which workflow run, git commit, artifact URI, and step log digests produced the
deployed manifest.

## Quick start

```bash
# from the root of your repo
takosumi-git init                  # scaffolds .takosumi/manifest.yml + .takosumi/workflows/build.yml
$EDITOR .takosumi/manifest.yml     # set image URI policy / resources
takosumi-git push --endpoint $TAKOSUMI_ENDPOINT --token $TAKOSUMI_TOKEN
```

The `.takosumi/` project layout is owned by `takosumi-git`. The takosumi kernel
takes manifests by explicit path or HTTP body and has no opinion on file layout
— see [AGENTS.md](./AGENTS.md) for the full convention.

## Status

`takosumi-git init` and `takosumi-git push` are implemented. `init` scaffolds
the `.takosumi/` project layout (`manifest.yml` + `workflows/build.yml`). `push`
parses `.takosumi/manifest.yml` (a takosumi v1 manifest envelope), resolves each
`resources[i].workflowRef` by running the referenced workflow job's steps (via
`bash -lc`) and reading the v1 `TAKOSUMI_ARTIFACT=<uri>` stdout marker,
substitutes the resolved artifact URI into that resource entry's `spec.image`
field, strips the private `workflowRef` extension, attaches resource-level
provenance metadata plus a top-level deployment provenance chain, and posts the
cleaned manifest to a takosumi kernel via `POST /v1/deployments`. `history`
lists manifest commits and renders per-resource semantic diffs. `serve` exposes
GitHub / GitLab / Gitea webhook routes with signature verification, rate
limiting, delivery dedup, queue draining, and push dispatch. See
[AGENTS.md](./AGENTS.md) for package layout and design boundaries.

## Docs

- [Quickstart](./docs/quickstart.md)
- [WorkflowRef](./docs/workflow-ref.md)
- [Artifact URI Contract](./docs/artifact-contract.md)
- [History](./docs/history.md)
- [Serve](./docs/serve.md)

## Release

Semver tags (`v*.*.*`) run `.github/workflows/release.yml`. The workflow checks
the workspace, runs tests, performs a JSR dry-run, then publishes the
takosumi-git JSR package set with GitHub OIDC. Manual workflow runs stay dry-run
unless the explicit `publish` input is set. Tags are repository-level release
markers; every publishable package version must already be bumped to the
intended unpublished JSR version before tagging.
