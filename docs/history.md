# History

> Stability: v1 Audience: workflow author, operator Owner: takosumi-git

`takosumi-git history` reads git history for `.takosumi/manifest.yml`. It does
not contact the Takosumi kernel and it does not inspect deployment records.

## Manifest History

```bash
takosumi-git history
```

The default output is one line per manifest commit:

```text
<short-sha>  <committed-at>  <subject>
```

Use `--manifest <path>` when your takosumi-git manifest is not the default
`.takosumi/manifest.yml`, and `--limit <n>` to bound the number of commits read.

## Resource Diff

```bash
takosumi-git history --resource web
```

Resource mode parses each manifest revision, finds `resources[].name == "web"`,
normalizes that resource to stable YAML, and prints a semantic line diff between
adjacent manifest revisions. This avoids raw YAML noise from unrelated resource
ordering or formatting changes while still showing the actual manifest shape
that changed.
