# `.takosumi/app.yml` Spec (InstallableApp v1)

> このページでわかること: `.takosumi/app.yml` の全フィールドと validation
> ルール。

`.takosumi/app.yml` は **installer-bound manifest** です。Git URL から install
できる app の identity / source / binding / permission / upgrade policy を 1
ファイルで宣言し、takosumi-git (installer) の入口として機能します。本ページは
field 定義と `.takosumi/manifest.yml` (authoring compute manifest; compile 後に
compiled Shape manifest になる) との関係を定義します。

## 1. `apiVersion` / `kind` の固定 literal

```yaml
apiVersion: app.takosumi.dev/v1
kind: InstallableApp
```

- `apiVersion` は必ず `app.takosumi.dev/v1` の string 一致。他値は parser error
  です
- `kind` は必ず `InstallableApp` の string 一致。他値は parser error です
- 両 field は document の root に直接置きます。nested は不可です

takosumi-git は current v1 spec / parser / tests / docs
を同じ変更で一貫更新します。

---

## 2. top-level field 一覧

| field         | 必須     | 型           | 概要                                            |
| ------------- | -------- | ------------ | ----------------------------------------------- |
| `apiVersion`  | ✅       | string lit.  | `app.takosumi.dev/v1` (§1)                      |
| `kind`        | ✅       | string lit.  | `InstallableApp` (§1)                           |
| `metadata`    | ✅       | object       | app の identity / publisher / homepage (§3.1)   |
| `source`      | ✅       | object       | git URL + ref (+ optional commit) の宣言 (§3.2) |
| `entry`       | ✅       | object       | authoring manifest path (§3.3)                  |
| `runtime`     | ✅       | object       | サポートする runtime mode (§3.4)                |
| `bindings`    | ✅       | object (map) | 要求する resource binding 群 (§3.5)             |
| `install`     | ✅       | object       | install 完了判定と launch 経路 (§3.6)           |
| `permissions` | ✅       | object       | 要求する AppGrant 群 (§3.7)                     |
| `upgrade`     | optional | object       | upgrade 自動 / 手動 policy (§3.8)               |

### unknown field

**reject** します。Top-level / nested を問わず、本 spec が定義しない field
を含む `app.yml` は parser error です。実験的拡張のための namespace (例: `x-*`)
は **設けません**。

---

## 3. field 詳細

### 3.1 `metadata`

```yaml
metadata:
  id: example.notes
  name: Example Notes
  description: Collaborative notes app
  publisher: example
  homepage: https://example.com/notes
  signingKeyFingerprint: SHA256:abcd... # optional
```

| field                            | 必須     | 制約                                                                                              |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `metadata.id`                    | ✅       | reverse-domain-name format `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$`、1〜200 char、ecosystem 内一意 |
| `metadata.name`                  | ✅       | 1〜80 char、display name                                                                          |
| `metadata.description`           | ✅       | 1〜500 char、1 文の app 概要                                                                      |
| `metadata.publisher`             | ✅       | `^[a-z0-9]([a-z0-9-]{0,78}[a-z0-9])?$`、1〜80 char、Takosumi Accounts の publisher table 照合     |
| `metadata.homepage`              | ✅       | `https://` URL。Publisher verification の DNS TXT record 解決元                                   |
| `metadata.signingKeyFingerprint` | optional | `SHA256:<base64>` の Ed25519 pubkey fingerprint。なければ `verified: false` 扱い                  |

`metadata.id` の値は operator account plane が所有する AppInstallation table
(reference impl: Takosumi Accounts) の `appId` 列と一致します。

### 3.2 `source`

```yaml
source:
  git: https://github.com/takos/takos
  ref: v1.2.3
  commit: 7f3c9abc... # optional but recommended
```

| field           | 必須     | 制約                                                                              |
| --------------- | -------- | --------------------------------------------------------------------------------- |
| `source.git`    | ✅       | `https://` または `git@host:path` 形式の git URL                                  |
| `source.ref`    | ✅       | git tag / commit SHA。**mutable ref は禁止**                                      |
| `source.commit` | optional | full 40-char hex SHA。指定時は installer が `source.ref` の解決結果と一致確認する |

#### mutable ref 禁止規則

- **禁止**: `main`, `master`, `develop`, `latest`, `HEAD`, branch name 一般
- **許可**: semver tag (`v1.2.3`)、release tag、annotated tag、full 40-char
  commit SHA
- 検出方法: takosumi-git が ref を resolve 後、当該 ref が **branch ref
  ではない** こと、かつ **再度 resolve したときに同じ commit を指す** ことを確認
