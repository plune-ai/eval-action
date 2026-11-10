// Run with `node --test scripts/*.test.mjs` — no dependencies, no network, no CLI download.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commentBody, gate, InputError, plan, results, run, spawnPlune } from './mcp.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plune-mcp-test-'));

// Stands in for the CLI: writes the JSON report named by `--out json=`, then exits with `code`.
const cli = (code, seen = []) => (args) => {
  seen.push(args[0]);
  const json = args.find((a) => a.startsWith('json='));
  fs.writeFileSync(json.slice('json='.length), '{}');
  return code;
};

// The env the action's run step builds from its inputs, at the action's defaults.
const inputs = (over = {}) => ({
  RUNNER_TEMP: '/tmp/rt',
  PLUNE_MCP_STEPS: 'lint,check',
  PLUNE_MCP_SERVER_COMMAND: 'node server.js',
  PLUNE_MCP_SERVER_URL: '',
  PLUNE_MCP_WAIT: '30s',
  PLUNE_MCP_HEADERS_FROM_ENV: '',
  PLUNE_MCP_FAIL_ON: 'error',
  PLUNE_MCP_IGNORE_FILE: '',
  PLUNE_MCP_SNAPSHOT_FILE: '',
  PLUNE_MCP_DIFF_FAIL_ON: 'breaking',
  PLUNE_MCP_SMOKE: 'false',
  PLUNE_MCP_DEBUG: 'false',
  ...over,
});

const report = (dir, cmd) => [
  '--format', 'github',
  '--out', `json=${dir}/${cmd}.json`,
  '--out', `junit-xml=${dir}/${cmd}.xml`,
  '--out', `markdown=${dir}/${cmd}.md`,
];

test('MCP action · inputs · defaults run check then lint against a stdio command, each with every report', () => {
  const p = plan(inputs());
  const dir = path.join('/tmp/rt', 'plune-mcp');
  assert.equal(p.reportDir, dir);
  assert.deepEqual(p.commands, [
    { name: 'check', args: ['check', ...report(dir, 'check'), '--', 'node', 'server.js'] },
    { name: 'lint', args: ['lint', '--fail-on', 'error', ...report(dir, 'lint'), '--', 'node', 'server.js'] },
  ]);
});

test('MCP action · inputs · server-command is split on white space, with no shell and no quotes', () => {
  const p = plan(inputs({ PLUNE_MCP_STEPS: 'check', PLUNE_MCP_SERVER_COMMAND: '  x;   echo  "pwned" $(id) ' }));
  assert.deepEqual(p.commands[0].args.slice(p.commands[0].args.indexOf('--')), ['--', 'x;', 'echo', '"pwned"', '$(id)']);
});

test('MCP action · inputs · server-url with headers, wait and smoke', () => {
  const p = plan(
    inputs({
      PLUNE_MCP_STEPS: 'check',
      PLUNE_MCP_SERVER_COMMAND: '',
      PLUNE_MCP_SERVER_URL: 'http://127.0.0.1:3000/mcp',
      PLUNE_MCP_HEADERS_FROM_ENV: 'Authorization=MCP_AUTH, X-Team = TEAM_ID',
      PLUNE_MCP_SMOKE: 'true',
      MCP_AUTH: 'Bearer s3cret-value',
      TEAM_ID: 't1',
    }),
  );
  const args = p.commands[0].args;
  assert.deepEqual(args.slice(0, 10), [
    'check', '--url', 'http://127.0.0.1:3000/mcp',
    '--header-env', 'Authorization=MCP_AUTH', '--header-env', 'X-Team=TEAM_ID',
    '--wait', '30s', '--smoke',
  ]);
  assert.ok(!args.includes('--'));
  assert.ok(!args.join(' ').includes('s3cret'), 'a header value never reaches the command line');
});

