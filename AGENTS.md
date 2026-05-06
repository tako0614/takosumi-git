# AGENTS.md — takosumi-git

This repository is **takosumi-git**, the git ↔ takosumi bridge product. It sits
above the [`takosumi`](https://github.com/tako0614/takosumi) PaaS kernel and
submits manifests to it via `POST /v1/deployments`. It is generic and
takos-neutral; takos / その他の利用者は本 product を install して使う一 client
になる。

## Workspace 構成

```
takosumi-git/
├── deno.json                workspace root, 自身は publish しない
├── packages/
│   ├── deploy-client/       @takos/takosumi-git-deploy-client — takosumi POST /v1/deployments client
│   ├── cli/                 @takos/takosumi-git-cli — `takosumi-git push` 等の CLI
│   ├── workflow-contract/   @takos/takosumi-git-workflow-contract — workflow / event 型契約
│   ├── workflow-runner/     @takos/takosumi-git-workflow-runner — workflow execution (build / artifact)
│   ├── git-source/          @takos/takosumi-git-source — git push / webhook → WorkflowEvent normalization
│   └── all/                 @takos/takosumi-git — umbrella (上記を re-export)
└── README.md
```

全 6 package が存在する。`takosumi-git push` は実装済 (manifest YAML を読み、
`compute.<name>.workflowRef` で参照される workflow を実行し、artifact URI を
`image` field に embed して `workflowRef` を strip した上で takosumi の
`POST /v1/deployments` に投下する)。`serve` (webhook receiver) と `history`
(manifest version 履歴表示) は follow-up commit で実装する stub のまま。

## 基本方針

- **Single point of contact with takosumi kernel**: kernel との接続は HTTP
  `POST /v1/deployments` のみ。kernel internal type は import せず、
  `@takos/takosumi-contract` 経由で manifest 型を扱う。
- **Workflow / git は本 repo の責務**: build pipeline / cron / hook / webhook
  receiver / scheduler / git source watch 等は本 repo の domain。 これらを
  kernel 側 (`takosumi/`) に持ち込むことは行わない。
- **Manifest version 管理は git 一任**: manifest file の git history が version
  history の正本。本 product は独自の version primitive を持たない。
- **Artifact URI は本 repo が解決**: build / upload 完了後、確定 URI を `image`
  / `bundle` / `unit` field に embed して manifest を generate する。 takosumi
  kernel に build 概念を漏らさない (image-first 原則)。
- **`.takosumi/` directory は本 product が管理**: `.takosumi/manifest.yml` は
  kernel が読む唯一のファイル、`.takosumi/workflows/*.yml` 等は本 product が
  parse / 実行する。
- **Takos 中立**: takos-app / takos-git / Takos 固有 service ID への直接依存
  は本 repo の core から作らない。Takos product 専用化しない。

## JSR publish layout (planned)

| Package                                 | Version | 内容                                                           |
| --------------------------------------- | ------- | -------------------------------------------------------------- |
| `@takos/takosumi-git-deploy-client`     | 0.0.1   | takosumi `POST /v1/deployments` HTTP client                    |
| `@takos/takosumi-git-cli`               | 0.1.0   | CLI (`takosumi-git push` 実装済 / `serve` / `history` は stub) |
| `@takos/takosumi-git-workflow-contract` | 0.0.1   | workflow YAML / event 型契約 (`ComputeWorkflowRef` 含む)       |
| `@takos/takosumi-git-workflow-runner`   | 0.0.1   | workflow execution (StepExecutor / ArtifactResolver 注入式)    |
| `@takos/takosumi-git-source`            | 0.0.1   | git push / webhook → WorkflowEvent normalization               |
| `@takos/takosumi-git`                   | 0.0.1   | umbrella (上記を re-export)                                    |

## 想定 CLI

```bash
takosumi-git push [options]           # repo の .takosumi/manifest.yml + workflow を解決して takosumi に投下
takosumi-git serve --webhook          # git webhook を受け、自動で push 実行 (stub)
takosumi-git history                  # git history = manifest version 履歴を表示 (stub)
```

`push` の主な flag:

```
--endpoint <url>             takosumi kernel endpoint (or TAKOSUMI_ENDPOINT)
--token <token>              bearer token (or TAKOSUMI_TOKEN)
--manifest <path>            manifest YAML (default .takosumi/manifest.yml)
--workflows-dir <path>       workflows dir (default .takosumi/workflows)
--mode <apply|plan|destroy>  deploy mode (default apply)
--dry-run                    workflow を実行するが POST はせず resolved manifest を出力
```

`compute.<name>.workflowRef: { file, job, artifact }` は takosumi-git の私的
拡張で、kernel に submit する前に必ず strip される。artifact URI は v0 contract
として **last successful step の最後の非空 stdout 行** を採用する (workflow 側で
`echo "ghcr.io/foo/bar@sha256:..."` を最終行に出力する想定)。

## Lint / Format / Test 共通設定

- Lint: `deno task lint`
- Format: `deno task fmt`
- Format check: `deno task fmt:check`
- Test: `deno task test`
- Type check: `deno task check`

## 依存関係

- **Upstream contract**: `@takos/takosumi-contract` (manifest envelope の型)
- **Upstream runtime endpoint**: takosumi kernel の `POST /v1/deployments` (HTTP
  API)
- **Downstream consumers**: 任意の operator / Takos product。本 product を
  install して、git 連携と manifest deploy を行う。
- **本 repo は kernel internal を import しない**: `@takos/takosumi-kernel` /
  `@takos/takosumi-plugins` には依存しない。

## 作業ルール

- workflow / git / build pipeline 関連の implementation は本 repo で完結させる。
  takosumi kernel (`takosumi/`) 側に workflow primitive を追加しない。
- 新 package を増やす時は workspace root の `deno.json` の `workspace` array
  を更新する。
- contract 変更を要する change は upstream `takosumi-contract` repo 側で
  coordination する (manifest 型を変える場合)。
- CLI 配信は JSR `@takos/takosumi-git-cli` 経由で
  `deno install -gA -n takosumi-git jsr:@takos/takosumi-git-cli`。
