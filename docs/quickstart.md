# Quickstart

> このページでわかること: takosumi-git の初回セットアップと最初の push
> までの手順。

このページはソースチェックアウトを使った手順です。JSR publish 後は
`deno install -gA -n takosumi-git jsr:@takos/takosumi-git-cli` でインストール
した `takosumi-git init` / `takosumi-git push` / `takosumi-git install` も
同じ流れで使えます。

## 1. Scaffold

アプリリポジトリのルートで実行します。

```bash
deno run -A /path/to/takosumi-git/packages/cli/src/main.ts init --name demo
```

次のファイルが作成されます。

```text
.takosumi/
├── app.yml
├── manifest.yml
└── workflows/
    └── build.yml
```

このディレクトリは takosumi-git のプロジェクト規約で、Takosumi kernel は読み
ません。

## 2. インストールメタデータを編集

`.takosumi/app.yml` に publisher、source pin、runtime mode、binding、 permission
を設定します。Accounts と kernel を変更せずプレビューを確認 できます。

```bash
deno run -A /path/to/takosumi-git/packages/cli/src/main.ts install preview --json
```

パッケージインストール後は `takosumi-git install preview` で同じ動作になり
ます。上記の `deno run` 形式はソースチェックアウト用の等価コマンドです。

InstallableApp v1 の contract と Accounts への apply フローは
[Install Preview and Apply](./install.md) を参照してください。

## 3. マニフェストを編集

`.takosumi/manifest.yml` に resource の shape / provider / spec を書きます。
ビルド成果物が必要なリソースは `resources[i].workflowRef` を使います。

```yaml
resources:
  - name: web
    shape: web-service@v1
    provider: "@takos/aws-fargate"
    spec:
      port: 8080
    workflowRef:
      file: build.yml
      job: image
      artifact: image
```

フィールドの詳細は [WorkflowRef](./workflow-ref.md) を参照してください。
workflow ファイルのパスは `.takosumi/workflows` 配下でなければならず、`../`
や絶対パスでの escape は拒否されます。

## 4. workflow に artifact URI marker を出力させる

`.takosumi/workflows/build.yml` を開きます。Artifact URI v1 では、成功した
workflow が `TAKOSUMI_ARTIFACT=<uri>` を stdout に出力する必要があります。

```yaml
version: "0"
jobs:
  - name: image
    steps:
      - name: build
        run: |
          docker build -t ghcr.io/example/demo:${GIT_SHA} .
          docker push ghcr.io/example/demo:${GIT_SHA}
          echo "TAKOSUMI_ARTIFACT=ghcr.io/example/demo@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    artifact:
      name: image
```

v1 marker と failure 時の挙動は [Artifact URI Contract](./artifact-contract.md)
を参照してください。

## 5. ドライラン

dry-run は workflow を実行して `workflowRef` を strip し、resolved URI を
`resources[i].spec.image` (または設定されていれば `workflowRef.target`)
に書き込み、整形後の manifest を出力します。kernel には送信しません。

```bash
deno run -A /path/to/takosumi-git/packages/cli/src/main.ts push --dry-run
```

## 6. Apply

manifest に問題がなければ Takosumi kernel に送信します。

```bash
deno run -A /path/to/takosumi-git/packages/cli/src/main.ts push \
  --endpoint "$TAKOSUMI_ENDPOINT" \
  --token "$TAKOSUMI_TOKEN"
```

`push` は整形済みの Takosumi v1 manifest と
`takosumi-git.deployment-provenance@v1` を `POST /v1/deployments` に送ります。
kernel は `.takosumi/workflows/*.yml` や `workflowRef` を受け取らず、workflow
を実行・解釈しません。provenance JSON は監査用に記録するだけです。

## Implementation drift anchors

```text
ARTIFACT_MARKER_PREFIX
clearEnv: true
WORKFLOW_ENV_ALLOWLIST
resolveWorkflowFilePath
validateResolvedArtifactTarget
spec.image artifacts must be digest-pinned
artifactContractResolver
parseArtifactContract
setResourceArtifactTarget
stripWorkflowRefs
workflow job '${jobName}' produced no ${ARTIFACT_MARKER_PREFIX}<uri> marker; cannot resolve artifact URI
```

Workflow files must stay inside `.takosumi/workflows`.
