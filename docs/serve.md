# Serve

> このページでわかること: `takosumi-git serve` で git webhook
> を受け付けるサーバーの起動方法。

`takosumi-git serve` は git push webhook を `takosumi-git push` にディスパッチ
する小さな受信サーバーを起動します。workflow / git 関連の処理は takosumi-git
側で完結し、Takosumi kernel は引き続き `POST /v1/deployments` で cleaned
manifest だけを受け取ります。

## 起動

```bash
takosumi-git serve \
  --endpoint "$TAKOSUMI_ENDPOINT" \
  --token "$TAKOSUMI_TOKEN" \
  --webhook-secret "$TAKOSUMI_GIT_WEBHOOK_SECRET"
```

サーバーは既定で `0.0.0.0:8788` を listen し、次のエンドポイントを公開します。

| method | path                           | 用途                                               |
| ------ | ------------------------------ | -------------------------------------------------- |
| POST   | `/webhooks/github`             | GitHub push webhook                                |
| POST   | `/webhooks/gitlab`             | GitLab push webhook                                |
| POST   | `/webhooks/gitea`              | Gitea push webhook                                 |
| POST   | `/v1/install/preview`          | 副作用のない app preview                           |
| POST   | `/v1/install/apply`            | Accounts 経由の install orchestration              |
| POST   | `/v1/install/revision/preview` | 既存 AppInstallation の upgrade / rollback preview |
| POST   | `/v1/install/revision/apply`   | Accounts 台帳への upgrade / rollback mutation      |
| GET    | `/health`                      | health check                                       |

## 署名検証

webhook リクエストは設定された HMAC-SHA256 シークレットで body 署名を検証し、
一致しない場合はディスパッチ前に拒否します。

| provider | signature header                                                   |
| -------- | ------------------------------------------------------------------ |
| GitHub   | `X-Hub-Signature-256: sha256=<hex>`                                |
| GitLab   | `X-Gitlab-Signature-256: sha256=<hex>`                             |
| Gitea    | `X-Gitea-Signature-256: sha256=<hex>` または `X-Hub-Signature-256` |

署名検証後、event header が明示されている場合は push 系 event のみを
ディスパッチします。GitHub / Gitea は `push`、GitLab は `Push Hook` または
`Tag Push Hook` を受け付けます。`ping` や pull request などの非 push event は
`202` と `ignored: true` を返し、キューには積みません。event header がない
request は current implementation では generic push payload として扱いますが、
pre-GA の互換保証ではありません。

## キューと重複排除

delivery ID はメモリ内で deduplicate されます。重複配送は `202` と
`duplicate: true` を返し、二重ディスパッチしません。in-memory キューは順次 drain
するため、同一プロセスで webhook が重なっても push が並列実行される
ことはありません。

レートリミットもメモリ内に持ち、既定では `X-Forwarded-For` キーあたり 60 秒に 60
リクエストです。

## Webhook ディスパッチモード

既定では、検証済みの git webhook は `takosumi-git push` のディスパッチをキュー
に積みます。install pipeline 経由でルーティングしたい場合は次のように起動
します。

```bash
takosumi-git serve \
  --webhook-mode install \
  --accounts-url "$TAKOSUMI_ACCOUNTS_URL" \
  --accounts-token "$TAKOSUMI_ACCOUNTS_TOKEN" \
  --account-id "$TAKOS_ACCOUNT_ID" \
  --space-id "$TAKOS_SPACE_ID" \
  --subject "$TAKOSUMI_SUBJECT"
```

install webhook モードはローカルの `.takosumi/app.yml` を読み、webhook の commit
が 40 桁の full SHA であればそれを `source.commit` の pin として使い、
`install apply` を実行し、設定があれば kernel に deploy し、Takosumi Accounts に
AppInstallation レコードを作成・遷移します。

## Install API

`POST /v1/install/preview` は [Install Preview and Apply](./install.md) で
説明している preview body をそのまま受け付けます。副作用がなく bearer
トークンも不要です。

`POST /v1/install/apply` は Git ソースに対する `install apply` 一連
(checkout、preview/compile、Accounts install API 呼び出し、任意の kernel
deploy、Accounts status 遷移) を実行します。Accounts と kernel に状態変更を
要求するため、次のヘッダが必須です。

```text
Authorization: Bearer <serve-token>
```

serve プロセスには Accounts 認証情報を渡しておきます。

```bash
takosumi-git serve \
  --endpoint "$TAKOSUMI_ENDPOINT" \
  --token "$TAKOSUMI_TOKEN" \
  --webhook-secret "$TAKOSUMI_GIT_WEBHOOK_SECRET" \
  --accounts-url "$TAKOSUMI_ACCOUNTS_URL" \
  --accounts-token "$TAKOSUMI_ACCOUNTS_TOKEN"
```

body フィールド:

```json
{
  "gitUrl": "https://github.com/example/hello",
  "ref": "v1.2.3",
  "accountId": "acct_...",
  "spaceId": "space_...",
  "subject": "tsub_..."
}
```

レスポンス kind は `takosumi-git.install-apply@v1` です。

`POST /v1/install/revision/preview` と `POST /v1/install/revision/apply` は
`takosumi-git upgrade` / `takosumi-git rollback` と同じ既存インストールの source
revision フローを HTTP で公開します。どちらも Accounts から AppInstallation
を読むため serve bearer token が必要で、apply エンドポイント は Takosumi
Accounts にも revision を投下します。

```json
{
  "operation": "upgrade",
  "installationId": "inst_...",
  "ref": "v1.2.4"
}
```

rollback の場合は `"operation": "rollback"` と `"to": "v1.2.3"` を渡します。
レスポンス kind は `takosumi-git.install-revision-preview@v1` /
`takosumi-git.install-revision-apply@v1` です。
