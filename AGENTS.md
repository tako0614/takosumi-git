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
│   ├── cli/                 @takos/takosumi-git-cli — `takosumi-git push` / `takosumi-git serve` 等
│   ├── workflow-contract/   (Phase 2 follow-up) workflow / event 型契約
│   ├── workflow-runner/     (Phase 2 follow-up) workflow execution (build / artifact)
│   ├── git-source/          (Phase 2 follow-up) git watch / webhook 受信
│   └── all/                 (Phase 2 follow-up) @takos/takosumi-git umbrella
└── README.md
```

Phase 2 skeleton では `deploy-client` と `cli` の 2 package のみ存在する stub
状態。残り package は Phase 2 follow-up commit で追加する。

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

| Package                                 | Version | 内容                                             |
| --------------------------------------- | ------- | ------------------------------------------------ |
| `@takos/takosumi-git-deploy-client`     | 0.0.1+  | takosumi `POST /v1/deployments` HTTP client      |
| `@takos/takosumi-git-cli`               | 0.0.1+  | CLI (`takosumi-git push` / `serve` 等)           |
| `@takos/takosumi-git-workflow-contract` | TBD     | workflow YAML / event 型契約 (Phase 2 follow-up) |
| `@takos/takosumi-git-workflow-runner`   | TBD     | workflow execution (Phase 2 follow-up)           |
| `@takos/takosumi-git-source`            | TBD     | git watch / webhook 受信 (Phase 2 follow-up)     |
| `@takos/takosumi-git`                   | TBD     | umbrella (上記を re-export)                      |

## 想定 CLI

```bash
takosumi-git push                     # repo の .takosumi/manifest.yml + workflow を解決して takosumi に投下
takosumi-git serve --webhook          # git webhook を受け、自動で push 実行
takosumi-git history                  # git history = manifest version 履歴を表示
```

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
