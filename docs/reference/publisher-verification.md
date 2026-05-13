# Publisher Verification Minimum Spec

> このページでわかること: InstallableApp の publisher 検証の最小仕様。

このページは InstallableApp metadata に対する publisher 検証の最小契約を
定義します。レジストリや key-transparency、署名強制の本格運用は別ページの
スコープです。ここでは vocabulary と preview surface だけを固定し、operator や
app が互いに非互換な意味を発明しないようにします。

## 適用範囲

publisher 検証は次のフィールドを持つ `.takosumi/app.yml` に適用します。

- `metadata.publisher`
- `metadata.homepage`
- 任意の `metadata.signingKeyFingerprint`
- resolved source commit (`source.commit` or a full commit `source.ref`)
- app manifest digest (`.takosumi/app.yml` content digest)

リポジトリの Git URL が著名なホストに属しているとか、app 名が既知の製品名
と一致しているという理由だけで verified と扱うことはありません。

## 最小の verified publisher record

verified publisher record は次のフィールドを持ちます。

| field                   | 要件                                                                           |
| ----------------------- | ------------------------------------------------------------------------------ |
| `publisher`             | `metadata.publisher` と一致し、App YAML spec の slug パターンに合致            |
| `homepage`              | `metadata.homepage` の origin と一致し、`https://` を使う                      |
| `signingKeyFingerprint` | `metadata.signingKeyFingerprint` と一致し、`SHA256:<base64url-or-base64>` 形式 |
| `verifiedAt`            | 検証を行った Takosumi Accounts インスタンスが付与する RFC 3339 タイムスタンプ  |
| `method`                | `dns-txt`                                                                      |

最小の DNS レコード名:

```txt
_takosumi-publisher.<homepage-host>
```

最小の TXT 値:

```txt
takosumi-publisher=v1 publisher=<publisher> key=<signingKeyFingerprint>
```

operator は追加のローカルポリシーを設けて構いませんが、preview vocabulary は
このフィールド群にマップできる必要があります。

## Preview semantics

`takosumi-git install preview` は次を公開します。

- `publisher.id`
- `publisher.verified`
- `publisher.signingKeyFingerprint` (存在する場合)
- `risk.reasons[]` — 検証が無い・失敗した場合は `publisher is not verified`
  を含む

`publisher.verified: true` は、operator が提供する verification record が app
metadata と一致し、かつ resolved source commit と app manifest digest が preview
に含まれるときにだけセットされます。registry 連携の verifier が未配線な環境では
CLI のフォールバックは保守的で、`metadata.signingKeyFingerprint` がある場合でも
unverified のままです。

## Non-goals

次の項目は本ページの最小スコープには含めません。

- key transparency log
- Sigstore / Fulcio 連携
- publisher アカウントの自動復旧
- cross-instance federation
- GitHub organization ownership を publisher 検証として扱うこと

Preview vocabulary anchor:

```ts
publisher: {
  id: "example";
  verified: false;
}
```
