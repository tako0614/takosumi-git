# Binding Catalog

> **Canonical authority**: 本ページの **§8 Placeholder 解決順序** が
> installer-only placeholder contract の正本です。
> [reference/manifest-spec § 13](../../../takosumi/docs/reference/manifest-spec.md#compile-time-placeholders)
> は本 §8 への cross-ref であり、order
> を変更する場合は本ページを先に更新します。

`.takosumi/app.yml` の `bindings:` 節で宣言できる **binding type の正本
catalog** です。Installable App Model では binding は app が要求する **resource
抽象型** を 6 種に固定し、provision / inject / rotate / revoke / destroy の
lifecycle を Takosumi Cloud / Takosumi Accounts / takosumi-git の側が
担います。Operator / account plane dependency は AppBinding ではなく namespace
export と account API / BillingPort で表現します。

この catalog は **Installable App v1 の managed binding catalog** です。Takosumi
kernel の universal resource model ではなく、compiled Shape manifest
に到達する前の installer / Accounts materialization contract です。新しい
binding kind を増やす 場合は、この catalog と preview / materializer /
acceptance gate を lockstep で 更新します。

Binding materialization は install lifecycle の一部です。kernel deploy
(`POST /v1/deployments`) は compile 済み Shape manifest だけを受け取り、
AppBinding / AppGrant / namespace export grant の ownership は持ちません。

このページで依存してよい範囲:

- `.takosumi/app.yml` の `bindings.*.type` 値として使える 6 種の identifier
- 各 binding materializer が authoring `.takosumi/manifest.yml` の compile 前に
  提供できる `${bindings.<name>.*}` / `${secrets.<name>.*}` reserved placeholder
  vocabulary
- 各 binding が compiled manifest に実値として提供する env vars
- placeholder 解決順序 (canonical, 解決優先度順): `${params.*}` →
  `${installation.*}` → `${artifacts.*}` → `${bindings.*}` → `${secrets.*}` →
  `${env.*}` → kernel-resolved references (`${ref:...}` / `${secret-ref:...}`)

Current `takosumi-git` compiler enforces the boundary conservatively: if
`${params.*}`, `${installation.*}`, `${artifacts.*}`, `${bindings.*}`,
`${secrets.*}`, legacy `${refs.*}`, or `${imports.*}` remains unresolved after
compile, the command fails before Accounts / kernel requests.

The output placeholder tables and "Default env injection" snippets below are the
account-plane materializer contract. They are not a promise that the standalone
compiler will invent values when no materializer supplied them.

このページで依存してはいけない範囲:

- provider plugin (例: `@takos/managed-postgres`) の **内部実装**: backend の
  種類や物理 DB cluster 構成は private。本 catalog は **interface のみ**を
  contract 化する。
- Takosumi kernel 内部の resource shape (`database-postgres@v1` 等): kernel に
  渡る最終 manifest は unresolved binding placeholder を含まず、kernel は
  binding を **知らない**。
- Takosumi Accounts の OIDC issuer 内部実装: `identity.oidc@v1` は consumer
  視点の interface のみを定義する (issuer 側 contract は
  [Takosumi Accounts](../../../takosumi-cloud/docs/architecture/takosumi-accounts.md)
  参照)。

## 0. Catalog 一覧

| # | type identifier                 | domain             | 主担当                                  | required env (default)                                                            |
| - | ------------------------------- | ------------------ | --------------------------------------- | --------------------------------------------------------------------------------- |
| 1 | `identity.oidc@v1`              | identity           | Takosumi Accounts (OIDC issuer)         | `OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI` |
| 2 | `database.postgres@v1`          | data plane         | takosumi-cloud managed-postgres         | `DATABASE_URL`                                                                    |
| 3 | `object-store.s3-compatible@v1` | data plane         | takosumi-cloud managed-object-store     | `BLOB_ENDPOINT` / `BLOB_BUCKET` / `BLOB_ACCESS_KEY` / `BLOB_SECRET_KEY`           |
| 4 | `domain.http@v1`                | network            | takosumi-cloud domain manager + DNS     | (env 注入なし。`${bindings.<name>.url}` を manifest 側で参照)                     |
| 5 | `deploy-intent.gitops@v1`       | deploy bridge      | takosumi-git deploy intent repo         | `DEPLOY_INTENT_DRIVER` / `DEPLOY_INTENT_REMOTE` / `DEPLOY_INTENT_TOKEN`           |
| 6 | `install-launch-token@v1`       | identity bootstrap | Takosumi Accounts (launch token issuer) | `INSTALL_LAUNCH_PUBLIC_KEY` / `INSTALL_LAUNCH_AUDIENCE` / `INSTALL_LAUNCH_ISSUER` |

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

| field                     | required | type            | 説明                                                                       |
| ------------------------- | -------- | --------------- | -------------------------------------------------------------------------- |
| `type`                    | yes      | const           | `"identity.oidc@v1"`                                                       |
| `required`                | no       | boolean         | default `true`                                                             |
| `redirectPaths`           | yes      | string[] (path) | AppInstallation の base URL に append される。例: `/auth/oidc/callback`    |
| `allowedScopes`           | no       | string[]        | default `["openid", "email", "profile"]`                                   |
| `subjectMode`             | no       | const           | `"pairwise"` 固定 (public は採用しない)                                    |
| `tokenEndpointAuthMethod` | no       | enum            | `client_secret_basic` (default) / `client_secret_post` / `private_key_jwt` (future option、 現行 Accounts は未実装) |

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

[materialize](../../../takos/docs/platform/upgrade-export.md#materialize) は
**hostname を変えない** ことを保証する (routing target だけ shared-cell から
dedicated に切り替える)。

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
[launch token JWS](../../../takosumi-cloud/docs/apps/launch-token.md) を
**検証する側 (= app)** に必要な公開鍵 / audience を提供する binding。

実際の token 発行は Takosumi Accounts
(`POST /v1/installations/{id}/launch-token`、
[Install API](../../../takosumi-cloud/docs/accounts-service.md#launch-token)
参照) が担い、本 binding は **検証材料の注入のみ**を担当する。

### 6.1 Request fields

| field                | required | type    | 説明                                   |
| -------------------- | -------- | ------- | -------------------------------------- |
| `type`               | yes      | const   | `"install-launch-token@v1"`            |
| `required`           | no       | boolean | default `true`                         |
| `consumePath`        | no       | path    | default `/_takosumi/launch`            |
| `maxLifetimeSeconds` | no       | int     | 30..300 (hard cap 5 分), default `300` |

### 6.2 Provisioned config

| field                | 説明                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `audience`           | JWS aud claim。通常は `appId` (例: `example.notes`)                                                   |
| `issuer`             | target Takosumi Accounts が materialize する launch token issuer URL                                  |
| `publicKey`          | target Accounts が発行する JWKS JSON。export bundle の source key は active config として再利用しない |
| `algorithm`          | 現行 Accounts issuer は `RS256`                                                                       |
| `kid`                | target Accounts が発行する key id                                                                     |
| `consumePath`        | request の `consumePath` を継承                                                                       |
| `maxLifetimeSeconds` | 上限 lifetime                                                                                         |

token 発行側の **private key は本 binding には含めない** (Takosumi Accounts
内部に保持)。secret schema は **空** (本 binding は public key と audience の
みを扱う)。

現行 Takosumi Accounts は `POST /v1/installations` 時にこの binding を
`takosumi-accounts://.../launch-token/<kid>` config ref へ materialize し、
`GET /v1/installations/{id}/launch-token` で `INSTALL_LAUNCH_*` にそのまま
注入できる public config を返す。

### 6.3 Output placeholders

| placeholder                      | 値                                  |
| -------------------------------- | ----------------------------------- |
| `${bindings.<name>.publicKey}`   | JWKS JSON / PEM pubkey              |
| `${bindings.<name>.audience}`    | aud 値                              |
| `${bindings.<name>.issuer}`      | issuer URL                          |
| `${bindings.<name>.algorithm}`   | `RS256` (EdDSA は future extension) |
| `${bindings.<name>.kid}`         | key id                              |
| `${bindings.<name>.consumePath}` | consume endpoint path               |

### 6.4 Default env injection

```env
INSTALL_LAUNCH_PUBLIC_KEY = ${bindings.<name>.publicKey}
INSTALL_LAUNCH_AUDIENCE   = ${bindings.<name>.audience}
INSTALL_LAUNCH_ISSUER     = ${bindings.<name>.issuer}
```

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

Operator / account plane dependency は current AppBinding catalog
には含めません。 OIDC は `operator.identity.oidc`、billing は
`operator.billing.default` のような namespace export を Accounts / installer
layer が grant し、compiled manifest には unresolved `${bindings.*}` /
`${imports.*}` を残しません。

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

kernel-resolved references は compiled manifest にそのまま残るが、それ以外 (1〜6
と legacy `${refs.*}`) は **kernel deploy payload に残らない** invariant。
current `takosumi-git install apply` は Takosumi Accounts が所有する
AppInstallation の materialization result で supported `${bindings.*}` /
`${secrets.*}` / `${installation.*}` を解決し、 deploy request build 後も
installer-only placeholder が残る場合は kernel request 前に失敗する。`${env.*}`
は kernel resolver ではないため、使う場合は operator-owned manifest generation
で concrete value にする。

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
        INSTALL_LAUNCH_PUBLIC_KEY: "${bindings.bootstrap.publicKey}"
        INSTALL_LAUNCH_AUDIENCE: "${bindings.bootstrap.audience}"
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