- 違反時: parser stage で reject (`ref looks mutable: ...`)

install した内容を後から説明できるようにするため、commit と manifest digest が
命綱になります。source commit / app manifest digest / artifact digest / compiled
manifest digest の chain は
[Supply Chain Trust](../../../takosumi/docs/reference/supply-chain-trust.md)
を参照してください。

### 3.3 `entry`

```yaml
entry:
  manifest: .takosumi/manifest.yml
```

| field            | 必須 | 制約                                                                                                                                   |
| ---------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `entry.manifest` | ✅   | repo root からの relative path。default & 推奨は `.takosumi/manifest.yml`。`..` を含まない。symlink 解決後 repo の外を指してはならない |

`entry.manifest` で指された file は takosumi-git が compile する authoring
compute manifest です。kernel に届くのは placeholder / `workflowRef` を除去した
compiled Shape manifest だけです
([Manifest Reference](../../../takosumi/docs/reference/manifest-spec.md))。

### 3.4 `runtime`

```yaml
runtime:
  modes:
    - shared-cell
    - dedicated
    - self-hosted
```

| field           | 必須 | 制約                                                                                     |
| --------------- | ---- | ---------------------------------------------------------------------------------------- |
| `runtime.modes` | ✅   | string array、1〜3 要素。値は `shared-cell` / `dedicated` / `self-hosted` のみ。重複禁止 |

- `shared-cell` を含む app のみが managed shared-cell install、または Use Takos
  で作成された Space への bundled auto-install 対象になれます
- `self-hosted` を含まない app は Export bundle 経由でも別 takosumi に restore
  できません

詳細は [Runtime Modes](../../../docs/platform/runtime-modes.md)
を参照してください。

### 3.5 `bindings`

```yaml
bindings:
  auth:
    type: identity.oidc@v1
    required: true
    redirectPaths:
      - /auth/oidc/callback

  database:
    type: database.postgres@v1
    required: true
    plan: small

  blob:
    type: object-store.s3-compatible@v1
    required: true
    plan: standard

  deploy:
    type: deploy-intent.gitops@v1
    required: false

  bootstrap:
    type: install-launch-token@v1
    required: true
```

`bindings` は **map**。key は app 内で binding を参照する logical name (例:
`auth`)、value は binding 宣言 object です。

| field                           | 必須        | 制約                                                                |
| ------------------------------- | ----------- | ------------------------------------------------------------------- |
| `bindings.<name>`               | (map entry) | 1〜32 entry。key は `^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$`             |
| `bindings.<name>.type`          | ✅          | 下記 closed enum 6 種のいずれか                                     |
| `bindings.<name>.required`      | conditional | `true` で provision 必須。`false` で provider 不在でも install 続行 |
| `bindings.<name>.redirectPaths` | optional    | `identity.oidc@v1` 専用。`/` 始まり path 配列、1〜10 要素           |
| binding-specific 任意 field     | optional    | 各 binding type の追加 field は Binding Catalog 章で個別定義        |

#### binding type の closed enum (v1)

```
identity.oidc@v1
database.postgres@v1
object-store.s3-compatible@v1
domain.http@v1
deploy-intent.gitops@v1
install-launch-token@v1
```

これら以外の type を追加するときは Binding Catalog を lockstep で拡張する
必要があります (任意 type を独自に発明することはできません)。

Operator / account plane / billing dependency は AppBinding type
ではありません。OIDC は `operator.identity.oidc`、billing は
`operator.billing.default` の namespace export を Accounts / installer layer が
explicit grant / account API / OIDC discovery / BillingPort で materialize
します。compiled manifest には unresolved installer-only placeholder
を残しません。

`bindings.<name>` の `<name>` は、account-plane materializer が提供する
`${bindings.<name>.<key>}` / `${secrets.<name>.<key>}`
と紐づきます。`install apply` は operator account plane が所有する
AppInstallation の materialization result で account-plane-backed placeholder
を解決し、 deploy request build 後も unresolved installer-only placeholder
が残る場合は kernel request 前に失敗します。`push` / `preview` には Accounts
materialization phase がないため、installer-only placeholder を deploy
前に拒否します。

### 3.5.1 Namespace export は `app.yml` のフィールドではない

`app.yml` に `serviceImports[]` フィールドはありません。外部 dependency を
表す必要がある場合は、次のいずれかで表現します。

- install-time resource / credential: `bindings` の closed catalog
- user-approved permission: `permissions.requested` の AppGrant catalog
- OIDC issuer / billing / dashboard / deploy API: operator namespace export
  (`operator.identity.oidc` / `operator.billing.default` など) と account API
