# Install Preview and Apply

`takosumi-git install` is the installer-facing command family for
`.takosumi/app.yml`. The app file is installer-bound metadata: it is parsed by
takosumi-git, shown to the user before approval, and used to create an
AppInstallation ledger record in Takosumi Accounts. It is never posted to the
takosumi kernel.

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

The preview response is `takosumi-git.install-preview@v1` and includes:

- app identity, publisher, homepage
- source git URL, ref, optional commit, and manifest digests
- runtime modes
- requested binding kinds
- requested AppGrant capabilities
- permission digest
- compatibility warnings

Preview is non-mutating. It does not call Takosumi Accounts and does not call
the takosumi kernel.

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
  --mode shared-cell
```

`install apply` posts to Takosumi Accounts:

```text
POST /v1/installations
```

The request carries the AppInstallation source pin, `appManifestDigest`,
`compiledManifestDigest` when `.takosumi/manifest.yml` is present, AppBinding
records derived from `app.yml` binding declarations, and AppGrant records
derived from `permissions.requested`.

AppBinding records created at this step intentionally carry pending `configRef`
values:

```text
takosumi-git://installable-app/<app-id>/bindings/<name>/sha256:<digest>
```

Those refs identify the approved binding declaration. Later binding resolution
and secret provisioning can replace them with provider-specific config and
secret refs without changing the original approval evidence.

## Commit Pins

`source.commit` in `.takosumi/app.yml` is accepted when present. When the commit
was resolved externally, pass it with `--source-commit`. If neither
`source.commit`, `--source-commit`, nor a full-SHA `source.ref` is available,
`install apply` refuses to create the AppInstallation.

This keeps the ledger explainable: the app manifest digest, compiled manifest
digest, git ref, and concrete source commit are recorded together before any
runtime deployment step.
