# Binding Catalog

> このページでわかること: AppBinding の型一覧と placeholder 解決順序の仕様。

::: tip 関連ページ installer-only placeholder の解決順は本ページの §8
が正本です。
[manifest-spec § 13](../../../takosumi/docs/reference/manifest-spec.md#compile-time-placeholders)
からも本 §8 を参照します。 :::

`.takosumi/app.yml` の `bindings:` 節で宣言できる binding type の catalog です。
Installable App Model では binding は app が要求する resource 抽象型を 6 種に
固定し、provision / inject / rotate / revoke / destroy の lifecycle を operator
distribution / Takosumi Accounts / takosumi-git の側が担います。 operator /
account plane への依存は AppBinding ではなく namespace export と account API /
BillingPort で表現します。

binding catalog は compiled Shape manifest に到達する前の installer / Accounts
materialization contract です。Takosumi kernel の universal resource model
ではありません。binding kind を増やすときは、本 catalog と preview /
materializer / acceptance gate を lockstep で更新します。

binding materialization は install lifecycle の一部です。kernel deploy
(`POST /v1/deployments`) は compile 済み Shape manifest だけを受け取り、
AppBinding / AppGrant / namespace export grant の ownership は持ちません。

本ページは次の範囲を定義します:

- `.takosumi/app.yml` の `bindings.*.type` で使える 6 種の identifier
- 各 binding が `.takosumi/manifest.yml` の compile 前に提供する
  `${bindings.<name>.*}` / `${secrets.<name>.*}` placeholder
- compiled manifest に実値として注入される env vars
- placeholder 解決順序: `${params.*}` → `${installation.*}` → `${artifacts.*}` →
  `${bindings.*}` → `${secrets.*}` → `${env.*}` → kernel-resolved references
  (`${ref:...}` / `${secret-ref:...}`)

`takosumi-git` compiler は `${params.*}` / `${installation.*}` /
`${artifacts.*}` / `${bindings.*}` / `${secrets.*}` が compile 後に残っていれば
Accounts / kernel request 前にエラーにします。

provider plugin (例: `@takos/managed-postgres`) の内部実装、kernel が扱う
resource shape、Takosumi Accounts の issuer 実装はこの catalog の範囲外です。
issuer 側の詳細は
[Takosumi Accounts](../../../takosumi-cloud/docs/architecture/takosumi-accounts.md)
を参照してください。

## 0. Catalog 一覧

| # | type identifier                 | domain             | 主担当                                  | required env (default)                                                                                                                                                                                    |
| - | ------------------------------- | ------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | `identity.oidc@v1`              | identity           | Takosumi Accounts (OIDC issuer)         | `OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI`                                                                                                                         |
| 2 | `database.postgres@v1`          | data plane         | operator managed-postgres provider      | `DATABASE_URL`                                                                                                                                                                                            |
| 3 | `object-store.s3-compatible@v1` | data plane         | operator managed-object-store provider  | `BLOB_ENDPOINT` / `BLOB_BUCKET` / `BLOB_ACCESS_KEY` / `BLOB_SECRET_KEY`                                                                                                                                   |
| 4 | `domain.http@v1`                | network            | operator domain manager + DNS           | (env 注入なし。`${bindings.<name>.url}` を manifest 側で参照)                                                                                                                                             |
| 5 | `deploy-intent.gitops@v1`       | deploy bridge      | takosumi-git deploy intent repo         | `DEPLOY_INTENT_DRIVER` / `DEPLOY_INTENT_REMOTE` / `DEPLOY_INTENT_TOKEN`                                                                                                                                   |
| 6 | `install-launch-token@v1`       | identity bootstrap | Takosumi Accounts (launch token issuer) | `ACCOUNTS_BASE_URL` / `INSTALL_LAUNCH_INSTALLATION_ID` / `INSTALL_LAUNCH_CONSUME_PATH` (app derives redirect URI locally from `${ACCOUNTS_BASE_URL}` + `${INSTALL_LAUNCH_CONSUME_PATH}` and its own host) |

binding type identifier の文法:

```
<domain>.<kind>@v<major>
```

- `<domain>` / `<kind>` は lowercase kebab-case (`identity`, `database`,
  `object-store`, `domain`, `deploy-intent`, `install-launch-token`)
- `@v<major>` は単一 integer。breaking change のみ bump

catalog にない type を `bindings.*.type` に書くと
[install preview](../../../takosumi-cloud/docs/accounts-service.md#post-v1install-preview)
が `422 manifest-compile-failed` を返します。

## 1. `identity.oidc@v1`

AppInstallation 単位で OIDC client を Takosumi Accounts に登録し、Takos が
[OIDC consumer](../../../takos/docs/apps/oidc-consumer.md) として login
を実装するための binding。

### 1.1 Request fields (`.takosumi/app.yml`)

| field                     | required | type            | 説明                                                                            |
| ------------------------- | -------- | --------------- | ------------------------------------------------------------------------------- |
| `type`                    | yes      | const           | `"identity.oidc@v1"`                                                            |
| `required`                | no       | boolean         | default `true`                                                                  |
| `redirectPaths`           | yes      | string[] (path) | AppInstallation の base URL に append される。例: `/auth/oidc/callback`         |
| `allowedScopes`           | no       | string[]        | default `["openid", "email", "profile"]`                                        |
| `subjectMode`             | no       | const           | `"pairwise"` 固定 (public は採用しない)                                         |
| `tokenEndpointAuthMethod` | no       | enum            | `client_secret_post` (default) / `client_secret_basic` / `none` (public client) |

### 1.2 Provisioned config

provider が `provision` 後に AppBinding として永続化する fields:

| field                     | 説明                                                                        |
| ------------------------- | --------------------------------------------------------------------------- |
| `issuerUrl`               | operator-selected issuer URL from `operator.identity.oidc` / OIDC discovery |
| `clientId`                | installation 単位で発行された OIDC client id (例: `takos_inst_abc`)         |
| `redirectUris`            | 解決済み absolute URI 配列                                                  |
| `allowedScopes`           | request の `allowedScopes` を継承                                           |
| `subjectMode`             | `"pairwise"` 固定                                                           |
| `tokenEndpointAuthMethod` | 認証 method 名                                                              |

secret は Vault path として `clientSecretRef` のみ持ち、生 secret は compile
時に解決される。

### 1.3 Output placeholders

| placeholder                      | 値                                                           |
| -------------------------------- | ------------------------------------------------------------ |
| `${bindings.<name>.issuerUrl}`   | `config.issuerUrl`                                           |
| `${bindings.<name>.clientId}`    | `config.clientId`                                            |
| `${bindings.<name>.redirectUri}` | `config.redirectUris[0]` (multi 時 `redirectUris[i]` 参照可) |
| `${secrets.<name>.clientSecret}` | Vault から解決された生 secret                                |

### 1.4 Default env injection

manifest 中で `env:` を明示しなかった場合に注入される:

```env
OIDC_ISSUER_URL    = ${bindings.<name>.issuerUrl}
OIDC_CLIENT_ID     = ${bindings.<name>.clientId}
OIDC_REDIRECT_URI  = ${bindings.<name>.redirectUri}
OIDC_CLIENT_SECRET = ${secrets.<name>.clientSecret}
```

`AUTH_DRIVER=oidc` は app 側 contract として manifest で別途設定する。

### 1.5 例

```yaml
bindings:
  auth:
    type: identity.oidc@v1
    required: true
    redirectPaths:
      - /auth/oidc/callback
    allowedScopes: [openid, email, profile]
    subjectMode: pairwise
```

## 2. `database.postgres@v1`

managed PostgreSQL database を AppInstallation 専用に provision する binding。

### 2.1 Request fields

| field                 | required | type     | 説明                                                                                |
| --------------------- | -------- | -------- | ----------------------------------------------------------------------------------- |
| `type`                | yes      | const    | `"database.postgres@v1"`                                                            |
| `required`            | no       | boolean  | default `true`                                                                      |
| `plan`                | yes      | enum     | `nano` / `small` / `medium` / `large` / `xlarge`                                    |
| `region`              | no       | string   | 省略時 AppInstallation の region 継承                                               |
| `version`             | no       | enum     | `"15"` / `"16"` (default) / `"17"`                                                  |
| `extensions`          | no       | string[] | whitelist: `pgvector` / `pgcrypto` / `uuid-ossp` / `pg_stat_statements` / `pg_trgm` |
| `highAvailability`    | no       | boolean  | default `false`                                                                     |
| `backupRetentionDays` | no       | int      | 1..35, default `7`                                                                  |

`extensions` は **whitelist のみ**。任意 extension は受け付けない。

### 2.2 Provisioned config

`plan` / `region` / `version` / `host` / `port` (default `5432`) / `database` /
`username` / `extensions` / `sslMode` (`require` / `verify-full`、 default
`require`) / `highAvailability` を持つ。secret は `passwordRef` (Vault path)。

### 2.3 Output placeholders

| placeholder                   | 値                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `${bindings.<name>.host}`     | `config.host`                                                                |
| `${bindings.<name>.port}`     | `config.port`                                                                |
| `${bindings.<name>.database}` | `config.database`                                                            |
| `${bindings.<name>.username}` | `config.username`                                                            |
| `${bindings.<name>.sslMode}`  | `config.sslMode`                                                             |
| `${bindings.<name>.url}`      | derived: `postgres://<user>:<password>@<host>:<port>/<db>?sslmode=<sslMode>` |
| `${secrets.<name>.password}`  | Vault から解決された生 password                                              |

### 2.4 Default env injection

```env
DATABASE_URL = ${bindings.<name>.url}
```

### 2.5 例

```yaml
bindings:
  db:
    type: database.postgres@v1
    plan: small
    region: ap-tokyo-1
    version: "16"
    extensions: [pgvector]
    backupRetentionDays: 14
```

## 3. `object-store.s3-compatible@v1`

S3-compatible object storage の bucket を AppInstallation に provision する
binding。MinIO / S3 / R2 などを provider plugin で吸収する。

### 3.1 Request fields

| field           | required | type    | 説明                                                                      |
| --------------- | -------- | ------- | ------------------------------------------------------------------------- |
| `type`          | yes      | const   | `"object-store.s3-compatible@v1"`                                         |
| `required`      | no       | boolean | default `true`                                                            |
| `plan`          | yes      | enum    | `standard` / `infrequent-access` / `archive`                              |
| `region`        | no       | string  | AppInstallation 継承可                                                    |
| `encryption`    | no       | object  | `{ mode: "sse-s3" \| "sse-kms", kmsKeyRef?: vault-uri }` (default sse-s3) |
| `versioning`    | no       | boolean | default `true`                                                            |
| `lifecycleDays` | no       | int     | 0 = 無効 (default)                                                        |

`encryption.mode == "sse-kms"` のときのみ `kmsKeyRef` 必須。

### 3.2 Provisioned config

`plan` / `region` / `endpoint` (S3 API URL) / `bucket` (3..63 chars) /
`accessKeyId` / `encryption` / `versioning` を持つ。secret は
`secretAccessKeyRef` (Vault path)。

### 3.3 Output placeholders

| placeholder                    | 値                                     |
| ------------------------------ | -------------------------------------- |
| `${bindings.<name>.endpoint}`  | `config.endpoint`                      |
| `${bindings.<name>.bucket}`    | `config.bucket`                        |
| `${bindings.<name>.accessKey}` | `config.accessKeyId`                   |
| `${bindings.<name>.region}`    | `config.region`                        |
| `${secrets.<name>.secretKey}`  | Vault から解決された secret access key |

### 3.4 Default env injection

```env
BLOB_ENDPOINT   = ${bindings.<name>.endpoint}
BLOB_BUCKET     = ${bindings.<name>.bucket}
BLOB_ACCESS_KEY = ${bindings.<name>.accessKey}
BLOB_SECRET_KEY = ${secrets.<name>.secretKey}
```

### 3.5 例

```yaml
bindings:
  blob:
    type: object-store.s3-compatible@v1
    plan: standard
    region: ap-tokyo-1
    encryption:
      mode: sse-s3
    versioning: true
```

## 4. `domain.http@v1`

AppInstallation に **HTTP/HTTPS で reachable な hostname** を provision する
binding。auto subdomain (`<inst-slug>.takosumi.app`) と custom hostname の
両方をサポートする。

### 4.1 Request fields

| field                 | required | type        | 説明                                             |
| --------------------- | -------- | ----------- | ------------------------------------------------ |
| `type`                | yes      | const       | `"domain.http@v1"`                               |
| `required`            | no       | boolean     | default `true`                                   |
| `hostname`            | yes      | enum/object | `"auto"` または `{ custom: "chat.example.com" }` |
| `tlsMode`             | no       | enum        | `auto` (default) / `managed` / `byo`             |
| `tlsCertRef`          | cond     | vault-uri   | `tlsMode=byo` のとき必須                         |
| `redirectHttpToHttps` | no       | boolean     | default `true`                                   |

### 4.2 Provisioned config

`hostname` / `url` (= `https://<hostname>`) / `tlsMode` / `tlsCertFingerprint`
(SHA-256 of leaf cert) / `isCustom` / `verificationStatus` (`pending` /
`verified` / `failed`) を持つ。

### 4.3 Output placeholders

| placeholder                   | 値                |
| ----------------------------- | ----------------- |
| `${bindings.<name>.hostname}` | `config.hostname` |
| `${bindings.<name>.url}`      | `config.url`      |

### 4.4 Default env injection

domain binding は **env を default 注入しない**。app は manifest 中で明示する:

```yaml
env:
  BASE_URL: "${bindings.domain.url}"
```

### 4.5 例

```yaml
# auto subdomain
bindings:
  domain:
    type: domain.http@v1
    hostname: auto
    tlsMode: auto
```

```yaml
# custom hostname
bindings:
  domain:
    type: domain.http@v1
    hostname:
      custom: chat.example.com
    tlsMode: managed
```

[materialize](../../../takos/docs/platform/upgrade-export.md#materialize) の
target contract は **hostname を変えない** ことです (routing target だけ
shared-cell から dedicated に切り替える)。public managed offering での live
cutover / rollback continuity proof は ROADMAP §3.5 の operator evidence
で扱います。

## 5. `deploy-intent.gitops@v1`

Takos が deploy 操作を行いたいときに、**takosumi kernel API を直接叩かず、 Git
repo に deploy intent JSON を commit する** ための binding。 takosumi-git
watcher が repo を watch し、 `deployments/*.json` の最新
`takos.deploy-intent@v1` document を kernel apply に変換する。 deploy intent
document が無い repo では、従来どおり `.takosumi/manifest.yml` を workflow 実行
→ kernel apply へ変換する。

### 5.1 Request fields

| field             | required | type      | 説明                                                                           |
| ----------------- | -------- | --------- | ------------------------------------------------------------------------------ |
| `type`            | yes      | const     | `"deploy-intent.gitops@v1"`                                                    |
| `required`        | no       | boolean   | default `false`                                                                |
| `branch`          | no       | string    | default `main`                                                                 |
| `remoteUrl`       | no       | uri       | 省略時 takosumi-git が自動 provision                                           |
| `tokenRef`        | no       | vault-uri | 省略時 自動発行                                                                |
| `writePathPrefix` | no       | string    | default `deployments/`。app が deploy intent JSON を書ける repo 内 path prefix |

### 5.2 Provisioned config

`driver: "gitops"` 固定 / `remoteUrl` / `branch` / `writePathPrefix` /
`watcherInstallationId` (watcher が動く installation id) を持つ。secret は
`tokenRef`。

token は `writePathPrefix` 配下にのみ push 可能な scoped Git token。

### 5.3 Output placeholders

| placeholder                          | 値                            |
| ------------------------------------ | ----------------------------- |
| `${bindings.<name>.driver}`          | `"gitops"` 固定               |
| `${bindings.<name>.remote}`          | `config.remoteUrl`            |
| `${bindings.<name>.branch}`          | `config.branch`               |
| `${bindings.<name>.writePathPrefix}` | `config.writePathPrefix`      |
| `${secrets.<name>.token}`            | Vault 解決された scoped token |

### 5.4 Default env injection

```env
DEPLOY_INTENT_DRIVER = gitops
DEPLOY_INTENT_REMOTE = ${bindings.<name>.remote}
DEPLOY_INTENT_TOKEN  = ${secrets.<name>.token}
```

`branch` / `writePathPrefix` を app が必要とする場合は manifest 中で明示する。

### 5.5 例

```yaml
bindings:
  deploy:
    type: deploy-intent.gitops@v1
    required: false
    branch: main
    writePathPrefix: deployments/
```

`writePathPrefix` 配下の deploy intent document は次の JSON shape を持つ:

```json
{
  "kind": "takos.deploy-intent@v1",
  "id": "deploy-01HR...",
  "mode": "apply",
  "metadata": {
    "spaceId": "space_1",
    "group": "docs",
    "budgetGuard": {
      "approved": true,
      "approvalId": "approval_01HR..."
    }
  },
  "manifest": {
    "apiVersion": "1.0",
    "kind": "Manifest",
    "resources": []
  }
}
```

`mode` は `apply` / `plan` / `destroy` のいずれかで、省略時は
`apply`。`manifest` は takosumi kernel `POST /v1/deployments` に渡せる compile
済み Manifest envelope で、kernel-resolved reference 以外の installer-only
placeholder を含めない。GPU / accelerator 指定、または `instances` / `replicas`
/ `replicaCount` が 10 を超える resource を含む場合、 watcher は
`metadata.budgetGuard.approved: true` が無い deploy intent を kernel
に送らない。

セキュリティ要件:

- token は `writePathPrefix` 配下にのみ push 可能 (server-side path-based ACL)
- deploy intent は budget guard を必ず通過し、高額 resource は approval 前に
  kernel apply されない
- workflow が触れる kernel resource は AppInstallation の grant
  `deploy.intent.write` に制限

## 6. `install-launch-token@v1`

install 完了直後の自動 sign-in 用
[opaque launch token](../../../takosumi-cloud/docs/apps/launch-token.md) を
**redeem する側 (= app)** に必要な Accounts endpoint と redirect URI を提供する
binding。

実 token 発行は Takosumi Accounts (`POST /v1/installations/{id}/launch-token`、
[Install API](../../../takosumi-cloud/docs/accounts-service.md#launch-token))
が担い、 本 binding は **app が redeem に 必要な context (Accounts base URL /
installationId / redirect URI / consume path) の注入のみ** を担当する。redirect
URI は installer が runtime base URL と consume path から算出し、token
発行時にも同じ値を Accounts に渡す。

token は opaque random (32-byte) で、 app は JWS verify をしない。 app は
Accounts の `/consume` endpoint を TLS で 呼んで redeem する (OAuth 2.0
authorization code grant 相当)。

### 6.1 Request fields

| field                | required | type    | 説明                                   |
| -------------------- | -------- | ------- | -------------------------------------- |
| `type`               | yes      | const   | `"install-launch-token@v1"`            |
| `required`           | no       | boolean | default `true`                         |
| `consumePath`        | no       | path    | default `/_takosumi/launch`            |
| `maxLifetimeSeconds` | no       | int     | 30..300 (hard cap 5 分), default `300` |

### 6.2 Provisioned config

| field                | 説明                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| `accountsBaseUrl`    | target Takosumi Accounts の base URL (`/consume` endpoint の prefix) |
| `installationId`     | この AppInstallation の id (consume path に embed)                   |
| `consumePath`        | request の `consumePath` を継承 (default `/_takosumi/launch`)        |
| `maxLifetimeSeconds` | 上限 lifetime                                                        |

secret schema は **空** (公開鍵 / 署名鍵は使わない、 opaque token model)。

注: redirect URI は binding が保持しません。 Accounts は token issue request
(`POST /v1/installations/{id}/launch-token`) の `redirect_uri` field を
**per-call** で受け取り、 issued token に bind します。 takosumi-git installer
は自身が知っている app の runtime base URL と `${INSTALL_LAUNCH_CONSUME_PATH}`
から redirect URI を組み立てて issue request に渡し、 app 側も同じ redirect URI
を consume request に送ります。

Takosumi Accounts は `POST /v1/installations` 時にこの binding の発行設定を
ledger に記録し、install 完了タイミングで opaque token を発行して redirect URL
に carry します。

### 6.3 Output placeholders

| placeholder                          | 値                              |
| ------------------------------------ | ------------------------------- |
| `${bindings.<name>.accountsBaseUrl}` | Accounts base URL               |
| `${bindings.<name>.installationId}`  | AppInstallation id (`inst_xxx`) |
| `${bindings.<name>.consumePath}`     | consume endpoint path           |

redirect URI は binding output に含まれません。 app は実行時に自身の host
(`${bindings.domain.url}` 等) と `${bindings.<name>.consumePath}`
から組み立てます。

### 6.4 Default env injection

```env
ACCOUNTS_BASE_URL              = ${bindings.<name>.accountsBaseUrl}
INSTALL_LAUNCH_INSTALLATION_ID = ${bindings.<name>.installationId}
INSTALL_LAUNCH_CONSUME_PATH    = ${bindings.<name>.consumePath}
```

`INSTALL_LAUNCH_REDIRECT_URI` は binding が注入しません。 app は handler
内で自身の host (または `${bindings.domain.url}` から派生した `BASE_URL`) と
`INSTALL_LAUNCH_CONSUME_PATH` から redirect URI を 組み立て、 consume request
に同値を渡します。 installer 側 (takosumi-git) は issue request
に同じ計算結果を渡します。

app は handler で
`POST ${ACCOUNTS_BASE_URL}/v1/installations/${INSTALL_LAUNCH_INSTALLATION_ID}/launch-token/consume`
を 叩いて redeem する。 詳細は
[launch-token.md § 6](../../../takosumi-cloud/docs/apps/launch-token.md#6-app-側の実装-consume_path-handler)。

### 6.5 例

```yaml
bindings:
  bootstrap:
    type: install-launch-token@v1
    required: true
    consumePath: /_takosumi/launch
    maxLifetimeSeconds: 300
```

## 7. Namespace exports are not AppBinding kinds

Operator / account plane dependency は AppBinding catalog には含めません。 OIDC
は `operator.identity.oidc`、billing は `operator.billing.default` のような
namespace export を Accounts / installer layer が grant し、compiled manifest
には unresolved `${bindings.*}` / `${imports.*}` を残しません。

詳細は
[Namespace Export Model](../../../takosumi/docs/reference/architecture/namespace-export-model.md)
および
[Namespace Exports](../../../takosumi/docs/reference/namespace-exports.md)
を参照。

## 8. Placeholder 解決順序

installer / account-plane materializer が kernel deploy request の前に解決する
placeholder の優先順位:

1. `${params.*}` — install API の `params` 引数
2. `${installation.*}` — `id` / `accountId` / `spaceId` / `baseUrl`
3. `${artifacts.*}` — workflow run の output (image digest 等)
4. `${bindings.<name>.*}` — 本 catalog の Output placeholders
5. `${secrets.<name>.*}` — Vault 解決
6. `${env.*}` — operator-owned manifest generation input。kernel resolver
   ではない
7. kernel-resolved references — `${ref:...}` / `${secret-ref:...}` は kernel が
   apply 時に解決

kernel-resolved references は compiled manifest にそのまま残ります。それ以外 の
placeholder (1〜6) は **kernel deploy payload に残らない** ことが
不変条件です。`takosumi-git install apply` は AppInstallation の materialization
result で `${bindings.*}` / `${secrets.*}` / `${installation.*}` を解決し、
解決後も installer-only placeholder が残る場合は kernel request 前に失敗します。
`${env.*}` は kernel resolver ではないため、使うときは operator-owned manifest
generation で concrete value にしてください。

### 8.1 名前衝突の禁止

同一 `.takosumi/app.yml` 内で同じ binding name (`bindings.<name>`) を 2 回
宣言することは禁止。schema validation で検出する。

### 8.2 default env injection の override

各 binding の Default env injection は、manifest 中の compute resource が `env:`
を **明示しなかった** key にのみ適用される。明示時はそのまま採用 (supported
placeholder は deploy request build 時に解決)。Accounts provider materializer
が返す one-shot `binding_env` は takosumi-git が kernel deploy request
を送る直前に適用し、 AppInstallation ledger には raw secret value ではなく
`configRef` / `secretRefs` だけを保存する。

### 8.3 required vs optional

`request.required: false` の binding が provision されなかった場合、 authoring
manifest 中の `${bindings.<name>.*}` / `${secrets.<name>.*}` / default env
injection はすべて **空文字列に解決されず deploy request build error** とする。

required false binding を runtime で扱いたい app は、`.takosumi/app.yml` 側で
env を分岐定義するか、別 manifest variant を持つ。

## 9. 参照される manifest snippet

[`.takosumi/app.yml`](app-yml-spec.md) の `bindings:` 節と reserved placeholder
vocabulary は次のように対応する。下の manifest snippet は
`takosumi-git install apply` が Accounts materialization 後、 kernel deploy
request を組み立てる時点で解決する入力 contract を示す。

```yaml
# .takosumi/app.yml (installer-bound)
bindings:
  auth:
    type: identity.oidc@v1
    required: true
    redirectPaths:
      - /auth/oidc/callback
  db:
    type: database.postgres@v1
    plan: small
  blob:
    type: object-store.s3-compatible@v1
    plan: standard
  domain:
    type: domain.http@v1
    hostname: auto
  bootstrap:
    type: install-launch-token@v1
    required: true
```

```yaml
# .takosumi/manifest.yml (authoring, takosumi-git が compile)
apiVersion: "1.0"
kind: Manifest
resources:
  - shape: web-service@v1
    name: api
    spec:
      image: "${artifacts.api.image}"
      env:
        AUTH_DRIVER: "oidc"
        OIDC_ISSUER_URL: "${bindings.auth.issuerUrl}"
        OIDC_CLIENT_ID: "${bindings.auth.clientId}"
        OIDC_CLIENT_SECRET: "${secrets.auth.clientSecret}"
        OIDC_REDIRECT_URI: "${bindings.auth.redirectUri}"
        DATABASE_URL: "${bindings.db.url}"
        BLOB_ENDPOINT: "${bindings.blob.endpoint}"
        BLOB_BUCKET: "${bindings.blob.bucket}"
        BLOB_ACCESS_KEY: "${bindings.blob.accessKey}"
        BLOB_SECRET_KEY: "${secrets.blob.secretKey}"
        BASE_URL: "${bindings.domain.url}"
        TAKOS_INSTALLATION_ID: "${installation.id}"
        ACCOUNTS_BASE_URL: "${bindings.bootstrap.accountsBaseUrl}"
        INSTALL_LAUNCH_INSTALLATION_ID: "${bindings.bootstrap.installationId}"
        INSTALL_LAUNCH_CONSUME_PATH: "${bindings.bootstrap.consumePath}"
```

## References

- [`.takosumi/app.yml` Spec](app-yml-spec.md) — binding declaration の parent
  schema
- [Install API](../../../takosumi-cloud/docs/accounts-service.md) —
  `POST /v1/installations` body の `bindings` field と本 catalog の対応
- [Installer Pipeline](../architecture/installer-pipeline.md) — binding 解決と
  manifest compile の詳細フロー
- [Takosumi Accounts](../../../takosumi-cloud/docs/architecture/takosumi-accounts.md)
  — `identity.oidc@v1` / `install-launch-token@v1` の issuer 側 contract
- [OIDC Consumer](../../../takos/docs/apps/oidc-consumer.md) — Takos 側で OIDC
  binding を消費する 実装
- [Glossary](../../../docs/reference/glossary.md) — Installable App Model
  用語の正本