- compute resource dependency: kernel Shape resource の `${ref:...}` /
  `${secret-ref:...}`

この分離により、kernel は service registry / anchor / signed descriptor を
知らないままに保たれます。

### 3.6 `install`

```yaml
install:
  healthcheckPath: /health
  postInstallLaunchPath: /_takosumi/launch
```

| field                           | 必須 | 制約                                                                                            |
| ------------------------------- | ---- | ----------------------------------------------------------------------------------------------- |
| `install.healthcheckPath`       | ✅   | `/` 始まり path、1〜200 char。HTTP 200 を返したら installation を `ready` に遷移してよい signal |
| `install.postInstallLaunchPath` | ✅   | `/` 始まり path、1〜200 char。Launch token を query で受け、owner session を作る endpoint       |

`postInstallLaunchPath` の URL は Takosumi Accounts が
`https://<installation host>/<postInstallLaunchPath>?launch_token=...` の形に
組み立てます。query は installer / accounts が動的に付与するため、両 path とも
query を含めません。詳細は
[Launch Token](../../../takosumi-cloud/docs/apps/launch-token.md)
を参照してください。

### 3.7 `permissions`

```yaml
permissions:
  requested:
    - app.profile.write
    - app.memory.write
    - deploy.intent.write
    - logs.read.own
```

| field                   | 必須 | 制約                                                                          |
| ----------------------- | ---- | ----------------------------------------------------------------------------- |
| `permissions.requested` | ✅   | string array、0〜32 要素。各値は下記 closed enum (20 種) のいずれか。重複禁止 |

#### closed enum (v1)

```
app.profile.write
app.memory.write
deploy.intent.write
logs.read.own
billing.usage.report
spaces:read
spaces:write
files:read
files:write
memories:read
memories:write
threads:read
threads:write
runs:read
runs:write
agents:execute
repos:read
repos:write
mcp:invoke
events:subscribe
```

- Install preview で **必ず一覧表示** されます
- install 完了時に Takosumi Accounts が AppInstallation に対して各 capability の
  AppGrant を発行します。user は post-install に AppGrant を revoke 可能です。
- `openid` / `profile` / `email` などの OIDC scope は
  `identity.oidc@v1.allowedScopes` で宣言し、`permissions.requested` には
  入れません。`files:*` / `threads:*` などの Takos resource scopes は AppGrant
  としてここに宣言します。

### 3.8 `upgrade` (optional)

```yaml
upgrade:
  policy:
    securityPatch: automatic
    minor: ask
    major: ask
```

| field                          | 必須     | 制約                                                |
| ------------------------------ | -------- | --------------------------------------------------- |
| `upgrade.policy.securityPatch` | optional | `automatic` / `ask` / `manual`。default `automatic` |
| `upgrade.policy.minor`         | optional | 同上、default `ask`                                 |
| `upgrade.policy.major`         | optional | 同上、default `ask`                                 |

#### enum 意味

- `automatic`: 新 ref 検出時に preview を出さず、permission diff が
  空の場合に限り apply。permission diff があれば自動で `ask` に degrade
- `ask`: 新 ref 検出時に Install preview の **upgrade variant** を user
  に提示し、approve を待つ
- `manual`: 自動検出を行わず、user が明示的に upgrade を発行したとき のみ動く

## 4. 完全な YAML 例

generic な InstallableApp の完全な例:

```yaml
apiVersion: app.takosumi.dev/v1
kind: InstallableApp

metadata:
  id: example.notes
  name: Example Notes
  description: Collaborative notes app
  publisher: example
  homepage: https://example.com/notes

source:
  git: https://github.com/example/notes-app
  ref: v1.2.3

entry:
  manifest: .takosumi/manifest.yml

runtime:
  modes:
    - shared-cell
    - dedicated
    - self-hosted

bindings:
  auth:
    type: identity.oidc@v1
    required: true
    redirectPaths:
      - /auth/oidc/callback

  database:
    type: database.postgres@v1
    required: true
    plan: small

  blob:
    type: object-store.s3-compatible@v1
    required: true
    plan: standard

  deploy:
    type: deploy-intent.gitops@v1
    required: false

  bootstrap:
    type: install-launch-token@v1
    required: true

install:
  healthcheckPath: /health
  postInstallLaunchPath: /_takosumi/launch

permissions:
  requested:
    - app.profile.write
    - app.memory.write
    - deploy.intent.write
    - logs.read.own

upgrade:
  policy:
    securityPatch: automatic
    minor: ask
    major: ask
```

### minimal example

