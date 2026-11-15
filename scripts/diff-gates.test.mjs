// Run with `node --test scripts/*.test.mjs` — no dependencies, no network, no CLI download.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diff, gateArgs, gateMessage } from './diff-gates.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plune-gates-test-'));

// The env the action's diff step builds from its inputs, at the action's defaults.
const inputs = (over = {}) => ({
  PLUNE_FAIL_ON_REGRESSION: 'false',
  PLUNE_MAX_PASS_RATE_DROP_PERCENT: '',
  PLUNE_MAX_COST_USD: '',
  PLUNE_MAX_COST_INCREASE_PERCENT: '',
  PLUNE_MAX_TOKENS: '',
  PLUNE_WAIVERS: '',
  ...over,
});

// Stands in for the CLI: writes the report named by `-o` (unless `write` is false), then exits.
const cli = (status, { write = true, stderr = '', seen = [] } = {}) => (args) => {
  seen.push(args);
  if (write) fs.writeFileSync(args[args.indexOf('-o') + 1], '{}');
  return { status, stderr };
};

test('Eval action · gates · defaults pass no gate flag, so an older CLI runs as before', () => {
  assert.deepEqual(gateArgs(inputs()), []);
});

test('Eval action · gates · each input is passed only when set, as --flag=value', () => {
  assert.deepEqual(gateArgs(inputs({ PLUNE_MAX_COST_USD: ' 0.5 ' })), ['--max-cost-usd=0.5']);
  assert.deepEqual(
    gateArgs(
      inputs({
        PLUNE_FAIL_ON_REGRESSION: 'true',
        PLUNE_MAX_PASS_RATE_DROP_PERCENT: '5',
        PLUNE_MAX_COST_USD: '2',
        PLUNE_MAX_COST_INCREASE_PERCENT: '10',
        PLUNE_MAX_TOKENS: '100000',
        PLUNE_WAIVERS: '.plune/waivers 1.yaml',
      }),
    ),
    [
      '--fail-on-regression',
      '--max-pass-rate-drop-percent=5',
      '--max-cost-usd=2',
      '--max-cost-increase-percent=10',
      '--max-tokens=100000',
      '--waivers=.plune/waivers 1.yaml',
    ],
  );
});

test('Eval action · gates · a negative limit stays one argument, so the CLI rejects it (exit 2) instead of reading a flag', () => {
  assert.deepEqual(gateArgs(inputs({ PLUNE_MAX_TOKENS: '-1' })), ['--max-tokens=-1']);
});

test('Eval action · gates · each exit code has its own message, and 0 has none', () => {
  assert.equal(gateMessage(0), '');
  const m1 = gateMessage(1);
  const m2 = gateMessage(2);
  const m3 = gateMessage(3);
  assert.match(m1, /measured failure/);
  assert.match(m2, /input error/);
  assert.match(m3, /not measured/);
  assert.match(m3, /re-run/i);
  assert.match(m3, /not a regression/);
  assert.equal(new Set([m1, m2, m3]).size, 3);
  assert.match(gateMessage(127), /exited 127/);
});

test('Eval action · gates · an older CLI that does not know a flag is named as such, not as a failure', () => {
  const m = gateMessage(1, { stderr: "error: unknown option '--max-cost-usd=2'\n", version: '0.36.0' });
  assert.match(m, /@plune-ai\/cli 0\.36\.0 does not know the flag --max-cost-usd/);
  assert.doesNotMatch(m, /measured failure/);
});

test('Eval action · gates · diff runs markdown then JSON with the same gate flags and reports the exit code', () => {
  const dir = tmp();
  const seen = [];
  const res = diff(inputs({ RUNNER_TEMP: dir, PLUNE_MAX_TOKENS: '10' }), cli(1, { seen }));
  const pair = [path.join(dir, 'plune-baseline.json'), path.join(dir, 'plune-current.json')];
  assert.deepEqual(seen, [
    ['diff', ...pair, '--format', 'markdown', '-o', path.join(dir, 'plune-diff.md'), '--max-tokens=10'],
    ['diff', ...pair, '--format', 'json', '-o', path.join(dir, 'plune-diff.json'), '--max-tokens=10'],
  ]);
  assert.deepEqual(res, { outputs: { 'gate-exit-code': '1' } });
});

test('Eval action · gates · with no gate input the diff runs as before and gate-exit-code stays empty', () => {
  const dir = tmp();
  const seen = [];
  const res = diff(inputs({ RUNNER_TEMP: dir }), cli(0, { seen }));
  assert.ok(seen.every((args) => !args.some((a) => a.startsWith('--max') || a.startsWith('--waivers') || a === '--fail-on-regression')));
  assert.deepEqual(res, { outputs: { 'gate-exit-code': '' } });
});

test('Eval action · gates · no JSON report fails the step with the reason, and keeps the exit code', () => {
  const dir = tmp();
  const bad = diff(inputs({ RUNNER_TEMP: dir, PLUNE_WAIVERS: 'w.yaml' }), cli(2, { write: false }));
  assert.equal(bad.outputs['gate-exit-code'], '2');
  assert.match(bad.error, /input error/);

  const old = diff(
    inputs({ RUNNER_TEMP: tmp(), PLUNE_MAX_COST_USD: '1', PLUNE_VERSION: '0.36.0' }),
    cli(1, { write: false, stderr: "error: unknown option '--max-cost-usd=1'" }),
  );
  assert.match(old.error, /does not know the flag --max-cost-usd/);

  const none = diff(inputs({ RUNNER_TEMP: tmp() }), cli(1, { write: false }));
  assert.equal(none.outputs['gate-exit-code'], '');
  assert.match(none.error, /no JSON/);
});
