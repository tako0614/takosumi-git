# Changelog

All notable changes to `takosumi-git` are recorded here. The CLI version follows
the package version of `@takos/takosumi-git-cli`.

## Unreleased

- Added artifact URI contract v1: workflow steps now print
  `TAKOSUMI_ARTIFACT=<uri>` and `takosumi-git push` resolves that marker by
  default.
- Added `--artifact-contract v0|v1|auto`; v0 keeps the last non-empty stdout
  line resolver as an explicit legacy mode, and `auto` tries v1 before v0.
- Updated `takosumi-git init`, README, quickstart, and artifact contract docs to
  generate and document v1 marker output.
- Implemented `takosumi-git history` with manifest commit listing and
  `--resource <name>` semantic YAML diff output.
- Implemented `takosumi-git serve` with GitHub / GitLab / Gitea webhook routes,
  HMAC-SHA256 verification, in-memory rate limiting, delivery dedup, queue
  draining, and webhook-triggered push dispatch.

## 0.3.0

- Aligned `takosumi-git push` with the takosumi v1 manifest envelope. The
  manifest is now read as
  `apiVersion / kind / metadata / template /
  resources[]`; the private
  `workflowRef` extension lives at `resources[i].workflowRef` (sibling of
  `shape` / `spec` / `name` / etc.) rather than the legacy
  `compute.<name>.workflowRef` form. The resolved artifact URI is substituted
  into `resources[i].spec.image`. This matches what `takosumi-git init` already
  scaffolds and what the takosumi kernel accepts on `POST /v1/deployments`.
- All `push` tests rewritten against the v1 envelope.
- Added `docs/artifact-contract.md` to make the v0 artifact URI contract
  explicit: `push` resolves the last non-empty stdout line from successful
  workflow steps into `resources[i].spec.image` before stripping `workflowRef`.
- Added `docs/quickstart.md` and `docs/workflow-ref.md`; README now links the
  minimum publish-ready docs set.
- `@takos/takosumi-git-deploy-client` now sends `X-Idempotency-Key` and retries
  transient network / HTTP failures with bounded exponential backoff, reusing
  the same idempotency key across attempts.

## 0.2.0

- Added `takosumi-git init` for scaffolding the `.takosumi/` project layout
  (`manifest.yml` + `workflows/build.yml`). Supports `--cwd`, `--name`, and
  `--force` flags. Refuses to overwrite an existing manifest by default.
- Documented `.takosumi/` as the canonical project convention owned by
  `takosumi-git`. The takosumi kernel no longer auto-discovers manifests by file
  layout; this convention is now authoritative here.
- Bumped `@takos/takosumi-git-cli` to 0.2.0.

## 0.1.0

- Initial `takosumi-git push` implementation: parse `.takosumi/manifest.yml`,
  execute the referenced workflow jobs via `bash -lc`, capture the last
  non-empty stdout line as the artifact URI, substitute it into the resolved
  resource entry's `image` field, strip the private `workflowRef` extension, and
  POST the cleaned manifest to the takosumi kernel via `POST /v1/deployments`.