最小サイズの positive example。`identity.oidc@v1` のみ要求する hello-world app
です。

```yaml
apiVersion: app.takosumi.dev/v1
kind: InstallableApp

metadata:
  id: example.hello
  name: Hello
  description: Minimal example app
  publisher: example
  homepage: https://example.com

source:
  git: https://github.com/example/hello
  ref: v0.1.0

entry:
  manifest: .takosumi/manifest.yml

runtime:
  modes:
    - shared-cell

bindings:
  auth:
    type: identity.oidc@v1
    required: true
    redirectPaths:
      - /auth/oidc/callback

install:
  healthcheckPath: /health
  postInstallLaunchPath: /_takosumi/launch

permissions:
  requested: []
```

---

## 5. `app.yml` (installer-bound) vs `manifest.yml` (authoring compute)

Installable App Model では Takos repo の `.takosumi/` 配下に **2 種類**
の宣言が並びます。読み手と placeholder の有無で役割を厳密に分けます。

| 観点         | `.takosumi/app.yml`                          | `.takosumi/manifest.yml`                                                                                                            |
| ------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `apiVersion` | `app.takosumi.dev/v1`                        | `"1.0"` (Shape manifest envelope)                                                                                                   |
| `kind`       | `InstallableApp`                             | `Manifest` (required)                                                                                                               |
| 読み手       | takosumi-git (installer)                     | takosumi-git compiler。kernel は compiled payload だけを読む                                                                        |
| placeholder  | なし (純粋 metadata)                         | authoring 時のみあり (`${bindings.*}` / `${secrets.*}` / `${ref:...}` 等)                                                           |
| compile      | そのまま **kernel に渡らない**               | installer-only placeholder は materialization 後も未解決なら deploy request build error。`workflowRef` を除去してから kernel に渡る |
| 保存         | `appManifestDigest` (SHA256)                 | `compiledManifestDigest` (SHA256)                                                                                                   |
| 役割         | install UI / binding / permission / metadata | compute resource declaration。kernel-resolved references (`${ref:...}` / `${secret-ref:...}` 等) は残り得る                         |

### kernel に渡らない不変条件

`.takosumi/app.yml` は **takosumi kernel (`POST /v1/deployments`) に
渡りません**。本 contract は **compile-time artifact** であり、 takosumi-git
installer pipeline の Step 3〜11 でのみ参照されます。

kernel が受理するのは `apiVersion: "1.0"` + `kind: Manifest` の Compiled
manifest のみで、`apiVersion: "app.takosumi.dev/v1"` を **知りません**。
これによって kernel は Auth / Account / Billing / Marketplace / Workflow を
一切持たない compute substrate のままを保ちます。

### compile pipeline の位置

```
1. Git fetch
2. Ref → commit pin
3. .takosumi/app.yml parse + validate     ← 本 spec
4. .takosumi/manifest.yml parse + validate ← Manifest Reference
5. Install preview 生成
6. user approval 待機
7. workflow を sandbox で実行
8. artifact URI / image digest 解決
9. Takosumi Accounts install API が AppInstallation ledger entry を作成
10. binding provisioning / namespace export materialization
11. manifest finalize (Accounts-backed placeholder resolve; 未解決の installer-only placeholder は失敗)
12. kernel に POST /v1/deployments        ← Compiled manifest のみ
13. Takosumi Accounts ledger を ready に遷移
```

詳細は [Installer Pipeline](../architecture/installer-pipeline.md)
を参照してください。

---

## 6. 次に読むページ

- [Manifest Reference](../../../takosumi/docs/reference/manifest-spec.md) —
  compiled Shape manifest の field 定義
- [OIDC Consumer](../../../takos/docs/apps/oidc-consumer.md) — `bindings.auth`
  (= `identity.oidc@v1`) が Takosumi 上の Takos product runtime に渡す env
- [Launch Token](../../../takosumi-cloud/docs/apps/launch-token.md) —
  `bindings.bootstrap` (= `install-launch-token@v1`) と
  `install.postInstallLaunchPath`
- [Installer Pipeline](../architecture/installer-pipeline.md) — takosumi-git が
  `.takosumi/app.yml` をどう処理するか
- [Install Paths](../../../takos/docs/apps/install-paths.md) — Use Takos /
  Install from Git / Self-host の 3 経路
- [Takosumi Accounts](../../../takosumi-cloud/docs/architecture/takosumi-accounts.md)
  — `metadata.id` / `appManifestDigest` の永続化先
- [Glossary](../../../docs/reference/glossary.md) — InstallableApp /
  `.takosumi/app.yml` / `.takosumi/manifest.yml`
