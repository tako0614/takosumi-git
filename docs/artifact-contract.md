# Artifact URI Contract

> このページでわかること: workflow の build 出力を artifact URI に解決する仕様。

`takosumi-git push` は workflow 出力を Takosumi manifest に書き込む artifact URI
へ解決します。Takosumi kernel は build を実行せず、workflow file も読まず、
`workflowRef` も解釈しません。kernel は cleaned manifest と opaque な deploy
provenance を `POST /v1/deployments` で受け取るだけです。

## 適用範囲

manifest の resource に takosumi-git の private extension がある場合に適用され
ます。

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

`resources[i].workflowRef` は `takosumi-git push` が読み、kernel に manifest を
送る前に strip します。解決された URI は既定で `resources[i].spec.image` に
書き込まれ、provider が別の field を期待するときは `workflowRef.target` で
`spec.artifact.hash` のような `spec` 配下のドット区切りパスを指定できます。

## Producer rule

参照される workflow job は `artifact` フィールドを宣言し、選択された step が
すべて status `0` で終了する必要があります。job
が成功すると、`takosumi-git
push` は最後の step から順に stdout chunk
を遡り、最後に見つかった `TAKOSUMI_ARTIFACT=<uri>` marker を artifact URI
として採用します。

container image の場合、不変な image URI を marker として出力します。

```yaml
version: "0"
jobs:
  - name: image
    steps:
      - name: build
        run: |
          docker build -t ghcr.io/example/app:${GIT_SHA} .
          docker push ghcr.io/example/app:${GIT_SHA}
          echo "TAKOSUMI_ARTIFACT=ghcr.io/example/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    artifact:
      name: image
```

resolver は JSON envelope や file、子プロセスの shell 環境状態を parse しま
せん。marker は stdout に出力する必要があります。`spec.image` (既定の target)
に書き込む場合、URI は `<image>@sha256:<64-hex>` の digest pin 形式でなければ
なりません。OCI image URI ではない provider 固有の不変 artifact reference を
書き込むときは `workflowRef.target` を使います。

## Stderr の扱い

既定の executor は stderr を別に capture し、人間のデバッグ用に `[stderr]`
セパレータの後ろに log として追記します。URI resolver はそのセパレータの前の
stdout だけを読みます。stderr に URI を出力しても contract を満たしません。

## Build 環境

既定の workflow executor は build step を空の環境変数で起動し、shell tool と
temporary directory を見つけるための小さな共有 allowlist のみを継承します
(`PATH` / `HOME` / `TMPDIR` / `TMP` / `TEMP` / `USER` / `LOGNAME` / `SHELL` /
`LANG` / `LC_ALL` / `TERM`)。`TAKOS_TOKEN` / `TAKOSUMI_TOKEN` /
`TAKOSUMI_DEPLOY_TOKEN` / `OIDC_CLIENT_SECRET` / `DATABASE_URL` /
`AWS_SECRET_ACCESS_KEY` / `CLOUDFLARE_API_TOKEN` のような runtime credential や
operator token は workflow step に継承されません。この allowlist と credential
遮断は CLI の shared sandbox module と push/install executor tests
で固定されます。 publish credential は将来の明示的な build-secret
機構経由で渡し、operator process の環境変数経由では渡しません。
`workflowRef.file` は `.takosumi/workflows` 内の相対パスでなければならず、
workflows ディレクトリの外を指すパス (symlink escape を含む) は実行前に
拒否されます。

## 失敗パターン

| 条件                                        | 結果                                                                                                            |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 参照する workflow file / job が無い         | POST 前に `push` が失敗                                                                                         |
| 選択された step が非ゼロで終了              | POST 前に `push` が失敗し、job log を含めて報告                                                                 |
| job に `artifact` フィールドが無い          | POST 前に `push` が失敗                                                                                         |
| job が marker を出力しない                  | `workflow job '<job>' produced no TAKOSUMI_ARTIFACT=<uri> marker; cannot resolve artifact URI` で `push` が失敗 |
| `spec.image` URI が digest pin されていない | POST 前に `push` が失敗                                                                                         |

`--dry-run` でも workflow は実行され URI
も解決されますが、`POST
/v1/deployments` は送らず cleaned manifest
を出力します。

## Provenance chain

`takosumi-git push` は解決した artifact ごとに次を記録します。

- workflow run id (`takosumi-git:run:<uuid>`)
- 利用可能な場合は git repository / ref / commit の metadata
- resource 名、workflow file / job / artifact、解決後の artifact URI、任意の
  artifact digest
- step ごとの stdout digest、byte count、exit code、step 名

resource には `metadata.takosumiGitProvenance` として workflow run id、git
commit SHA、artifact URI、provenance digest、step log digest が付与されます。
`POST /v1/deployments` の body にも top-level の
`takosumi-git.deployment-provenance@v1` object が含まれます。Takosumi kernel は
この JSON を opaque な WAL evidence として永続化するだけで、workflow を実行
したり解釈したりはしません。

## 関連ページ

- [WorkflowRef](./workflow-ref.md) — `workflowRef` の構造と解決フロー
- [Quickstart](./quickstart.md) — 最初の push までの手順

## Drift check

- 実装: `packages/cli/src/push.ts` (`artifactContractResolver`,
  `lastLineArtifactResolver`, `parseArtifactContract`,
  `setResourceArtifactTarget`, `setResourceProvenanceMetadata`,
  `stripWorkflowRefs`)
- Contract 型: `packages/workflow-contract/src/mod.ts` (`ComputeWorkflowRef`,
  `ResolvedArtifact`, `WorkflowJobSpec`)
- Tests: `packages/cli/src/push_test.ts`、`docs/artifact-contract_test.ts`

Implementation drift anchors: the default executor uses a cleared process,
workflow files must be a path inside `.takosumi/workflows`, and a default
`spec.image` URI is not digest-pinned failure blocks the kernel request.
