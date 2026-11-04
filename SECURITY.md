# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** — do not open a public issue.

Use GitHub's private vulnerability reporting on this repository: open the
[**Security**](https://github.com/plune-ai/eval-action/security/advisories/new) tab and choose
**Report a vulnerability**. We aim to acknowledge new reports within a few business days.

Please include the version you used, the steps to reproduce, and the impact you expect.

## Scope

This action runs in your CI, with the permissions and secrets you give the workflow. In scope:

- The composite action in [`action.yml`](action.yml) and the comment helper in
  [`scripts/upsert-comment.mjs`](scripts/upsert-comment.mjs)
- A token or secret (the workflow's `GITHUB_TOKEN`, or a model provider key passed through the
  environment when `use-mock` is `false`) printed to the log or sent anywhere other than its
  intended endpoint
- A workflow input (`config`, `working-directory`, `base-ref`, `plune-version`, ...) that can inject
  shell commands

## Out of scope

- Vulnerabilities in `@plune-ai/cli`, which this action installs from npm — please report those on
  the [cli repository](https://github.com/plune-ai/cli/security/advisories/new)
- Vulnerabilities in third-party actions or dependencies — please report those to the upstream project
- Workflows that pass untrusted input to this action in a way the workflow itself makes unsafe
- Costs incurred by calling a real model provider (the action uses the mock provider by default)
