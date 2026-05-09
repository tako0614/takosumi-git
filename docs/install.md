# Install Preview and Apply

`takosumi-git install` is the installer-facing command family for
`.takosumi/app.yml`. The app file is installer-bound metadata: it is parsed by
takosumi-git, shown to the user before approval, and used to create an
AppInstallation ledger record in Takosumi Accounts. It is never posted to the
takosumi kernel. When apply is given a Takosumi kernel endpoint, the compiled
kernel manifest is posted separately after the Accounts ledger request.

## Files

A repository that supports Git URL install contains both installer metadata and
the kernel manifest:

```text
.takosumi/app.yml       # InstallableApp v1, read by takosumi-git
.takosumi/manifest.yml  # kernel-bound manifest, posted only after compilation
```

`app.yml` must use:

```yaml
apiVersion: app.takosumi.dev/v1
kind: InstallableApp
```

The parser rejects unknown fields, mutable refs such as `main` or `HEAD`, and
binding or permission names outside the v1 catalogs.

## Preview

Use preview before creating any ledger record:

```bash
takosumi-git install preview --cwd . --json
```

Preview can also read directly from a Git source. The ref must be immutable
enough for approval evidence: a full commit SHA, a semver tag, a release tag, or
`refs/tags/<tag>`.

```bash
takosumi-git install preview https://github.com/example/hello --ref v1.2.3 --json
```

The preview response is `takosumi-git.install-preview@v1` and includes:

- app identity, publisher, homepage
- source git URL, ref, optional commit, and manifest digests
- runtime modes
- requested binding kinds
- requested service imports with service identifier, alias, endpoint roles, and
  refresh policy
- requested AppGrant capabilities
- permission digest
- compatibility warnings

Preview is non-mutating. It does not call Takosumi Accounts and does not call
the takosumi kernel.

When running `takosumi-git serve`, the same preview surface is available as a
non-mutating API. The body can provide inline `appYml` / `manifestYml`, or a Git
source:

```text
POST /v1/install/preview
```

```json
{
  "gitUrl": "https://github.com/example/hello",
  "ref": "v1.2.3"
}
```

## Apply

Use apply after the source has a concrete commit pin:

```bash
takosumi-git install apply \
  --cwd . \
  --accounts-url http://127.0.0.1:8787 \
  --account-id acct_... \
  --space-id space_... \
  --subject tsub_... \
  --source-commit 0123456789abcdef0123456789abcdef01234567 \
  --runtime-base-url https://app.example.com \
  --mode shared-cell \
  --endpoint "$TAKOSUMI_ENDPOINT" \
  --deploy-token "$TAKOSUMI_DEPLOY_TOKEN"
```

For Git URL apply, pass the same source and ref. takosumi-git checks out the
ref, verifies that `.takosumi/app.yml` declares the same `source.git` and
`source.ref`, resolves the concrete commit, and records that commit in the
AppInstallation request.

```bash
takosumi-git install apply https://github.com/example/hello \
  --ref v1.2.3 \
  --accounts-url http://127.0.0.1:8787 \
  --account-id acct_... \
  --space-id space_... \
  --subject tsub_...
```

`install apply` posts to Takosumi Accounts:

```text
POST /v1/installations
```

The request carries the AppInstallation source pin, `appManifestDigest`,
`compiledManifestDigest` when `.takosumi/manifest.yml` is present, AppBinding
records derived from `app.yml` binding declarations, service import requests
derived from `app.yml` `serviceImports[]`, and AppGrant records derived from
`permissions.requested`. When `--runtime-base-url` (or
`TAKOSUMI_RUNTIME_BASE_URL`) is supplied, `identity.oidc@v1` redirect paths are
materialized into absolute redirect URIs and sent as an `oidcClients[]` request
so Takosumi Accounts can create the per-installation OIDC client in the same
ledger transaction.

If `--endpoint` (or `TAKOSUMI_ENDPOINT`) is supplied, `install apply` then posts
the compiled manifest to the Takosumi kernel:

```text
POST /v1/deployments
```

The kernel deploy step requires `--deploy-token` (or `TAKOSUMI_DEPLOY_TOKEN` /
`TAKOSUMI_TOKEN`). If the manifest contains `imports[]` and does not already
include `serviceResolvers[]`, apply also requires `--service-resolver-url` and
`--service-resolver-public-key` so service descriptors can be resolved and
pinned by the kernel. A kernel HTTP 4xx/5xx response makes the CLI exit
non-zero.

After the kernel response, `install apply` updates the AppInstallation ledger:

```text
PATCH /v1/installations/{installation-id}/status
```

The status is `ready` after a successful kernel response and `failed` after a
kernel HTTP 4xx/5xx response. The request includes a reason such as
`kernel deploy HTTP 200` so the Accounts event hash chain can explain the
transition.

AppBinding records created at this step intentionally carry pending `configRef`
values:

```text
takosumi-git://installable-app/<app-id>/bindings/<name>/sha256:<digest>
```

Those refs identify the approved binding declaration. Later binding resolution
and secret provisioning can replace them with provider-specific config and
secret refs without changing the original approval evidence.

## Service Imports

`serviceImports[]` is installer-facing metadata for external Takosumi services
such as `takosumi.account.auth@v1`. It is separate from AppBinding declarations:
the Binding Catalog remains the six installer-bound resource bindings, while
service imports are compiled into manifest-level `imports[]` and persisted on
the AppInstallation ledger as approved external service requests. Preview
surfaces the binding name, alias, service identifier, requested endpoint roles,
and refresh policy so approval is explicit.

When a kernel manifest is present, takosumi-git compiles the app metadata into
the manifest by merging `serviceImports[]` entries into top-level `imports[]`.
Existing manifest imports with the same alias must match the `app.yml`
declaration exactly. Conflicts fail before any Accounts or kernel request is
made.

`takosumi-git install apply`, `takosumi-git push`, and webhook dispatches from
`takosumi-git serve` also read `.takosumi/app.yml` when it exists. If service
imports are present and the manifest does not already declare
`serviceResolvers[]`, the operator must inject an anchor resolver:

```bash
takosumi-git push \
  --service-resolver-url https://anchor.example.test/v1/services \
  --service-resolver-public-key "$TAKOSUMI_SERVICE_RESOLVER_PUBLIC_KEY"
```

The same values can be supplied through `TAKOSUMI_SERVICE_RESOLVER_URL` and
`TAKOSUMI_SERVICE_RESOLVER_PUBLIC_KEY`. The kernel receives only the compiled
manifest; `.takosumi/app.yml` itself remains installer metadata.

## Commit Pins

`source.commit` in `.takosumi/app.yml` is accepted when present. When the commit
was resolved externally, pass it with `--source-commit`. If neither
`source.commit`, `--source-commit`, nor a full-SHA `source.ref` is available,
`install apply` refuses to create the AppInstallation.

This keeps the ledger explainable: the app manifest digest, compiled manifest
digest, git ref, and concrete source commit are recorded before the optional
runtime deployment step.