test('MCP action · inputs · wait goes to check only, and only for a server at a URL', () => {
  const stdio = plan(inputs());
  assert.ok(!stdio.commands.some((c) => c.args.includes('--wait')));
  const http = plan(inputs({ PLUNE_MCP_SERVER_COMMAND: '', PLUNE_MCP_SERVER_URL: 'http://h/mcp' }));
  assert.deepEqual(http.commands.map((c) => c.args.includes('--wait')), [true, false]);
});

test('MCP action · inputs · diff runs against the snapshot file with its own threshold', () => {
  const p = plan(inputs({ PLUNE_MCP_STEPS: 'diff', PLUNE_MCP_SNAPSHOT_FILE: 'mcp-snapshot.json', PLUNE_MCP_DIFF_FAIL_ON: 'any' }));
  assert.deepEqual(p.commands[0].args.slice(0, 4), ['diff', 'mcp-snapshot.json', '--fail-on', 'any']);
});

test('MCP action · inputs · the ignore file goes to lint', () => {
  const p = plan(inputs({ PLUNE_MCP_STEPS: 'lint', PLUNE_MCP_IGNORE_FILE: 'plune-mcp-ignore.yaml' }));
  assert.deepEqual(p.commands[0].args.slice(0, 5), ['lint', '--fail-on', 'error', '--ignore-file', 'plune-mcp-ignore.yaml']);
});

test('MCP action · inputs · debug-artifact adds a frame journal per command', () => {
  const p = plan(inputs({ PLUNE_MCP_STEPS: 'check', PLUNE_MCP_DEBUG: 'true' }));
  const dir = path.join('/tmp/rt', 'plune-mcp-debug');
  assert.equal(p.debugDir, dir);
  assert.ok(p.commands[0].args.join(' ').includes(`--debug-out ${dir}/check.jsonl`));
  assert.equal(plan(inputs()).debugDir, undefined);
});

test('MCP action · inputs · order is fixed (check first, so --wait covers the rest), duplicates dropped', () => {
  const p = plan(inputs({ PLUNE_MCP_STEPS: 'diff, lint,check,lint', PLUNE_MCP_SNAPSHOT_FILE: 's.json' }));
  assert.deepEqual(p.commands.map((c) => c.name), ['check', 'lint', 'diff']);
});

const refused = [
  ['server-command and server-url together', { PLUNE_MCP_SERVER_URL: 'http://h/mcp' }, /not both/],
  ['neither server-command nor server-url', { PLUNE_MCP_SERVER_COMMAND: ' ' }, /server-command or server-url/],
  ['an unknown step', { PLUNE_MCP_STEPS: 'lint,snapshot' }, /steps.*snapshot/],
  ['no step', { PLUNE_MCP_STEPS: ' , ' }, /steps/],
  ['diff without a snapshot file', { PLUNE_MCP_STEPS: 'diff' }, /snapshot-file/],
  ['an unknown fail-on', { PLUNE_MCP_FAIL_ON: 'warning' }, /fail-on/],
  ['an unknown diff-fail-on', { PLUNE_MCP_DIFF_FAIL_ON: 'never' }, /diff-fail-on/],
  ['headers-from-env with a stdio server', { PLUNE_MCP_HEADERS_FROM_ENV: 'Authorization=MCP_AUTH', MCP_AUTH: 'x' }, /server-url/],
  ['a malformed headers-from-env entry', { PLUNE_MCP_SERVER_COMMAND: '', PLUNE_MCP_SERVER_URL: 'http://h/mcp', PLUNE_MCP_HEADERS_FROM_ENV: 'Authorization' }, /Header=ENV_VAR/],
];
for (const [what, over, message] of refused) {
  test(`MCP action · inputs · refuses ${what}`, () => {
    assert.throws(() => plan(inputs(over)), (err) => err instanceof InputError && message.test(err.message));
  });
}

