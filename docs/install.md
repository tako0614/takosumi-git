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
.takosumi/manifest.yml  # authoring compute manifest, compiled before kernel deploy
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

- `previewId` and `expiresAt` for the approval record
- app identity, publisher, homepage
- source git URL, ref, optional commit, and manifest digests
- runtime modes
- requested binding kinds
- requested AppGrant capabilities
- permission digest
- risk reasons and `approvalRequired`
- cost metadata
- compatibility warnings

The AppGrant catalog includes generic installer capabilities such as
`deploy.intent.write` plus Takos resource scopes such as `files:read`,
`threads:write`, `agents:execute`, `mcp:invoke`, and `events:subscribe`.

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

`takosumi-git serve` also exposes a mutating apply API for operators that want
the same install pipeline behind HTTP:

```text
POST /v1/install/apply
Authorization: Bearer <serve-token>
```

The serve process must be started with `--accounts-url` and `--accounts-token`
(or `TAKOSUMI_ACCOUNTS_URL` / `TAKOSUMI_ACCOUNTS_TOKEN`). The request body uses
a Git source plus ledger target fields:

```json
{
  "gitUrl": "https://github.com/example/hello",
  "ref": "v1.2.3",
  "accountId": "acct_...",
  "spaceId": "space_...",
  "subject": "tsub_..."
}
```

The response kind is `takosumi-git.install-apply@v1`. The JSON response also
includes `accounts.installationId`, returned `accounts.bindings[]`, and
`accounts.runtimeBinding`. It also includes `accounts.oidcClient` when Accounts
materialized an OIDC client during create.

## Apply

Use apply after the source has a concrete commit pin:

```bash
takosumi-git install \
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

For Git URL apply, pass the source and ref. takosumi-git checks out the ref,
verifies that `.takosumi/app.yml` declares the same `source.git` and
`source.ref`, resolves the concrete commit, and records that commit in the
AppInstallation request. `install apply` remains as an explicit alias for the
same default action:

```bash
takosumi-git install apply https://github.com/example/hello --ref v1.2.3
```

```bash
takosumi-git install https://github.com/example/hello \
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
records derived from `app.yml` binding declarations, namespace export grants
resolved by Accounts / installer policy, and AppGrant records derived from
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
`TAKOSUMI_TOKEN`). The compiled manifest must already be a closed Shape
manifest; `services[]`, `imports[]`, `serviceResolvers[]`, and `${imports.*}`
are rejected before the kernel request. A kernel HTTP 4xx/5xx response makes the
CLI exit non-zero.

After the kernel response, `install apply` updates the AppInstallation ledger:

```text
PATCH /v1/installations/{installation-id}/status
```

The status is `ready` after a successful kernel response and `failed` after a
kernel HTTP 4xx/5xx response. The request includes a reason such as
`kernel deploy HTTP 200` so the Accounts event hash chain can explain the
transition.

AppBinding create requests sent by takosumi-git intentionally carry the approved
declaration and a pending `configRef` value:

```text
takosumi-git://installable-app/<app-id>/bindings/<name>/sha256:<digest>
```

Those refs identify the approved binding declaration digest, while the attached
declaration lets Takosumi Accounts hand the request to its provider
materializer. Accounts may replace them in the create response with
Accounts-owned refs such as `takosumi-accounts://.../oidc-client/<client-id>`,
`takosumi-accounts://.../launch-token/<kid>`, or provider-backed refs for
database, object-store, domain, and deploy-intent bindings without changing the
original approval evidence.

When `install apply` also deploys to a kernel endpoint, takosumi-git uses the
Accounts create response (`binding_env`, OIDC client material, and
`GET /v1/installations/{id}/launch-token` public config) to resolve explicit
`${bindings.*}`, `${secrets.*}`, and `${installation.*}` placeholders, then
inject missing default runtime environment values into compute resources before
`POST /v1/deployments`. Explicit `env:` keys in the manifest win after their
supported placeholders are resolved; only missing keys such as `OIDC_CLIENT_ID`,
`OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, `DATABASE_URL`, `BLOB_*`,
`DEPLOY_INTENT_*`, `TAKOS_INSTALLATION_ID`, and `INSTALL_LAUNCH_*` are filled.

If a required provider-backed binding (`database.postgres@v1`,
`object-store.s3-compatible@v1`, `domain.http@v1`, or `deploy-intent.gitops@v1`)
still has its pending `takosumi-git://...` ref when a kernel deploy is
requested, `install apply` fails before `POST /v1/deployments`. For bindings
with default env, the required `binding_env` keys must also be present. Required
`install-launch-token@v1` bindings likewise require an Accounts-owned
launch-token ref plus all `INSTALL_LAUNCH_*` values from the public config
endpoint before deploy.

## Namespace Exports

Operator-owned dependencies are not service imports. OIDC, billing, dashboard,
and Accounts lifecycle API access are resolved through namespace exports such as
`operator.identity.oidc`, `operator.billing.default`, `operator.dashboard.web`,
and `operator.platform.deploy`. takosumi-git may ask Takosumi Accounts to
materialize the resulting OIDC client, launch token, grant, or billing/reporting
contract, but it must not write manifest-level `imports[]` or
`serviceResolvers[]`.

