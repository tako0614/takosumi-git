# History

> このページでわかること: `takosumi-git history`
> でマニフェストの変更履歴を表示する方法。

`takosumi-git history` は `.takosumi/manifest.yml` の git history を読みます。
Takosumi kernel には接続せず、deployment record も参照しません。

## Manifest history

```bash
takosumi-git history
```

既定の出力は manifest コミット 1 件につき 1 行です。

```text
<short-sha>  <committed-at>  <subject>
```

manifest が既定の `.takosumi/manifest.yml` 以外にあるときは
`--manifest <path>`、 読み取るコミット数を制限したいときは `--limit <n>`
を指定します。

## Resource diff

```bash
takosumi-git history --resource web
```

resource モードは各リビジョンの manifest を parse して
`resources[].name ==
"web"` を取り出し、安定 YAML
に正規化したうえで隣接リビジョン間のセマンティ ック diff を出力します。無関係な
resource の並び順やフォーマット差分による ノイズを避けつつ、実際に変わった
manifest shape だけを表示します。