for (const [what, value] of [['empty', ''], ['unset', undefined]]) {
  test(`MCP action · inputs · a headers-from-env variable that is ${what} is refused by name, before anything starts`, () => {
    const env = inputs({ PLUNE_MCP_SERVER_COMMAND: '', PLUNE_MCP_SERVER_URL: 'http://h/mcp', PLUNE_MCP_HEADERS_FROM_ENV: 'Authorization=MCP_AUTH' });
    if (value !== undefined) env.MCP_AUTH = value;
    let spawned = 0;
    const out = tmp();
    const res = run({ ...env, RUNNER_TEMP: out }, () => spawned++);
    assert.equal(spawned, 0);
    assert.equal(res.error.includes('MCP_AUTH'), true);
    assert.equal(res.outputs.measured, 'false');
    assert.match(res.outputs.summary, /^input error: headers-from-env: the variable MCP_AUTH/);
  });
}

for (const value of ['Bearer ', ' ', 'bearer', 'Basic', 'token  ']) {
  test(`MCP action · inputs · a headers-from-env variable holding only "${value}" counts as empty and is refused by name`, () => {
    const env = inputs({ PLUNE_MCP_SERVER_COMMAND: '', PLUNE_MCP_SERVER_URL: 'http://h/mcp', PLUNE_MCP_HEADERS_FROM_ENV: 'Authorization=MCP_AUTH', MCP_AUTH: value });
    assert.throws(() => plan(env), (err) => err instanceof InputError && /MCP_AUTH is not set or is empty/.test(err.message));
  });
}

test('MCP action · inputs · a scheme with a credential after it is not empty', () => {
  const env = inputs({ PLUNE_MCP_SERVER_COMMAND: '', PLUNE_MCP_SERVER_URL: 'http://h/mcp', PLUNE_MCP_HEADERS_FROM_ENV: 'Authorization=MCP_AUTH', MCP_AUTH: 'Bearer x' });
  assert.equal(plan(env).commands.length, 2);
});

test('MCP action · run · each command is started exactly once, whatever the number of report forms', () => {
  const calls = [];
  const rt = tmp();
  const res = run(inputs({ RUNNER_TEMP: rt, PLUNE_MCP_STEPS: 'lint,check,diff', PLUNE_MCP_SNAPSHOT_FILE: 's.json' }), cli(0, calls));
  assert.deepEqual(calls, ['check', 'lint', 'diff']);
  assert.deepEqual(res.outputs, {
    'check-exit': '0', 'lint-exit': '0', 'diff-exit': '0',
    measured: 'true', summary: 'check exit 0, lint exit 0, diff exit 0',
    'report-dir': path.join(rt, 'plune-mcp'),
  });
});

test('MCP action · run · a command killed by a signal counts as exit 2', () => {
  const res = run(inputs({ RUNNER_TEMP: tmp(), PLUNE_MCP_STEPS: 'check' }), () => null);
  assert.equal(res.outputs['check-exit'], '2');
  assert.equal(res.outputs.measured, 'false');
});

test('MCP action · run · a stale report from an earlier run in the job is removed first', () => {
  const rt = tmp();
  fs.mkdirSync(path.join(rt, 'plune-mcp'));
  fs.writeFileSync(path.join(rt, 'plune-mcp', 'diff.md'), 'stale');
  run(inputs({ RUNNER_TEMP: rt, PLUNE_MCP_STEPS: 'check' }), cli(0));
  assert.equal(fs.existsSync(path.join(rt, 'plune-mcp', 'diff.md')), false);
});

test('MCP action · run · a command that wrote no report (the CLI did not install or start) counts as exit 2', () => {
  const res = run(inputs({ RUNNER_TEMP: tmp(), PLUNE_MCP_STEPS: 'check,lint' }), (args) => (args[0] === 'check' ? cli(1)(args) : 1));
  assert.equal(res.outputs['check-exit'], '1');
  assert.equal(res.outputs['lint-exit'], '2');
  assert.equal(res.outputs.measured, 'false');
});