The kernel receives only the compiled Shape manifest; `.takosumi/app.yml` itself
remains installer metadata.

When `install apply` also deploys to a kernel endpoint, it resolves
`resources[i].workflowRef` through the same v1 `TAKOSUMI_ARTIFACT=<uri>` stdout
marker contract as `takosumi-git push`. The compiled manifest sent to
`POST /v1/deployments` has `workflowRef` stripped, and any `spec.image` value
must be digest-pinned as `<image>@sha256:<64-hex>`.

Install workflow steps run with a cleared process environment and a small
non-secret allowlist. Operator runtime secrets such as `TAKOS_TOKEN`,
`TAKOSUMI_DEPLOY_TOKEN`, `OIDC_CLIENT_SECRET`, and `DATABASE_URL` are not
inherited by build steps. The installer uses the same build environment contract
documented in [Artifact URI Contract](./artifact-contract.md).

## Installer Placeholders

Compiled manifests must not carry installer-only placeholders.
`takosumi-git install apply` resolves Accounts-backed `${bindings.*}`,
`${secrets.*}`, and `${installation.*}` values after the Takosumi Accounts
install API creates the AppInstallation record and before kernel deploy. If
`.takosumi/manifest.yml` still contains `${params.*}`, `${installation.*}`,
`${artifacts.*}`, `${bindings.*}`, `${secrets.*}`, legacy `${refs.*}`, or
removed `${imports.*}` references after the deploy request build,
`takosumi-git install apply` fails before `POST /v1/deployments`.
`takosumi-git push` has no Accounts materialization phase, so it fails before
deploy when those installer-only placeholders are present.

## Commit Pins

`source.commit` in `.takosumi/app.yml` is accepted when present. When the commit
was resolved externally, pass it with `--source-commit`. If neither
`source.commit`, `--source-commit`, nor a full-SHA `source.ref` is available,
`install apply` refuses to create the AppInstallation.

This keeps the ledger explainable: the app manifest digest, compiled manifest
digest, git ref, and concrete source commit are recorded before the optional
runtime deployment step.

## Upgrade and Rollback

`takosumi-git upgrade` and `takosumi-git rollback` reuse the same Git URL
preview path and then post a source revision to Takosumi Accounts when `--apply`
is present:

```bash
takosumi-git upgrade inst_01J... --ref v1.2.4 --accounts-url http://127.0.0.1:8787
takosumi-git rollback inst_01J... --to v1.2.3 --accounts-url http://127.0.0.1:8787 --apply
```

Without `--apply`, both commands are non-mutating. The preview compares the
current AppInstallation source pin with the next `.takosumi/app.yml` metadata,
shows manifest digest changes, permission diff, binding diff, and a small
migration plan. With `--apply`, the CLI calls:

```text
POST /v1/installations/{installation-id}/upgrade
POST /v1/installations/{installation-id}/rollback
```

Takosumi Accounts updates the AppInstallation source pin and appends an
`installation.upgraded` or `installation.rolled_back` event to the hash chain.

## Materialize and export

`takosumi-git materialize`, `takosumi-git export`, and `takosumi-git import` are
thin clients for the Takosumi Accounts lifecycle API. Materialize/export request
the operation and return the operation tracking URL; provider workers complete
the runtime move or bundle creation asynchronously. When an export response is
already completed and includes `downloadUrl`, `takosumi-git export --output`
downloads that bundle to disk. Import reads a JSON AppInstallation export
bundle, or a `tar.zst` archive containing `takos-export/bundle.json`, and
creates the target AppInstallation through Accounts.

```bash
takosumi-git materialize inst_01J... \
  --accounts-url http://127.0.0.1:8787 \
  --region tokyo \
  --compute small \
  --database small \
  --object-store standard \
  --cost-ack

takosumi-git export inst_01J... \
  --accounts-url http://127.0.0.1:8787 \
  --include-data \
  --encryption-method age \
  --recipient age1... \
  --output ./takos-export.tar.zst

takosumi-git import ./takos-export.tar.zst \
  --to http://127.0.0.1:8787 \
  --account-id acct_self_host \
  --space-id space_self_host \
  --subject tsub_owner \
  --auth-issuer https://accounts.self-host.example
```

`--auth-issuer` は import 先 Takosumi Accounts issuer を指します。Keycloak /
Authentik / Auth0 などの upstream IdP URL を直接 app issuer として渡す option
では ありません。

The CLI posts:

```text
POST /v1/installations/{installation-id}/materialize
POST /v1/installations/{installation-id}/export
POST /v1/installations/import
```

Materialize and export send an `Idempotency-Key` header. Pass
`--idempotency-key` to reuse a known key across retries. Import accepts the same
header for future-compatible retries. Archive import reads the canonical
`takosumi.accounts.installation-export-bundle@v1` payload from
`takos-export/bundle.json` inside the `tar.zst`.
