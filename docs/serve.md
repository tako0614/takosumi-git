# Serve

> Stability: v0 Audience: operator Owner: takosumi-git

`takosumi-git serve` runs a small webhook receiver that turns git push webhooks
into `takosumi-git push` dispatches. It keeps workflow / git concerns in
takosumi-git; the Takosumi kernel still only receives the cleaned manifest at
`POST /v1/deployments`.

## Start

```bash
takosumi-git serve \
  --endpoint "$TAKOSUMI_ENDPOINT" \
  --token "$TAKOSUMI_TOKEN" \
  --webhook-secret "$TAKOSUMI_GIT_WEBHOOK_SECRET"
```

The server listens on `0.0.0.0:8788` by default and exposes:

| method | path               | provider |
| ------ | ------------------ | -------- |
| POST   | `/webhooks/github` | GitHub   |
| POST   | `/webhooks/gitlab` | GitLab   |
| POST   | `/webhooks/gitea`  | Gitea    |
| GET    | `/health`          | health   |

## Signature Verification

Requests are rejected before dispatch unless the body matches the configured
HMAC-SHA256 secret.

| provider | signature header                                               |
| -------- | -------------------------------------------------------------- |
| GitHub   | `X-Hub-Signature-256: sha256=<hex>`                            |
| GitLab   | `X-Gitlab-Signature-256: sha256=<hex>`                         |
| Gitea    | `X-Gitea-Signature-256: sha256=<hex>` or `X-Hub-Signature-256` |

## Queue and Dedup

Delivery IDs are deduplicated in memory. Duplicate deliveries return `202` with
`duplicate: true` and do not dispatch another push. The in-memory queue drains
sequentially so overlapping webhook deliveries cannot run concurrent pushes in
the same process.

Rate limiting is also in memory and defaults to 60 requests per 60 seconds per
`X-Forwarded-For` key.
