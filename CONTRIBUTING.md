# Contributing to plune-ai/eval-action

Thanks for your interest! This is a thin composite GitHub Action that wraps
[`@plune-ai/cli`](https://github.com/plune-ai/cli). It contains **no evaluation logic of its
own** — only the orchestration in `action.yml` and a small sticky-comment helper.

## What's here

- `action.yml` — the composite steps and the input/output contract.
- `scripts/upsert-comment.mjs` — posts and updates the sticky PR comment (the only runtime logic).
- `examples/` — copy-paste consumer workflows.

## Public contract

The Action's inputs and outputs are a **public contract**. Changing or removing one is a
breaking change: bump the major tag (`v1` → `v2`) and call it out in the release notes.

## Versioning

The Action tracks a moving major tag (`v1`) and internally pins a specific published
`@plune-ai/cli` version via the `cli`/`plune-version` input. Consumers should pin the Action to
a major tag, e.g. `plune-ai/eval-action@v1`.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/).

## Security

Please report vulnerabilities privately via this repository's **Security** tab, not public issues.
