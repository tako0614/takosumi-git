# Install Preview and Apply

> このページでわかること: `takosumi-git install` で app.yml を preview / apply
> する手順。

`takosumi-git install` は `.takosumi/app.yml` を扱う installer 系コマンドです。
app.yml は installer-bound metadata で、takosumi-git が解析してユーザーに承認
画面を表示し、Takosumi Accounts に AppInstallation 台帳レコードを作成するため
に使います。kernel には送信しません。Takosumi kernel endpoint も渡された場合
は、Accounts への ledger リクエストの後で compiled kernel manifest を別途
送信します。

## ファイル

Git URL install に対応するリポジトリは、installer metadata と kernel manifest
の両方を持ちます。

```text
.takosumi/app.yml       # InstallableApp v1 (takosumi-git が読む)
.takosumi/manifest.yml  # authoring compute manifest (kernel deploy 前に compile)
```

`app.yml` は次の指定が必須です。

```yaml
apiVersion: app.takosumi.dev/v1
kind: InstallableApp
```

未知のフィールド、`main` / `HEAD` などの mutable ref、v1 catalog にない binding
や permission 名は parser がエラーで弾きます。

## プレビュー

ledger を作成する前に preview を実行します。

```bash
takosumi-git install preview --cwd . --json
```

Git ソースから直接 preview することもできます。ref は immutable である必要が
あり、full commit SHA、semver tag、release tag、または `refs/tags/<tag>` が
使えます。

```bash
takosumi-git install preview https://github.com/example/hello --ref v1.2.3 --json
```

preview のレスポンスは `takosumi-git.install-preview@v1` で、次を含みます:

- `previewId` と `expiresAt` (approval 用)
- app identity、publisher、homepage
- source の Git URL、ref、commit、manifest digest
- runtime mode 一覧
- 要求される binding 種別
- 要求される AppGrant capability
- permission digest
- リスク理由と `approvalRequired`
- コスト情報

AppGrant catalog には `deploy.intent.write` のような installer 用 capability
に加えて、`files:read` / `threads:write` / `agents:execute` / `mcp:invoke` /
`events:subscribe` などの Takos リソーススコープが含まれます。

preview は副作用がありません。Takosumi Accounts も takosumi kernel
も呼びません。

`takosumi-git serve` を起動すると、同じ preview が HTTP API として利用できます。
body には inline `appYml` / `manifestYml` または Git ソースを指定します。

```text
POST /v1/install/preview
```

```json
{
  "gitUrl": "https://github.com/example/hello",
  "ref": "v1.2.3"
}
```

`takosumi-git serve` は同じ install pipeline を HTTP 経由で実行するための apply
API も公開しています。

```text
POST /v1/install/apply
Authorization: Bearer <serve-token>
```

serve プロセスを起動するときに `--accounts-url` と `--accounts-token` を渡す
(または `TAKOSUMI_ACCOUNTS_URL` / `TAKOSUMI_ACCOUNTS_TOKEN` を設定する) 必要が
あります。リクエスト body は Git ソース + ledger ターゲットの形です。

```json
{
  "gitUrl": "https://github.com/example/hello",
  "ref": "v1.2.3",
  "accountId": "acct_...",
  "spaceId": "space_...",
  "subject": "tsub_...",
  "previewId": "preview_...",
  "permissionDigest": "sha256:...",
  "costAck": true
}
```

レスポンス kind は `takosumi-git.install-apply@v1` で、JSON レスポンスには
`accounts.installationId`、`accounts.bindings[]`、`accounts.runtimeBinding`
が含まれます。Accounts が create 時に OIDC client を materialize した場合は
`accounts.oidcClient` も付きます。アプリが `install-launch-token@v1` binding を
required で宣言し、`--runtime-base-url` が渡され、kernel deploy が ready
になっている場合、`install apply` は install-bootstrap launch token を発行し、
アプリの `install.postInstallLaunchPath` 向けに `launch.url` を返します。
インストール後の起動でアプリの特定パス (チャットスレッド一覧など) を開きたい
場合は `--launch-return-to /spaces/<id>/threads` を渡します。

## Apply

source の commit が確定したら apply を実行します。

