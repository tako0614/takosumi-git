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

| method | path                  | provider / purpose                    |
| ------ | --------------------- | ------------------------------------- |
| POST   | `/webhooks/github`    | GitHub push webhook                   |
| POST   | `/webhooks/gitlab`    | GitLab push webhook                   |
| POST   | `/webhooks/gitea`     | Gitea push webhook                    |
| POST   | `/v1/install/preview` | non-mutating app review               |
| POST   | `/v1/install/apply`   | Accounts-backed install orchestration |
| GET    | `/health`             | health                                |

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

## Webhook Dispatch Mode

By default, verified git webhooks enqueue `takosumi-git push` dispatches.
Operators can instead route webhook deliveries through the install pipeline:

```bash
takosumi-git serve \
  --webhook-mode install \
  --accounts-url "$TAKOSUMI_ACCOUNTS_URL" \
  --accounts-token "$TAKOSUMI_ACCOUNTS_TOKEN" \
  --account-id "$TAKOS_ACCOUNT_ID" \
  --space-id "$TAKOS_SPACE_ID" \
  --subject "$TAKOSUMI_SUBJECT"
```

Install webhook mode reads local `.takosumi/app.yml`, uses the webhook commit as
the `source.commit` pin when it is a full 40-character SHA, runs
`install apply`, optionally deploys to the configured kernel endpoint, and calls
Takosumi Accounts to create or transition the AppInstallation record.

## Install API

`POST /v1/install/preview` accepts the same preview body documented in
[Install Preview and Apply](./install.md). It is non-mutating and does not need
a bearer token.

`POST /v1/install/apply` runs the existing `install apply` orchestration from a
Git source: checkout, preview/compile, Accounts install API call, optional
kernel deploy, and Accounts status transition. Because it asks Accounts and the
kernel to mutate state, callers must send:

```text
Authorization: Bearer <serve-token>
```

The serve process must be configured with Accounts credentials:

```bash
takosumi-git serve \
  --endpoint "$TAKOSUMI_ENDPOINT" \
  --token "$TAKOSUMI_TOKEN" \
  --webhook-secret "$TAKOSUMI_GIT_WEBHOOK_SECRET" \
  --accounts-url "$TAKOSUMI_ACCOUNTS_URL" \
  --accounts-token "$TAKOSUMI_ACCOUNTS_TOKEN"
```

Body fields:

```json
{
  "gitUrl": "https://github.com/example/hello",
  "ref": "v1.2.3",
  "accountId": "acct_...",
  "spaceId": "space_...",
  "subject": "tsub_..."
}
```

The response kind is `takosumi-git.install-apply@v1`.
