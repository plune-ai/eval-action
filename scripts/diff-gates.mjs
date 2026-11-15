// The `plune diff` step of action.yml and its gate: pass the gate inputs on to the CLI and name its
// exit code. No comparison lives here: the CLI decides every gate and writes the «Gates» section.
//
//   node diff-gates.mjs diff  — run the markdown and JSON diffs with the gate flags, write gate-exit-code
//   node diff-gates.mjs gate  — fail the check by gate-exit-code, with a message per code
//
// Every input arrives as an environment variable (PLUNE_*), never in the text of a script.
// Tested by diff-gates.test.mjs (`node --test scripts/*.test.mjs`).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LIMITS = [
  ['PLUNE_MAX_PASS_RATE_DROP_PERCENT', '--max-pass-rate-drop-percent'],
  ['PLUNE_MAX_COST_USD', '--max-cost-usd'],
  ['PLUNE_MAX_COST_INCREASE_PERCENT', '--max-cost-increase-percent'],
  ['PLUNE_MAX_TOKENS', '--max-tokens'],
  ['PLUNE_WAIVERS', '--waivers'],
];

/**
 * The gate flags for `plune diff`, each only when its input is set: a CLI older than the gates
 * exits 1 on a flag it does not know. `--flag=value`, so a value such as `-1` reaches the CLI as a
 * value (and is rejected there, exit 2) rather than being read as a flag. Empty: no gate.
 */
export function gateArgs(env) {
  const args = env.PLUNE_FAIL_ON_REGRESSION === 'true' ? ['--fail-on-regression'] : [];
  for (const [name, flag] of LIMITS) {
    const value = (env[name] ?? '').trim();
    if (value) args.push(`${flag}=${value}`);
  }
  return args;
}

const WHY = {
  1: 'Plune found a measured failure on this PR (exit 1): a pass→fail regression, or a gate over its limit. The «Gates» section of the diff names it.',
  2: 'plune diff stopped on an input error (exit 2): a gate limit is not a number of 0 or more, the waivers file is missing or malformed, or a run result could not be read. The step log has the reason.',
  3: 'Something the gates need was not measured on this PR (exit 3), so there is no verdict, and not measured is not a pass. This is not a regression. An eval errored or none of its rows was judged: re-run the job if the provider did not answer; if the same eval errors every time (for example an llm-judge on the mock provider), the eval itself needs fixing. Or a gate has no value to compare (no price from the mock provider for a cost gate, runs that measured different evals for the pass rate). The «Gates» section of the diff says which.',
};

/** The error for an exit code of the gated diff; empty for 0. */
export function gateMessage(code, { stderr = '', version = '' } = {}) {
  if (code === 0) return '';
  const unknown = /unknown option '(--[^'=]+)/.exec(stderr);
  if (unknown)
    return `@plune-ai/cli ${version} does not know the flag ${unknown[1]}: the gate inputs need a newer plune-version.`;
  return WHY[code] ?? `plune diff exited ${code}. The step log has the reason.`;
}

/**
 * `npx @plune-ai/cli <args>` through bash, the arguments after the script (`"$@"`), never in its
 * text. stderr is kept to tell an unknown flag apart from a failure, and still printed.
 */
function spawnPlune(args, env = process.env) {
  const res = spawnSync('bash', ['-c', 'exec npx -y "@plune-ai/cli@$PLUNE_VERSION" "$@"', 'plune', ...args], {
    stdio: ['ignore', 'inherit', 'pipe'],
    encoding: 'utf8',
    env,
  });
  process.stderr.write(res.stderr ?? '');
  return { status: res.status, stderr: res.stderr ?? '' };
}

/** Both diffs, with the gate flags when any input is set; `gate-exit-code` is the JSON run's exit code. */
export function diff(env, spawn = spawnPlune) {
  const gate = gateArgs(env);
  const t = env.RUNNER_TEMP;
  const pair = [path.join(t, 'plune-baseline.json'), path.join(t, 'plune-current.json')];
  const json = path.join(t, 'plune-diff.json');
  spawn(['diff', ...pair, '--format', 'markdown', '-o', path.join(t, 'plune-diff.md'), ...gate]);
  const { status, stderr } = spawn(['diff', ...pair, '--format', 'json', '-o', json, ...gate]);
  const code = Number.isInteger(status) ? status : 2;
  const outputs = { 'gate-exit-code': gate.length > 0 ? String(code) : '' };
  // The CLI writes the report before it exits 0, 1 or 3; no report means it gave no result at all.
  if (fs.existsSync(json) && fs.statSync(json).size > 0) return { outputs };
  const why = gate.length > 0 ? gateMessage(code, { stderr, version: env.PLUNE_VERSION }) : '';
  return { outputs, error: `plune diff produced no JSON output (${json}).${why ? ' ' + why : ''}` };
}

// Workflow-command escaping of a message (https://github.com/actions/toolkit, `escapeData`).
const escape = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function main(mode, env) {
  if (mode === 'diff') {
    const res = diff(env);
    fs.appendFileSync(env.GITHUB_OUTPUT, Object.entries(res.outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
    if (!res.error) return 0;
    console.log(`::error::${escape(res.error)}`);
    return 1;
  }
  if (mode === 'gate') {
    const message = gateMessage(Number(env.PLUNE_GATE_EXIT_CODE));
    if (message) console.log(`::error::${escape(message)}`);
    return message ? 1 : 0;
  }
  console.error('usage: node diff-gates.mjs diff|gate');
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv[2], process.env);
}
