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
          # fail-on-regression: 'true' # uncomment to block merges on a pass→fail regression
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
| `errored` (either side) | execution error, not a quality change | no |

Only a genuine `passed → failed` transition is a regression — an eval already failing on the base
branch does not turn the check red.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `config` | `plune.yaml` | Path to your Plune config (relative to `working-directory`). |
| `working-directory` | `.` | Directory to run Plune in. |
| `base-ref` | `main` | Baseline git ref to compare against. |
| `use-mock` | `true` | Run on the built-in mock provider (no key, zero cost). Set `false` to use a real provider. |
| `fail-on-regression` | `false` | Fail the check (block merge) when a regression is detected. |
| `comment` | `true` | Post and update a sticky PR comment with the diff. |
| `plune-version` | `0.2.0` | Version of `@plune-ai/cli` to install from npm. |

## Outputs

| Output | Description |
| --- | --- |
| `has-regression` | `true` when at least one regression was detected. |
| `regressions` | Number of regressions. |
| `summary` | One-line diff summary. |

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
