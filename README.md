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

## Status

Skeleton — package stubs only. See [AGENTS.md](./AGENTS.md) for the planned
package layout and design boundaries.
