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
| `plune-version` | `0.34.3` | Version of `@plune-ai/cli` to install from npm. |

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

## Versioning

- This Action tracks a moving **`v1`** tag — pin to it: `plune-ai/eval-action@v1`.
- The Action's version is **independent** of the CLI's. Internally it pins a specific published
  `@plune-ai/cli` version via the `plune-version` input.
- That pin always references a version already on npm.

## License

[MIT](./LICENSE) © Plune Contributors