test('MCP action · results · measured is false on exit 2 or 3, and not run is an empty output', () => {
  assert.deepEqual(results({ check: 0, lint: 1 }), {
    'check-exit': '0', 'lint-exit': '1', 'diff-exit': '',
    measured: 'true', summary: 'check exit 0, lint exit 1',
  });
  assert.equal(results({ check: 0, lint: 3 }).measured, 'false');
  assert.equal(results({ check: 2 }).measured, 'false');
  assert.equal(results({ check: 0, lint: 3 }).summary, 'check exit 0, lint exit 3; not measured');
});

test('MCP action · gate · any exit 1, 2 or 3 fails at the default threshold', () => {
  assert.deepEqual(gate({ check: 0, lint: 0 }, 'error'), { errors: [], warnings: [], notices: [] });
  for (const code of [1, 2, 3]) {
    const g = gate({ check: 0, lint: code }, 'error');
    assert.equal(g.errors.length, 1, `exit ${code}`);
    assert.match(g.errors[0], new RegExp(`plune mcp lint .*exit ${code}`));
  }
  assert.match(gate({ lint: 3 }, 'warn').errors[0], /measured nothing/);
});

test('MCP action · gate · fail-on never is advisory: exit 1 is a notice by command, exit 2 and 3 warn', () => {
  const advisory = gate({ check: 0, lint: 0, diff: 1 }, 'never');
  assert.deepEqual([advisory.errors, advisory.warnings], [[], []]);
  assert.equal(advisory.notices.length, 1);
  assert.match(advisory.notices[0], /^plune mcp diff failed \(exit 1\)/);
  const g = gate({ check: 2, lint: 3 }, 'never');
  assert.equal(g.errors.length, 0);
  assert.equal(g.warnings.length, 2);
  assert.match(g.warnings[0], /check .*exit 2/);
  assert.match(g.warnings[1], /lint .*measured nothing/);
});

test('MCP action · comment · joins the CLI reports in run order, or says why there is none', () => {
  const dir = tmp();
  assert.equal(commentBody(dir, 'input error: x'), '### MCP\n\nThis run produced no report: input error: x; see the job log.\n');
  fs.writeFileSync(path.join(dir, 'lint.md'), '<!-- plune-mcp-lint -->\nL\n');
  fs.writeFileSync(path.join(dir, 'check.md'), '<!-- plune-mcp-check -->\nC\n');
  assert.equal(commentBody(dir, 'x'), '<!-- plune-mcp-check -->\nC\n\n<!-- plune-mcp-lint -->\nL\n');
});

test('MCP action · comment · a body over the limit is cut at a line, with a pointer to the full report', () => {
  const dir = tmp();
  const line = `| failed | error | rule | tool | ${'x'.repeat(80)} |\n`;
  fs.writeFileSync(path.join(dir, 'lint.md'), '<!-- plune-mcp-lint -->\n' + line.repeat(1000));
  const body = commentBody(dir, 'x', { limit: 60000, artifactName: 'my-reports' });
  assert.ok(body.length <= 60000, `length ${body.length}`);
  assert.ok(body.startsWith('<!-- plune-mcp-lint -->\n'));
  assert.ok(body.endsWith('\n\n… the full report is in the job summary and the `my-reports` artifact\n'));
  assert.match(body.split('\n').at(-4), /^\| failed .* \|$/, 'the last kept line is whole');
  // The job summary takes the whole text.
  assert.equal(commentBody(dir, 'x').length, '<!-- plune-mcp-lint -->\n'.length + line.length * 1000);
});

test('MCP action · spawn · arguments reach the program verbatim through bash', () => {
  const dir = tmp();
  const out = path.join(dir, 'argv.txt');
  const args = ['check', '--', 'x;', 'touch', path.join(dir, 'pwned'), '$(touch pwned2)', '`id`'];
  const code = spawnPlune(args, { OUT: out }, 'printf "%s\\n" "$@" > "$OUT"', dir);
  assert.equal(code, 0);
  assert.deepEqual(fs.readFileSync(out, 'utf8').split('\n').slice(0, -1), args);
  assert.equal(fs.existsSync(path.join(dir, 'pwned')), false);
  assert.equal(fs.existsSync(path.join(dir, 'pwned2')), false);
});
