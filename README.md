# Plune eval diff — GitHub Action

[![@plune-ai/cli](https://img.shields.io/npm/v/@plune-ai/cli?label=%40plune-ai%2Fcli)](https://www.npmjs.com/package/@plune-ai/cli)
[![license](https://img.shields.io/github/license/plune-ai/eval-action)](./LICENSE)

A thin GitHub Action that wraps the [`@plune-ai/cli`](https://github.com/plune-ai/cli) binary. On
every pull request it runs your Plune evals, compares the result against the base branch, and
leaves a single, updated comment with the **diff** — which evals regressed, which improved.
Optionally it fails the check when a regression is detected.

It contains **no evaluation logic of its own** — it orchestrates `plune run` and `plune diff`, so
the Action always behaves exactly like the CLI version it pins.

## Quick start

Add `.github/workflows/plune-eval.yml` to your repository:

```yaml
name: Plune eval diff

on:
  pull_request:
    branches: [main]

permissions:
  contents: read
  pull-requests: write # so the Action can post/update the sticky diff comment

jobs:
  plune:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # full history, so the Action can diff the PR against the base branch

      - uses: plune-ai/eval-action@v1
        with:
          config: plune.yaml
          base-ref: main
          # use-mock: 'true'           # default — zero-cost, deterministic, no API key
          # fail-on-regression: 'true' # uncomment to block merges on a pass→fail regression or an eval that could not be measured
```

With the safe defaults it runs on the **mock provider** — no API key, zero cost, fully
deterministic — and only comments (never blocks merges). You need a `plune.yaml` in your
repository; see [`@plune-ai/cli`](https://github.com/plune-ai/cli) to create one.

## What "regression" means

The diff classifies every eval by its transition between the base branch and the PR:

| Transition | Meaning | Gates? |
| --- | --- | --- |
| `passed → failed` | **regression** | yes (when `fail-on-regression: true`) |
| `failed → passed` | improvement | no |
| `failed → failed` | pre-existing failure | no |
| absent → failed | new failure | no |
| any → `errored` | **not measured**: the PR's run errored (for example the provider did not answer) | yes, as its own error (when `fail-on-regression: true`) |
| `errored → failed` | **not measured**: nothing on the base branch to compare against | yes, as its own error (when `fail-on-regression: true`) |
| `errored → passed` | improvement | no |

Only a genuine `passed → failed` transition is a regression — an eval already failing on the base
branch does not turn the check red.

An eval that was not measured is not a regression, but it was not checked either, so "no
regressions" would be a guess. With `fail-on-regression: true` the check fails with its own message
(`Plune could not measure N eval(s)…`). A provider that did not answer is cleared by re-running the
job; an eval that errors every time (for example an `llm-judge` assertion on the mock provider,
which has no judge to ask) keeps the check red until the eval is fixed — the run summary names its
error. The `has-regression`
output stays `false` in that case, and the `unmeasured` output carries the count. With an older
`plune-version` that does not report it, `unmeasured` is `0` and the action behaves as before.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `config` | `plune.yaml` | Path to your Plune config (relative to `working-directory`). |
| `working-directory` | `.` | Directory to run Plune in. |
| `base-ref` | `main` | Baseline git ref to compare against. |
| `use-mock` | `true` | Run on the built-in mock provider (no key, zero cost). Set `false` to use a real provider. |
| `fail-on-regression` | `false` | Fail the check (block merge) when a regression is detected, or when an eval could not be measured. |
| `comment` | `true` | Post and update a sticky PR comment with the diff. |
| `plune-version` | `0.34.6` | Version of `@plune-ai/cli` to install from npm. |

## Outputs

| Output | Description |
| --- | --- |
| `has-regression` | `true` when at least one regression was detected. |
| `regressions` | Number of regressions. |
| `unmeasured` | Number of evals that could not be measured (their run errored); `0` when everything was measured. |
| `summary` | One-line diff summary. |

## Run summary

Every run writes a human-readable summary (per-eval pass/fail, cost, latency, and — when a baseline
exists — the diff) to the [job summary](https://docs.github.com/actions/using-workflows/workflow-commands-for-github-actions#adding-a-job-summary)
on the Actions run page. Unlike the sticky PR comment, this is always visible — including on the
first eval PR (no baseline yet), re-runs, and `push`/scheduled runs that have no associated PR.

## Using a real provider

By default the Action uses the mock provider so PRs cost nothing and stay deterministic. To
evaluate against a real model, set `use-mock: 'false'` and provide the provider key from a
repository **secret** (never hard-code keys):

```yaml
      - uses: plune-ai/eval-action@v1
        with:
          use-mock: 'false'
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Keys are read only from the environment and are never printed to logs or included in the PR
comment.

## Fork pull requests

On PRs from forks, GitHub provides a read-only token, so the Action cannot post a comment. It
still runs the evals and computes the diff; the comment step is skipped with a notice rather than
failing. The Action never uses `pull_request_target` (which would expose secrets to untrusted PR
code).

## MCP server checks: `plune-ai/eval-action/mcp@v1`

A second action in this repository, in the `mcp/` folder, for MCP servers. On every pull request it
runs `plune mcp check`, `lint` and `diff` against your server and gives you:

- **annotations** on the run for every finding;
- **one PR comment**, updated in place on every run (apart from the eval-diff comment);
- the same report in the **job summary**, also when the check is red;
- the reports as an **artifact** (`<command>.json`, `<command>.xml` in JUnit, `<command>.md`);
- a **gate**: the check is red when something failed, when the server could not be tested, and
  when nothing was measured. Nothing measured is not a pass.

Like the root action it holds no check of its own: each command runs once in `@plune-ai/cli`, which
writes every report form in that one run; the action posts what the CLI wrote.

```yaml
permissions:
  contents: read
  pull-requests: write # only for the comment

jobs:
  mcp:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: plune-ai/eval-action/mcp@v1
        with:
          server-command: node dist/server.js
```

Full workflows: [`examples/mcp-stdio.yml`](./examples/mcp-stdio.yml) (a stdio server, `lint`,
`check` and `diff` against a committed snapshot) and [`examples/mcp-http.yml`](./examples/mcp-http.yml)
(an HTTP server started by an earlier step, `wait`, `headers-from-env`, and the fork recipe).

### Inputs

| Input | Default | Description |
| --- | --- | --- |
| `steps` | `lint,check` | Commands to run, comma-separated: `lint`, `check`, `diff`. They run in the order `check`, `lint`, `diff`. |
| `server-command` | | Command that starts a stdio server. Split on spaces: no quotes, no shell; for anything more, name a script in your repository. Not with `server-url`. |
| `server-url` | | URL of a Streamable HTTP server started by an earlier step. Not with `server-command`. |
| `wait` | `30s` | How long `check` keeps trying to reach `server-url`. Only `check` waits, so keep it in `steps` for a server that starts in the background. |
| `headers-from-env` | | `Header=ENV_VAR`, comma-separated. Each header's value is read from that variable, which you set in the `env:` of the step from a secret. Only with `server-url`. |
| `fail-on` | `error` | Lint threshold: `error`, `warn`, `info` or `never`. `never` makes the whole action advisory (see the table below). |
| `ignore-file` | | Lint exceptions file. |
| `snapshot-file` | | Committed snapshot (`plune mcp snapshot`) that `diff` compares the server with. Required when `steps` has `diff`. |
| `diff-fail-on` | `breaking` | Diff threshold: `breaking`, `any` or `none`. |
| `smoke` | `false` | `true` adds `--smoke` to `check`: each tool that says it is read-only and takes no argument is called once. |
| `comment` | `true` | Post and update one PR comment. All uses of the action in one PR share that comment: on a second use, set `comment: 'false'`. |
| `debug-artifact` | `false` | Also upload the frame journal of each command. It can hold what the tools returned, so it is off by default. |
| `artifact-name` | `plune-mcp-reports` | Name of the reports artifact. Give each use its own name when the action runs more than once in a workflow run (a matrix, two servers), and set `comment: 'false'` on all but one of them. |
| `working-directory` | `.` | Directory to run in; `server-command`, `ignore-file` and `snapshot-file` are relative to it. |
| `plune-version` | `0.34.6` | Version of `@plune-ai/cli` to install from npm. |

### Outputs

| Output | Description |
| --- | --- |
| `lint-exit`, `check-exit`, `diff-exit` | Exit code of each command; empty when it did not run. `2` as well when a command wrote no report at all (the CLI could not be installed or started). |
| `measured` | `true` when no command that ran exited `2` or `3`. |
| `summary` | One line: the exit code of each command that ran. |
| `report-dir` | Folder with the reports. |

### What each exit code does

| Exit | Meaning | Default | `fail-on: never` |
| --- | --- | --- | --- |
| `0` | Passed, and everything was measured. | green | green |
| `1` | A finding or a check failed (the annotations and the report name it). A server that started and exited before it answered `initialize` is a failed check: the log has the last lines of its stderr, secrets masked. | **red** | green, with a notice naming the command |
| `2` | The server could not be tested: its command was not found or could not be started, it could not be reached, refused the credentials, or a flag is wrong. The log has the last lines of its stderr, secrets masked. | **red** | green, with a warning; `measured=false` |
| `3` | Nothing was measured: no tools listed, nothing to compare, a check that could not run. | **red** | green, with a warning; `measured=false` |

A wrong input (both `server-command` and `server-url`, an unknown step, `diff` without
`snapshot-file`, an empty `headers-from-env` variable) stops the action with an error before
anything starts, whatever `fail-on` says.

`fail-on: never` makes every command of that use advisory, `diff` included: `diff-fail-on` still
decides what the report calls a failure, but the check stays green. For an advisory lint with a
blocking diff, use the action twice: one step with `steps: lint` and `fail-on: never`, one with
`steps: diff`, each with its own `artifact-name`, and `comment: 'false'` on one of them.

### Permissions

`contents: read` is enough. Add `pull-requests: write` only for the comment (`comment: true`, the
default); with `comment: 'false'` the action needs no write scope.

### Secrets and fork pull requests

The action reads no secret itself. A header value goes from your secret to an `env:` variable of the
step, and the CLI reads it from there: it is never on a command line, and the reports mask it
wherever the server repeats it.

Keep the whole header value in the secret (`Bearer <token>`) and pass it as is:
`MCP_AUTHORIZATION: ${{ secrets.MCP_AUTHORIZATION }}`. Written as `Bearer ${{ secrets.TOKEN }}`, a
missing secret would leave the variable at `Bearer `; the action treats a value that is only
`Bearer`, `Basic` or `Token` as empty too, but the plain form says what it means.

A pull request from a fork gets no secrets, and neither does one opened by Dependabot: its runs get
Dependabot secrets only, not Actions secrets
([GitHub docs](https://docs.github.com/en/code-security/dependabot/troubleshooting-dependabot/troubleshooting-dependabot-on-github-actions)).
When a variable named in `headers-from-env` is empty or unset, the action stops with an error that
names the variable, before it starts or contacts the server. For both, run a separate job without
secrets against a server that needs none, and keep the job with secrets to
`github.event.pull_request.head.repo.full_name == github.repository && github.actor != 'dependabot[bot]'`;
see [`examples/mcp-http.yml`](./examples/mcp-http.yml). On a fork the comment is skipped (the token is
read-only); the annotations, summary, artifacts and gate still work. The action never uses
`pull_request_target`.

## Versioning

- This Action tracks a moving **`v1`** tag — pin to it: `plune-ai/eval-action@v1`.
- The Action's version is **independent** of the CLI's. Internally it pins a specific published
  `@plune-ai/cli` version via the `plune-version` input.
- That pin always references a version already on npm. The two actions pin the same version and
  move together.

## License

[MIT](./LICENSE) © Plune Contributors
