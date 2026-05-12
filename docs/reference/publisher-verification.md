# Publisher Verification Minimum Spec

This document defines the minimum 1.x publisher verification contract for
InstallableApp metadata. Full registry, key-transparency, and signing
enforcement remain 2.x work; 1.x only fixes the vocabulary and the preview
surface so operators and apps do not invent incompatible meanings.

## Scope

Publisher verification applies to `.takosumi/app.yml` documents with:

- `metadata.publisher`
- `metadata.homepage`
- optional `metadata.signingKeyFingerprint`
- the immutable `source.ref` / `source.commit` chain

The installer must never treat a repository as verified only because the Git URL
belongs to a popular host or because the app name matches a known product.

## Minimum Verified Publisher Record

A verified publisher record contains:

| field                   | requirement                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `publisher`             | Matches `metadata.publisher` and the slug pattern in the App YAML spec              |
| `homepage`              | Matches `metadata.homepage` origin and uses `https://`                              |
| `signingKeyFingerprint` | Matches `metadata.signingKeyFingerprint` with `SHA256:<base64url-or-base64>` syntax |
| `verifiedAt`            | RFC 3339 timestamp from the verifying Takosumi Accounts instance                    |
| `method`                | `dns-txt` for the 1.x minimum method                                                |

The 1.x minimum DNS record name is:

```txt
_takosumi-publisher.<homepage-host>
```

The minimum TXT value is:

```txt
takosumi-publisher=v1 publisher=<publisher> key=<signingKeyFingerprint>
```

Operators may add stricter local policy, but the preview vocabulary must still
map to the fields above.

## Preview Semantics

`takosumi-git install preview` exposes:

- `publisher.id`
- `publisher.verified`
- `publisher.signingKeyFingerprint` when present
- `risk.reasons[]` including `publisher is not verified` when verification is
  absent or failed

For 1.x, `publisher.verified: true` is allowed only when an operator-provided
verification record matches the app metadata. Until a registry-backed verifier
is wired in, the CLI fallback is intentionally conservative: a missing
`metadata.signingKeyFingerprint` is unverified, and a present fingerprint is
only a preview signal, not a portable proof.

## Non-Goals

The following are explicitly outside 1.x minimum scope:

- key transparency log
- Sigstore / Fulcio integration
- automatic publisher account recovery
- cross-instance federation of publisher records
- treating GitHub organization ownership as publisher verification

Those may be added in 2.x without changing the 1.x preview fields.
