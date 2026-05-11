# Installer Pipeline

`takosumi-git` は Git URL installer / workflow runner / manifest compiler
です。Git URL を受け取り、`.takosumi/app.yml` を解釈し、workflow を sandbox
で走らせて artifact を build し、Takosumi Accounts install API に AppBinding /
AppGrant / namespace export materialization を依頼し、 `.takosumi/manifest.yml`
から compiled Shape manifest を生成し、必要なら takosumi kernel の
`POST /v1/deployments` に投下する。本ページは takosumi-git が所有する
orchestration step / CLI / sandbox / pin / publisher verification
を集約する。AppInstallation ledger と status transition の正本は Takosumi
Accounts です。

::: info このページで依存してよい範囲 / してはいけない範囲

- 依存してよい: 13 step の順序、CLI / API の入口名、commit pin と manifest
  digest が AppInstallation 行に保存されること、build workflow に runtime secret
  は渡らないこと、AppGrant が事後 revoke 可能であること。
- 依存してはいけない: workflow の job scheduler 内部、artifact storage の物理
  path、preview を計算する内部 cache の TTL。これらは takosumi-git product の
  implementation note で、本ページの正本範囲外。
- 依存してはいけない: takosumi kernel が直接 Git URL を読む / `app.yml`
  を解釈する想定。**kernel は compile 後の manifest しか受けない** のが
  Installable App Model の不変条件。

:::

::: info Namespace exports takosumi-cloud / Takosumi Accounts 等の上位 surface
は `operator.identity.oidc` / `operator.billing.default` /
`operator.dashboard.web` / `operator.platform.deploy` の namespace export と
account API / OIDC / BillingPort で参照します。kernel manifest に `imports[]` /
`serviceResolvers[]` / signed `ServiceDescriptor` は入りません。 詳細は
[Namespace Exports](../../../docs/reference/namespace-exports.md)。 :::

## 1. takosumi-git install pipeline (13 step)

本ページは takosumi-git orchestration の canonical step list として固定する。Git
fetch / parse / preview のような AppInstallation 作成前の error は request-level
failure として返る。Accounts に AppInstallation 行を作成した後の error は該当
step で `failed` 状態に遷移し、AppInstallation には `installing → failed` が
記録される (詳細は
[Takosumi Accounts](../../../takosumi-cloud/docs/architecture/takosumi-accounts.md))。

| #  | step                           | owner                   | 入力                                     | 出力                                                     |
| -- | ------------------------------ | ----------------------- | ---------------------------------------- | -------------------------------------------------------- |
| 1  | Git URL 受信                   | takosumi-git API        | `source.url` / `ref`                     | request id                                               |
| 2  | repository fetch               | takosumi-git fetcher    | shallow clone                            | working tree                                             |
| 3  | ref → commit SHA pin           | takosumi-git fetcher    | tag/branch                               | `sourceCommit`                                           |
| 4  | `.takosumi/app.yml` parse      | installer               | working tree                             | InstallableApp v1                                        |
| 5  | `.takosumi/manifest.yml` parse | installer               | working tree                             | template manifest                                        |
| 6  | install preview 生成           | preview service         | step 4 / 5 + binding catalog             | preview JSON                                             |
| 7  | user approve                   | takosumi-cloud UI / API | preview                                  | approval token                                           |
| 8  | workflow sandbox 実行          | workflow runner         | `.takosumi/workflows/*.yml`              | artifact URI / image digest                              |
| 9  | artifact resolve               | installer               | workflow output                          | workflowRef target value                                 |
| 10 | binding provisioning request   | Takosumi Accounts       | AppBinding declaration                   | AppBinding ledger / one-shot env material                |
| 11 | deploy manifest finalize       | manifest compiler       | authoring manifest + materialized inputs | compiled deploy manifest or unresolved-placeholder error |
| 12 | kernel deploy                  | kernel client           | compiled manifest                        | `Deployment.id`                                          |
| 13 | AppInstallation `ready`        | Takosumi Accounts       | step 10 / 12 completion                  | `status: ready`, `runtimeBindingId`                      |

