# AGENTS.md — takosumi-git

This repository is **takosumi-git**, the canonical Git URL installer and
`.takosumi/` convention implementation. It also provides an optional git ↔
takosumi bridge for raw deploy workflows. It sits above the
[`takosumi`](https://github.com/tako0614/takosumi) PaaS kernel and submits
manifests to it via `POST /v1/deployments`. The kernel's `POST /v1/deployments`
is the **canonical deploy entry point**. Git URL install / upgrade / rollback
through `.takosumi/app.yml` uses this repository as the canonical installer
implementation. CLI direct call, GitHub Actions, custom CI, and operator scripts
remain equally valid clients for raw unmanaged deploys. It is generic and
takos-neutral.

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

全 6 package が存在する。`takosumi-git push` は実装済 (takosumi v1 manifest
envelope を `.takosumi/manifest.yml` から読み、`resources[i].workflowRef`
で参照される workflow を実行し、artifact URI を該当 entry の `spec.image` field
に embed して `workflowRef` を strip した上で takosumi の `POST /v1/deployments`
に投下する)。`install` は `.takosumi/app.yml` を preview/apply し、Takosumi
Accounts AppInstallation 作成、任意の kernel deploy、status patch まで扱う。
`history` は manifest git history と resource semantic diff を表示する。`serve`
は GitHub / GitLab / Gitea webhook receiver と install preview/apply HTTP API を
提供する。

## 基本方針

- **Canonical Git installer, optional raw deploy helper**: 本 product は Git URL
  install / `.takosumi/` convention の正本実装です。raw unmanaged deploy では
  kernel `POST /v1/deployments` への 1 client にすぎず、第三者は GitHub
  Actions、 自前 CI、`takosumi deploy` CLI 等で本 product を bypass できます。
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
- **`.takosumi/` directory は本 product が管理**: 本 product は
  `.takosumi/manifest.yml` を読み、workflow / artifact URI を解決する。installer
  placeholder は Accounts materialization 後の deploy request build で解決し、
  `workflowRef` を strip した compiled manifest payload だけを kernel に submit
  する。`.takosumi/workflows/*.yml` 等は本 product が parse / 実行し、kernel
  には渡さない。
- **Generic installer**: 本 repo は Takosumi の generic PaaS contract
  (`.takosumi/` convention) を target にする canonical installer
  であり、takos-app / takos-git / Takos 固有 service ID への直接依存は core
  から作らない。

## JSR publish layout (planned)

| Package                                 | Version | 内容                                                                                                                     |
| --------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `@takos/takosumi-git-deploy-client`     | 0.0.1   | takosumi `POST /v1/deployments` HTTP client                                                                              |
| `@takos/takosumi-git-cli`               | 0.3.0   | CLI (`takosumi-git init` / `push` / `install` / `upgrade` / `rollback` / `materialize` / `export` / `serve` / `history`) |
| `@takos/takosumi-git-workflow-contract` | 0.0.1   | workflow YAML / event 型契約 (`ComputeWorkflowRef` 含む)                                                                 |
| `@takos/takosumi-git-workflow-runner`   | 0.0.1   | workflow execution (StepExecutor / ArtifactResolver 注入式)                                                              |
| `@takos/takosumi-git-source`            | 0.0.1   | git push / webhook → WorkflowEvent normalization                                                                         |
| `@takos/takosumi-git`                   | 0.0.1   | umbrella (上記を re-export)                                                                                              |

## .takosumi/ project convention

`.takosumi/` directory convention は **takosumi-git の正本**である。takosumi
kernel は manifest を explicit path / HTTP body で受け取るのみで、file layout
について opinion を持たない。`.takosumi/` を「Google Play 的に application
として deploy できる」project layout として確立するのは本 product の責務である。

Project layout:

```
<repo>/
├── .takosumi/
│   ├── app.yml              ← InstallableApp metadata for install preview/apply
│   ├── manifest.yml         ← authoring deploy intent read by takosumi-git
│   └── workflows/           ← workflow YAML referenced by resources[i].workflowRef
│       └── *.yml
```

`resources[i].workflowRef: { file, job, artifact }` は takosumi v1 manifest
entry に sibling として置く takosumi-git の private extension。takosumi-git が
parse / resolve に使い、kernel に submit する前に必ず strip する (kernel は
closed shape の `ManifestResource` で unknown field を reject
するため)。解決された artifact URI は 当該 entry の `spec.image` に substitute
される。

Quick start:

```bash
takosumi-git init                                              # .takosumi/ を scaffold
$EDITOR .takosumi/app.yml                                      # install metadata / bindings / permissions を編集
$EDITOR .takosumi/manifest.yml                                 # resources / image URI policy を編集
takosumi-git push --endpoint <url> --token <token>             # takosumi に投下
```

Note: `takosumi-git init` is the analog of the older `takosumi init --project`
flow from the era when manifest auto-discovery lived in the takosumi kernel CLI.
That auto-discovery has been removed from the kernel; the `.takosumi/`
convention now lives here exclusively.

## 想定 CLI

```bash
takosumi-git init [options]           # .takosumi/app.yml + manifest.yml + workflows/build.yml を scaffold
takosumi-git push [options]           # repo の .takosumi/manifest.yml + workflow を解決して takosumi に投下
takosumi-git install preview          # .takosumi/app.yml から install preview を生成
takosumi-git install apply            # Takosumi Accounts に AppInstallation を作成
takosumi-git upgrade <id> --ref <ref> # AppInstallation の source revision を preview / apply
takosumi-git rollback <id> --to <ref> # AppInstallation の previous ref への rollback を preview / apply
takosumi-git materialize <id>          # shared-cell から dedicated runtime への materialize を request
takosumi-git export <id>               # self-host bundle export operation を request
takosumi-git serve --webhook          # git webhook と install preview/apply API を受ける
takosumi-git history                  # git history = manifest version 履歴を表示
```

`init` の主な flag:

```
--cwd <dir>                  project root to scaffold into (default .)
--name <appname>             metadata.name in the manifest (default: basename of cwd)
--force                      overwrite existing .takosumi/manifest.yml
```

`push` の主な flag:

```
--endpoint <url>             takosumi kernel endpoint (or TAKOSUMI_ENDPOINT)
--token <token>              bearer token (or TAKOSUMI_TOKEN)
--manifest <path>            manifest YAML (default .takosumi/manifest.yml)
--workflows-dir <path>       workflows dir (default .takosumi/workflows)
--mode <apply|plan|destroy>  deploy mode (bundled apply)
--artifact-contract <v0|v1|auto> artifact URI resolver (default v1)
--dry-run                    workflow を実行するが POST はせず resolved manifest を出力
```

`resources[i].workflowRef: { file, job, artifact }` は takosumi-git
の私的拡張で、 kernel に submit する前に必ず strip される (kernel の
`ManifestResource` は closed shape)。解決後の URI は同 entry の `spec.image`
に書き込まれる。artifact URI は v1 contract として `TAKOSUMI_ARTIFACT=<uri>`
stdout marker を採用する。v0 の最後の非空 stdout 行 contract は
`--artifact-contract v0` / `auto` で legacy fallback として残す。詳細は
[`docs/artifact-contract.md`](./docs/artifact-contract.md) を参照。

## Lint / Format / Test 共通設定

- Lint: `deno task lint`
- Format: `deno task fmt`
- Format check: `deno task fmt:check`
- Test: `deno task test`
- Type check: `deno task check`

## Docs 方針

現時点では standalone docs site を持たず、`docs/*.md` を GitHub / JSR package
同梱 Markdown として publish-ready に保つ。最低限の正本 docs は
`docs/quickstart.md`、`docs/workflow-ref.md`、`docs/artifact-contract.md`、
`docs/history.md`、`docs/serve.md`、`docs/install.md`。 VitePress 等の docs site
化は JSR publish 後の follow-up とする。

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
