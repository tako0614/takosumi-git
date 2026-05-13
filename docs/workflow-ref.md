# WorkflowRef

> このページでわかること: `workflowRef` の構造と workflow → artifact URI
> 解決の仕組み。

`workflowRef` は takosumi-git の私的拡張で、Takosumi v1 manifest の resource に
追加して使います。kernel manifest schema には含まれず、`POST /v1/deployments`
に送る前に必ず strip されます。

## 構造

```ts
interface ComputeWorkflowRef {
  readonly file: string;
  readonly job: string;
  readonly artifact: string;
  readonly target?: `spec.${string}`;
}
```

配置例:

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
      # Optional. Defaults to spec.image.
      target: spec.image
```

| フィールド | 意味                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------ |
| `file`     | workflow YAML のファイル名 (`--workflows-dir` (既定 `.takosumi/workflows`) からの相対パス) |
| `job`      | workflow ファイル内の job 名                                                               |
| `artifact` | job が出力する artifact 名 (resolved artifact 名のフォールバックにも使われる)              |
| `target`   | `spec` 配下のドット区切りパス (省略時は `spec.image`、例: `spec.artifact.hash`)            |

## 解決フロー

1. `takosumi-git push` が `.takosumi/manifest.yml` を読みます
2. すべての `resources[i].workflowRef` を検出します
3. workflows ディレクトリから `workflowRef.file` を読み込みます (絶対パス、
   `../` での escape、symlink escape は実行前に拒否されます)
4. `workflowRef.job` を実行します
5. [Artifact URI Contract](./artifact-contract.md) に従って artifact URI
   を解決します
6. URI を `workflowRef.target` (省略時は `resources[i].spec.image`)
   に書き込みます
7. resource-level の `metadata.takosumiGitProvenance` に artifact chain の
   digest を追加します
8. すべての resource から `workflowRef` を削除します
9. 整形後の manifest と deployment provenance を kernel に送信します
   (`--dry-run` の場合は送信しません)

`workflowRef` を持たない resource はそのまま残ります。

## kernel に届くもの

kernel が受け取るのは次の形だけです。

```yaml
resources:
  - name: web
    shape: web-service@v1
    provider: "@takos/aws-fargate"
    spec:
      port: 8080
      image: ghcr.io/example/demo@sha256:0123456789abcdef
    metadata:
      takosumiGitProvenance:
        kind: takosumi-git.resource-provenance@v1
        provenanceDigest: sha256:...
        workflowRunId: takosumi-git:run:...
        gitCommitSha: 0123456789abcdef0123456789abcdef01234567
        artifactUri: ghcr.io/example/demo@sha256:0123456789abcdef
        stepLogDigests:
          - sha256:...
```

kernel は加えてオプションの `takosumi-git.deployment-provenance@v1` JSON
オブジェクト (workflow run id、git metadata、artifact URI、step ごとの stdout
digest) も受け取ります。kernel はこの payload を WAL に記録するだけで、 workflow
ファイルの読み込み、job 実行、build ログの解析、git の解釈は行いません。 build
と git の責務は takosumi-git 側に閉じます。

## バリデーションとエラー

`push` は `file` / `job` / `artifact` が文字列であることを要求します。 `target`
が指定されている場合、`spec` 配下のドット区切りパスでなければ
なりません。不正な値は kernel リクエスト前にエラーになります。

```text
resources[i].workflowRef must have string {file, job, artifact, target?}
resources[i].workflowRef.target must be a dotted field path below spec, such as spec.image or spec.artifact.hash
```

workflow job が存在しない、step が失敗する、artifact URI が解決できない場合は
`POST /v1/deployments` 前に `push` が失敗します。artifact 固有の失敗パターンは
[Artifact URI Contract](./artifact-contract.md) を参照してください。

## Implementation drift anchors

- `takosumi-git init`
- `.takosumi/app.yml`
- `takosumi-git install preview`
- [Install Preview and Apply](./install.md)
- `takosumi-git/packages/cli/src/main.ts push --dry-run`
- workflow files must stay inside `.takosumi/workflows`
- stripped before `POST /v1/deployments`
