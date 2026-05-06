# takosumi-git

`takosumi-git` is a sibling product of
[`takosumi`](https://github.com/tako0614/takosumi) that bridges git repositories
and the takosumi manifest deploy engine.

## What it does

1. Watches a git repository (push / PR / tag) or receives webhook events.
2. Runs the build pipeline declared under `.takosumi/workflows/` (image build,
   artifact upload).
3. Resolves artifact URIs and generates a `Manifest` document.
4. Submits the manifest to a takosumi kernel via `POST /v1/deployments`.
5. Treats the git history of the manifest as the authoritative version history.

The takosumi kernel itself remains a pure manifest deploy engine — it never sees
git, never schedules anything, never runs workflow steps. All workflow concerns
live on this side of the `POST /v1/deployments` boundary.

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
parses `.takosumi/manifest.yml`, resolves each `compute.<name>.workflowRef` by
running the referenced workflow job's steps (via `bash -lc`), substitutes the
resolved artifact URI into the corresponding `image` field, strips the private
`workflowRef` extension, and posts the cleaned manifest to a takosumi kernel via
`POST /v1/deployments`. `serve` (webhook receiver) and `history` (manifest
version listing) remain stubs. See [AGENTS.md](./AGENTS.md) for package layout
and design boundaries.