```bash
takosumi-git install \
  --cwd . \
  --accounts-url http://127.0.0.1:8787 \
  --account-id acct_... \
  --space-id space_... \
  --subject tsub_... \
  --source-commit 0123456789abcdef0123456789abcdef01234567 \
  --runtime-base-url https://app.example.com \
  --launch-return-to /spaces/space_.../threads \
  --mode shared-cell \
  --preview-id preview_... \
  --permission-digest sha256:... \
  --cost-ack \
  --endpoint "$TAKOSUMI_ENDPOINT" \
  --deploy-token "$TAKOSUMI_DEPLOY_TOKEN"
```

Git URL から apply するときは source と ref を渡します。takosumi-git は ref を
checkout し、`.takosumi/app.yml` の `source.git` / `source.ref` と一致することを
確認し、concrete commit を解決して AppInstallation リクエストに記録します。
`install apply` は同じ動作の明示的なエイリアスです。

```bash
takosumi-git install apply https://github.com/example/hello --ref v1.2.3
```

```bash
takosumi-git install https://github.com/example/hello \
  --ref v1.2.3 \
  --accounts-url http://127.0.0.1:8787 \
  --account-id acct_... \
  --space-id space_... \
  --subject tsub_... \
  --cost-ack
```

`install apply` は Takosumi Accounts にリクエストを送ります。

```text
POST /v1/installations
```

リクエストには次が含まれます:

- AppInstallation の source pin
- `appManifestDigest`
- `compiledManifestDigest` (`.takosumi/manifest.yml` がある場合)
- `app.yml` の binding 宣言から導出した AppBinding レコード
- Accounts / installer policy が解決した namespace export grant
- `permissions.requested` から導出した AppGrant レコード
- 承認エビデンス (`confirm.previewId` / `confirm.permissionDigest` /
  `confirm.costAck`)

preview に metered provider binding が含まれる場合、Accounts を呼ぶ前に
`--cost-ack` が必要です。`--preview-id` や `--permission-digest` を渡すと、
takosumi-git は preview を再計算し、古い承認エビデンスは拒否します。
`--runtime-base-url` (または `TAKOSUMI_RUNTIME_BASE_URL`) を渡すと、
`identity.oidc@v1` の redirect path が絶対 URI に変換され、`oidcClients[]`
として送られ、installation 単位の OIDC client が同じ ledger トランザクション内で
作られます。

`--launch-return-to` (または `TAKOSUMI_INSTALL_LAUNCH_RETURN_TO`) を渡すと、
takosumi-git は launch redirect URI に `return_to` クエリとしてそのパスを
追加します。インストールされたアプリは `/_takosumi/launch` で launch token を
consume し、セッションを作り、ブラウザ URL からトークンを除去して、そのパスへ
リダイレクトします。

`--mode` には `shared-cell` / `dedicated` / `self-hosted` が指定できます。
省略時は `.takosumi/app.yml` の `runtime.modes` の先頭値を使います。Takos
ファーストのアプリは warm-pool install のために `shared-cell`
を先頭に宣言します。

`--endpoint` (または `TAKOSUMI_ENDPOINT`) を渡すと、`install apply` は compiled
manifest を Takosumi kernel にも投下します。

```text
POST /v1/deployments
```

kernel deploy 段階には `--deploy-token` (または `TAKOSUMI_DEPLOY_TOKEN` /
`TAKOSUMI_TOKEN`) が必須です。compiled manifest は installer-only placeholder が
解決済みの closed Shape manifest でなければなりません。kernel が HTTP 4xx/5xx を
返した場合、CLI は非ゼロで終了します。

kernel のレスポンスを受け取った後、`install apply` は AppInstallation 台帳の
ステータスを更新します。

```text
PATCH /v1/installations/{installation-id}/status
```

kernel が成功した場合は `ready`、4xx/5xx を返した場合は `failed` になります。
リクエストには `kernel deploy HTTP 200` のような理由が含まれ、Accounts の event
hash chain が状態遷移を説明できるようになります。

takosumi-git が送る AppBinding create リクエストは、承認済み declaration と
pending な `configRef` を一緒に運びます。

```text
takosumi-git://installable-app/<app-id>/bindings/<name>/sha256:<digest>
```

この ref は承認済み binding declaration の digest を識別し、添付された
declaration を Takosumi Accounts が provider materializer に渡せるようにします。
Accounts は create レスポンスで
`takosumi-accounts://.../oidc-client/<client-id>`、
`takosumi-accounts://.../launch-token/<kid>`、または database / object-store /
domain / deploy-intent binding の provider-backed ref に置き換えます。承認
エビデンス自体は変わりません。

