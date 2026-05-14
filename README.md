# takosumi-git

`takosumi-git` は **Git push から Takosumi kernel への deploy までを 1 コマンド
で繋ぐ installer** です。`.takosumi/` 配下のワークフローを実行してアーティファ
クト URI を解決し、コンパイル済みマニフェストを `POST /v1/deployments` で投下し
ます。

[`takosumi`](https://github.com/tako0614/takosumi) カーネル本体は純粋なマニフェ
ストデプロイエンジンで、Git・ワークフロー・プロジェクトレイアウトの解釈は持ち
ません。`takosumi-git` はその上で Git URL install / `.takosumi/` convention を
提供する canonical installer であり、raw deploy では数ある client の 1 つです。

## Quick start

```bash
# リポジトリのルートで実行
takosumi-git init                  # .takosumi/app.yml + manifest.yml + workflows/build.yml を生成
$EDITOR .takosumi/app.yml          # インストールメタデータ / バインディング / 権限を設定
$EDITOR .takosumi/manifest.yml     # image URI ポリシー / リソースを設定
takosumi-git push --endpoint $TAKOSUMI_ENDPOINT --token $TAKOSUMI_TOKEN
```

`.takosumi/` プロジェクトレイアウトは `takosumi-git` の所有です。takosumi
カーネルは明示的なパスまたは HTTP body でマニフェストを受け取るだけで、
ファイルレイアウトについての意見は持ちません。完全な convention は
[AGENTS.md](./AGENTS.md) を参照してください。

## Docs

- [Quickstart](./docs/quickstart.md)
- [WorkflowRef](./docs/workflow-ref.md)
- [Artifact URI Contract](./docs/artifact-contract.md)
- [Install Preview and Apply](./docs/install.md)
- [History](./docs/history.md)
- [Serve](./docs/serve.md)

## 実行モデル

1. Git リポジトリ (push / PR / tag) を監視するか、webhook イベントを受け取る
2. `.takosumi/workflows/` 配下のビルドパイプライン (image build, artifact
   upload) を実行する
3. アーティファクト URI を解決し、`Manifest` ドキュメントを生成する
4. マニフェストと opaque なデプロイプロベナンスを takosumi カーネルに
   `POST /v1/deployments` で送信する
5. マニフェストの Git 履歴をバージョン履歴の正本として扱う

`takosumi-git` は opaque な `takosumi-git.deployment-provenance@v1` JSON
チェーンを添付し、どのワークフロー実行 / Git コミット / アーティファクト URI /
ステップログダイジェストからマニフェストが生まれたかをカーネルの WAL
に記録できます。

## CLI コマンド

`takosumi-git init`、`push`、`install`、`import`、`upgrade`、`rollback`、
`materialize`、`export`、`serve`、`history` を実装しています。

- `init`: `.takosumi/` プロジェクトレイアウト (`app.yml` + `manifest.yml` +
  `workflows/build.yml`) を生成
- `push`: `.takosumi/manifest.yml` (takosumi v1 マニフェスト envelope) を読み、
  各 `resources[i].workflowRef` を参照されたワークフロージョブのステップ実行
  (`bash -lc`) で解決して v1 `TAKOSUMI_ARTIFACT=<uri>` stdout マーカーを読み、
  該当リソースエントリの `spec.image` フィールドに置換、private な `workflowRef`
  拡張を strip、リソースレベルのプロベナンスと top-level デプロイプロベナンス
  チェーンを添付し、整形済みマニフェストを takosumi カーネルの
  `POST /v1/deployments` に投稿
- `install`: `.takosumi/app.yml` を preview し、Takosumi Accounts に
  AppInstallation を作成。コンパイル済みマニフェストをカーネルにデプロイし、
  マテリアライズされた runtime env を注入してインストール状態を更新
- `upgrade` / `rollback`: ソースリビジョン変更を Accounts 台帳経由で preview /
  apply
- `serve`: 同じリビジョン preview / apply フローをプロダクト UI 向けに公開。
  GitHub / GitLab / Gitea webhook ルート (署名検証、レート制限、配信 dedup、
  キュードレイン、push dispatch、install / revision preview / apply HTTP API)
  も提供
- `import`: JSON AppInstallation export bundle または `takos-export/bundle.json`
  を含む `tar.zst` アーカイブを読み、Takosumi Accounts に投稿
- `materialize`: shared-cell から dedicated ランタイムへのマテリアライズを要求
- `export`: Takosumi Accounts 経由で self-host bundle 操作を要求。
  `export --output` は必要に応じて export 操作をポーリングし、完成した
  `downloadUrl` のバンドルを書き出す
- `history`: マニフェストコミットを一覧し、リソース毎のセマンティック diff
  を表示

詳細なパッケージレイアウトと設計境界は [AGENTS.md](./AGENTS.md)
を参照してください。

## リリース

Semver タグ (`v*.*.*`) で `.github/workflows/release.yml` が実行されます。
ワークフローはチェックとテスト、JSR dry-run を経て、GitHub OIDC で takosumi-git
JSR パッケージセットを publish します。手動実行は明示的に `publish`
入力を指定しない限り dry-run のままです。タグはリポジトリレベルの
リリースマーカーであり、publish 対象のパッケージバージョンは事前に未公開の JSR
バージョンに上げてからタグを打ちます。