`.takosumi/app.yml` (installer-bound) と `.takosumi/manifest.yml` (authoring
compute manifest) は **明確に別物** で、step 4 / 5 で別 parser を
通す。混同するとビルド出力が kernel に渡らない (kernel は `app.yml`
を受けない)。 詳細は [.takosumi/app.yml spec](../reference/app-yml-spec.md) と
[.takosumi/manifest.yml](../../../takosumi/docs/reference/manifest-spec.md)
を参照。

## 2. CLI: `takosumi-git install`

```bash
takosumi-git install https://github.com/example/my-app --ref v1.2.3
```

主な flag:

| flag                            | 意味                                                    |
| ------------------------------- | ------------------------------------------------------- |
| `--ref <tag\|commit>`           | install 対象の ref。tag か commit に pin する (§4 参照) |
| `--space <id>`                  | 投下先 Space。省略時は personal space                   |
| `--mode shared-cell\|dedicated` | RuntimeBinding の初期 mode (default `shared-cell`)      |
| `--binding <key>=<value>`       | binding 上書き (例: `--binding auth=keycloak-prod`)     |
| `--auto-approve`                | preview 確認なしで実行 (CI 用、対話 install では禁止)   |

CLI は Git URL / ref を受ける installer front-end です。preview / approve は
Takosumi Accounts の public lifecycle と operator UI の背後で takosumi-git
pipeline に委譲されます。takosumi-git が Git fetch、`.takosumi/` parse、commit
pin、manifest digest 計算を終えた後、resolved source pin を Takosumi Accounts
`POST /v1/installations` に渡します。

## 3. API split: takosumi-git apply → Accounts ledger

### takosumi-git apply request

```http
POST /v1/install/apply
Content-Type: application/json
Authorization: Bearer <serve-token>

{
  "source": {
    "type": "git",
    "url": "https://github.com/example/my-app",
    "ref": "v1.2.3"
  },
  "target": {
    "spaceId": "space_personal",
    "mode": "shared-cell"
  },
  "params": {
    "domain": "auto"
  },
  "bindings": {
    "auth": "takosumi-accounts-default",
    "database": "managed-postgres-small",
    "blob": "managed-object-store",
    "deploy": "default-gitops"
  }
}
```

### Accounts ledger request

takosumi-git は上記 request を解決し、Accounts には Git URL/ref ではなく
resolved source pin と binding / grant / OIDC client materialization request
を渡します。 Accounts は Git fetch / `.takosumi/` parse / kernel apply
を行いません。

```http
POST /v1/installations
Content-Type: application/json
Authorization: Bearer <takosumi-account-token>

{
  "accountId": "acct_...",
  "spaceId": "space_personal",
  "appId": "example.my-app",
  "source": {
    "gitUrl": "https://github.com/example/my-app",
    "ref": "v1.2.3",
    "commit": "7f3c9...",
    "appManifestDigest": "sha256:..."
  },
  "mode": "shared-cell",
  "createdBySubject": "tsub_owner"
}
```

### Response

```json
{
  "installationId": "inst_abc",
  "appId": "example.my-app",
  "sourceCommit": "7f3c9...",
  "appManifestDigest": "sha256:...",
  "compiledManifestDigest": "sha256:...",
  "mode": "shared-cell",
  "url": "https://takos-acct123.takosumi.app",
  "status": "installing"
}
```

完全な wire shape (preview / launch-token / materialize / export / upgrade /
rollback) は Takosumi Accounts が所有する。

## 4. Commit pin の必須性

InstallableApp は **必ず commit SHA に pin** された状態で install される。
`ref=main` / `ref=latest` のような移動 ref は受け付けない。これにより:

- AppInstallation 行は `sourceRef` (人間用 label) と `sourceCommit` (machine 用
  immutable identity) の 2 列を保持できる。
- upgrade / rollback / export 時に「何を install したか」を後から説明できる。
- supply chain attack 検知 (`sourceCommit` が突然変わったら incident)
  が成立する。