`install apply` が kernel endpoint にも deploy する場合、takosumi-git は
Accounts の create レスポンス (`binding_env`、OIDC
client、`GET
/v1/installations/{id}/launch-token` の public config) を使って
`${bindings.*}` / `${secrets.*}` / `${installation.*}` placeholder
を解決し、不足している default runtime env を compute resource に注入してから
`POST /v1/deployments` に送ります。 materialize された AppBinding ref は
Accounts-owned の config / secret record に 残り、manifest placeholder
にはなりません。manifest 内の明示的な `env:` キーが optional
解決後に優先され、`OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI`
/ `DATABASE_URL` / `BLOB_*` / `DEPLOY_INTENT_*` / `TAKOS_INSTALLATION_ID` /
`INSTALL_LAUNCH_*` のうち不足したキーだけが補完 されます。

provider-backed binding (`database.postgres@v1` /
`object-store.s3-compatible@v1` / `domain.http@v1` / `deploy-intent.gitops@v1`)
が pending な `takosumi-git://...` ref のまま kernel deploy
が要求された場合、`install apply` は `POST /v1/deployments`
の前にエラーになります。default env を持つ binding では、 必要な `binding_env`
キーもそろっている必要があります。`install-launch-token@v1` の required binding
についても、Accounts-owned な launch-token ref と public config endpoint からの
`INSTALL_LAUNCH_*` 値がデプロイ前にそろっている必要が あります。

## Namespace Exports

operator-owned な依存関係は service import としては扱われません。OIDC、課金、
dashboard、Accounts lifecycle API へのアクセスは namespace export
(`operator.identity.oidc` / `operator.billing.default` /
`operator.dashboard.web` / `operator.platform.deploy`) で解決します。
takosumi-git は Takosumi Accounts に対して、対応する OIDC client / launch token
/ grant / billing 契約の materialize を依頼します。kernel manifest は Shape
だけを扱います。

kernel が受け取るのは compiled Shape manifest だけで、`.takosumi/app.yml` は
installer metadata のまま残ります。

`install apply` が kernel endpoint にも deploy
する場合、`resources[i].workflowRef` は `takosumi-git push` と同じ
`TAKOSUMI_ARTIFACT=<uri>` stdout marker contract
で解決されます。`POST /v1/deployments` に送られる compiled manifest からは
`workflowRef` が strip され、すべての `spec.image` は `<image>@sha256:<64-hex>`
の digest 形式に pin されます。

install 用 workflow ステップはプロセス環境変数を clear し、機密でない小さな
allowlist だけを残して実行されます。`TAKOS_TOKEN` / `TAKOSUMI_DEPLOY_TOKEN` /
`OIDC_CLIENT_SECRET` / `DATABASE_URL` のような operator runtime secret は build
step に継承されません。installer の build 環境は
[Artifact URI Contract](./artifact-contract.md) の規約に従います。
`workflowRef.file` は `.takosumi/workflows` 内の相対パスでなければならず、
絶対パス・`../` での escape・symlink escape は workflow 実行前に拒否されます。

## Installer placeholders

compiled manifest に installer-only placeholder を残してはいけません。

`takosumi-git install apply` は Takosumi Accounts の install API が
AppInstallation を作った後、kernel deploy の前に Accounts-backed な
`${bindings.*}` / `${secrets.*}` / `${installation.*}` を解決します。deploy
request build 後も `${params.*}` / `${installation.*}` / `${artifacts.*}` /
`${bindings.*}` / `${secrets.*}` や installer-only placeholder
が残っている場合、 `takosumi-git install apply` は `POST /v1/deployments`
の前にエラーになります。 `takosumi-git push` は Accounts materialization
のフェーズを持たないため、 installer-only placeholder が残っていれば deploy
の前にエラーになります。

## Commit Pin

`.takosumi/app.yml` に `source.commit` があればそれを使います。外部で commit を
解決済みの場合は `--source-commit` で渡します。`source.commit` /
`--source-commit` / full SHA な `source.ref`
のいずれも与えられない場合、`install apply` は AppInstallation
の作成を拒否します。

これにより、app manifest digest / compiled manifest digest / git ref / concrete
commit が runtime deploy の前に必ず記録され、台帳から「何を install したか」を
後から説明できるようになります。

## Upgrade / Rollback

