# Changelog

All notable changes to `takosumi-git` are recorded here. The CLI version follows
the package version of `@takos/takosumi-git-cli`.

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
  non-empty stdout line as the artifact URI, substitute it into the
  corresponding `compute.<name>.image` field, strip the private `workflowRef`
  extension, and POST the cleaned manifest to the takosumi kernel via
  `POST /v1/deployments`.