```txt
良い:
  ref=v1.2.3      → resolve → commit=7f3c9...
  commit=7f3c9... (直接 pin)

悪い:
  ref=main
  ref=latest
```

CLI / API はこの規律を Step 3 (ref → commit SHA pin) で強制する。pin に
失敗した場合 (force-pushed tag 等) は install を `failed` で停止する。

## 5. Workflow sandbox

任意 Git repo の workflow を runtime secret 込みで実行すると、binding secret や
OIDC client secret が build log や artifact に漏れる。これを 防ぐため、workflow
runner は **build phase / deploy phase を物理的に分離** する (本書 / ROADMAP)。

### 5.1 build phase の制約

- runtime secrets は **一切渡さない** (`OIDC_CLIENT_SECRET` / database password
  / object store key など)。
- untrusted Git repo には operator 側の container / VM runner で network egress
  allowlist を適用する。current default local executor は build process の env
  を clear するが、OS-level network namespace は作らない。
- 出力は artifact (image digest / static asset URI) **だけ** が installer
  に返る。stdout / stderr は build log に残るが secret 検知 scrubber を通る。
- workflow が要求する extra secret は AppBinding 経由でなく `secrets:`
  フィールドで明示宣言され、ユーザー approve 必須。

### 5.2 deploy phase の制約

- compiled manifest への binding 値反映は **installer / account plane 内部**で
  行い、workflow からは触れない。
- current `takosumi-git` は Accounts materialization 後に `${bindings.*}` /
  `${secrets.*}` / `${refs.*}` / `${installation.*}` を解決する。未解決の
  `${params.*}` / `${installation.*}` / `${artifacts.*}` / `${bindings.*}` /
  `${secrets.*}` / `${refs.*}` や removed `${imports.*}` は kernel に渡さず、
  deploy request build 時点で失敗させる。
- kernel は manifest 内の installer-only placeholder を受け付けない。残り得る
  placeholder は `${ref:...}` / `${secret-ref:...}` の kernel-resolved
  references だけ。`${imports.*}` は removed placeholder なので残らない。

## 6. Publisher verification

`.takosumi/app.yml` の `metadata.publisher` は signing key と紐付き、 verified
publisher (例: `publisher: takos`) は preview 上に "verified"
表示される。未検証の repo は明示的な警告と「これは野良 install です」 banner を
preview に出して、ユーザーが grant 範囲をより慎重に check できるようにする。

```txt
This app is not from a verified publisher.
Review its manifest and permissions carefully.
```

verification は signing key + publisher domain の両方をチェックし、 preview JSON
の `app.verified: boolean` として返る。

## 7. AppGrant revoke

install 完了後に AppGrant は **いつでも revoke** できる。ユーザーが preview で
approve した capability (例: `deploy.intent.write` / `logs.read.own`) は
AppGrant 1 行ずつに分解され、revoke もそれぞれ 独立に行える。

revoke 時の挙動:

- 該当 AppBinding が secret rotate 対象なら secret を新しい値に差し替え、 古い
  secret は invalidate される。
- runtime に伝搬するのは next request からで、in-flight request は 完了する
  (graceful)。
- revoke は InstallationEvent ledger に append-only で記録される。

詳細な capability 一覧は
[Binding Catalog](../../../docs/reference/binding-catalog.md) を参照。revoke API
と AppGrant ledger は Takosumi Accounts が所有します。

## 次に読むページ

- [.takosumi/app.yml spec](../reference/app-yml-spec.md) step 4 で parse する
  InstallableApp v1 の field 定義。
- [Takosumi Accounts](../../../takosumi-cloud/docs/architecture/takosumi-accounts.md)
  `POST /v1/install/preview` / `POST /v1/installations` と AppInstallation
  status の owner。
- [Binding Catalog](../../../docs/reference/binding-catalog.md) step 10
  で注入される binding 種別と AppGrant の対応。
- [Runtime Modes](../../../docs/platform/runtime-modes.md) step 13 で確定する
  `mode` 列の意味。