`takosumi-git upgrade` と `takosumi-git rollback` は同じ Git URL preview の
パスを再利用し、`--apply` を指定したときに Takosumi Accounts に source revision
を送ります。

```bash
takosumi-git upgrade inst_01J... --ref v1.2.4 --accounts-url http://127.0.0.1:8787
takosumi-git rollback inst_01J... --to v1.2.3 --accounts-url http://127.0.0.1:8787 --apply
```

`--apply` を指定しない場合、どちらも副作用なしで動作します。preview は現在の
AppInstallation source pin と次の `.takosumi/app.yml` を比較し、manifest digest
の変化、permission diff、binding diff、data-change review
を表示します。`--apply` を指定すると、CLI は次のエンドポイントを呼びます。

```text
POST /v1/installations/{installation-id}/upgrade
POST /v1/installations/{installation-id}/rollback
```

Takosumi Accounts は AppInstallation の source pin を更新し、
`installation.upgraded` または `installation.rolled_back` イベントを hash chain
に追加します。

`takosumi-git serve` を起動すると、同じ revision フローを product UI や operator
ツール向けに HTTP で公開できます。

```text
POST /v1/install/revision/preview
POST /v1/install/revision/apply
Authorization: Bearer <serve-token>
```

リクエスト body は upgrade で `"operation": "upgrade"` と `"ref": "v1.2.4"`、
rollback で `"operation": "rollback"` と `"to": "v1.2.3"` を渡します。レスポンス
kind は `takosumi-git.install-revision-preview@v1` /
`takosumi-git.install-revision-apply@v1` です。

## Materialize / export / import

`takosumi-git materialize` / `export` / `import` は Takosumi Accounts の
lifecycle API に対する thin client です。materialize と export
はオペレーションを 要求し、tracking URL を返します。runtime の移動や bundle
生成は provider worker が非同期に完了させます。export がまだ完了していないとき
`takosumi-git export
--output` は `downloadUrl` が返るまで operation endpoint を
polling し、bundle をディスクに保存します。import は JSON 形式の AppInstallation
export bundle、 `takos-export/bundle.json` を含む `tar.zst` アーカイブ、または
`--identity` を 渡したときは age で wrap した `tar.zst.age`
アーカイブを読み、Accounts 経由で target AppInstallation を作成します。data
entry は既定で metadata のみで、 `--restore-data` は target Accounts に import
data restorer が構成されている ときだけ指定します。

```bash
takosumi-git materialize inst_01J... \
  --accounts-url http://127.0.0.1:8787 \
  --mode dedicated \
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
  --output ./takos-export.tar.zst.age

takosumi-git import ./takos-export.tar.zst.age \
  --to http://127.0.0.1:8787 \
  --account-id acct_self_host \
  --space-id space_self_host \
  --subject tsub_owner \
  --auth-issuer https://accounts.self-host.example \
  --identity ./age-identity.txt \
  --restore-data
```

`--auth-issuer` は import 先 Takosumi Accounts issuer を指します。Keycloak /
Authentik / Auth0 などの upstream IdP URL を直接 app issuer として渡す option
では ありません。

CLI が送るエンドポイント:

```text
POST /v1/installations/{installation-id}/materialize
POST /v1/installations/{installation-id}/export
POST /v1/installations/import
```

materialize と export は `Idempotency-Key` ヘッダを送ります。retry で同じキーを
使い回すときは `--idempotency-key` で指定します。import も将来の retry のために
同じヘッダを受け付けます。archive import は `tar.zst` 内の
`takos-export/bundle.json` から
`takosumi.accounts.installation-export-bundle@v1` payload を読みます。
`.tar.zst.age` は `age -d -i <identity>` で復号した上で同じ archive を読みます。

## Implementation drift anchors

```text
digest-pinned as `<image>@sha256:<64-hex>`
cleared process environment
relative path inside `.takosumi/workflows`
A kernel HTTP 4xx/5xx response makes
non-zero
Preview is non-mutating
Compiled manifests must not carry installer-only placeholders
parseInstallableAppYaml
buildInstallPreview
applyInstall
appBindingCreateRequests
compileInstallManifest
compileInstallWorkflowRefs
resolveWorkflowFilePath
assertNoInstallerPlaceholders
unresolved installer placeholder
checkoutGitSource
sourceGitUrl
source.commit is required for install apply
patchInstallationStatus
sourceCommit
```
