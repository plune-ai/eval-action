// The steps of the MCP action (mcp/action.yml) that are more than one line of shell: turn the
// inputs into `plune mcp` arguments, start each command once, record the exit codes, and decide
// the gate. No check, classification or report text lives here: all of that comes from the CLI.
//
//   node mcp.mjs run    — validate the inputs, run the commands, write the step outputs
//   node mcp.mjs body   — the CLI's markdown reports as one text (PR comment and job summary)
//   node mcp.mjs gate   — fail the check, or warn, by the exit codes
//
// Every input arrives as an environment variable (PLUNE_MCP_*), never in the text of a script.
// Tested by mcp.test.mjs (`node --test scripts/*.test.mjs`).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export class InputError extends Error {}

// check first: its --wait is what waits for a server at a URL, and lint and diff have no such flag.
const ORDER = ['check', 'lint', 'diff'];
const LINT_FAIL_ON = ['error', 'warn', 'info', 'never'];
const DIFF_FAIL_ON = ['breaking', 'any', 'none'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// `Bearer ${{ secrets.X }}` without the secret is "Bearer ", not "": a scheme with nothing after it
// is as empty as no value at all.
const BARE_SCHEME = /^(bearer|basic|token)$/i;
const emptyCredential = (value) => {
  const v = (value ?? '').trim();
  return v === '' || BARE_SCHEME.test(v);
};

const words = (s) => (s ?? '').trim().split(/\s+/).filter(Boolean);
const list = (s) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const oneOf = (name, value, allowed) => {
  if (!allowed.includes(value)) throw new InputError(`${name} must be one of ${allowed.join(', ')} (got "${value}").`);
  return value;
};

/** The commands to start, each as the argument list after `plune mcp`, or an InputError. */
export function plan(env) {
  const steps = list(env.PLUNE_MCP_STEPS);
  if (steps.length === 0) throw new InputError(`steps must name at least one of ${ORDER.join(', ')}.`);
  for (const s of steps) oneOf('steps', s, ORDER);

  const command = words(env.PLUNE_MCP_SERVER_COMMAND);
  const url = (env.PLUNE_MCP_SERVER_URL ?? '').trim();
  if (command.length > 0 && url) throw new InputError('Set server-command or server-url, not both.');
  if (command.length === 0 && !url) throw new InputError('Set server-command or server-url.');

  const headers = list(env.PLUNE_MCP_HEADERS_FROM_ENV).map((entry) => {
    const eq = entry.indexOf('=');
    const name = entry.slice(0, eq).trim();
    const variable = entry.slice(eq + 1).trim();
    if (eq < 0 || !name || !ENV_NAME.test(variable))
      throw new InputError(`headers-from-env needs Header=ENV_VAR entries separated by commas (got "${entry}").`);
    return { name, variable };
  });
  if (headers.length > 0 && !url) throw new InputError('headers-from-env is for a server at server-url.');
  // Before anything starts: on a pull request from a fork the secret is not there, and an empty
  // credential must not go out. The name is printed, never a value.
  for (const { variable } of headers) {
    if (emptyCredential(env[variable]))
      throw new InputError(
        `headers-from-env: the variable ${variable} is not set or is empty (a pull request from a fork gets no secrets). Nothing was started.`,
      );
  }

  const failOn = oneOf('fail-on', (env.PLUNE_MCP_FAIL_ON ?? '').trim(), LINT_FAIL_ON);
  const diffFailOn = oneOf('diff-fail-on', (env.PLUNE_MCP_DIFF_FAIL_ON ?? '').trim(), DIFF_FAIL_ON);
  const snapshot = (env.PLUNE_MCP_SNAPSHOT_FILE ?? '').trim();
  if (steps.includes('diff') && !snapshot) throw new InputError('steps has diff, so snapshot-file is required.');
  const ignoreFile = (env.PLUNE_MCP_IGNORE_FILE ?? '').trim();

  const reportDir = path.join(env.RUNNER_TEMP, 'plune-mcp');
  const debugDir = env.PLUNE_MCP_DEBUG === 'true' ? path.join(env.RUNNER_TEMP, 'plune-mcp-debug') : undefined;
  const connection = url ? ['--url', url, ...headers.flatMap((h) => ['--header-env', `${h.name}=${h.variable}`])] : [];
  const server = command.length > 0 ? ['--', ...command] : [];

  const own = {
    check: [...(url ? ['--wait', (env.PLUNE_MCP_WAIT ?? '').trim() || '30s'] : []), ...(env.PLUNE_MCP_SMOKE === 'true' ? ['--smoke'] : [])],
    lint: ['--fail-on', failOn, ...(ignoreFile ? ['--ignore-file', ignoreFile] : [])],
    diff: ['--fail-on', diffFailOn],
  };
  const commands = ORDER.filter((name) => steps.includes(name)).map((name) => ({
    name,
    args: [
      name,
      ...(name === 'diff' ? [snapshot] : []),
      ...connection,
      ...own[name],
      // One run writes every form: annotations on stdout, the files for the comment and artifacts.
      '--format', 'github',
      '--out', `json=${reportDir}/${name}.json`,
      '--out', `junit-xml=${reportDir}/${name}.xml`,
      '--out', `markdown=${reportDir}/${name}.md`,
      ...(debugDir ? ['--debug-out', `${debugDir}/${name}.jsonl`] : []),
      ...server,
    ],
  }));
  return { commands, reportDir, debugDir };
}

/**
 * `npx @plune-ai/cli mcp <args>`. The arguments are passed to bash as an array after the script
 * (`"$@"`), never put into its text; npx builds its own command line and quotes them for its shell
 * (checked on Linux runners only; Windows runners not checked). bash rather than npx directly: it
 * is on every runner, and on Windows npx is a .cmd file that Node will not start without a shell.
 */
export function spawnPlune(args, env = process.env, script = 'exec npx -y "@plune-ai/cli@$PLUNE_VERSION" mcp "$@"', cwd) {
  const res = spawnSync('bash', ['-c', script, 'plune', ...args], { stdio: 'inherit', env, cwd });
  return res.status;
}

/** The step outputs for the exit codes of the commands that ran. */
export function results(exits) {
  const ran = ORDER.filter((name) => name in exits);
  const measured = ran.every((name) => exits[name] === 0 || exits[name] === 1);
  return {
    'check-exit': String(exits.check ?? ''),
    'lint-exit': String(exits.lint ?? ''),
    'diff-exit': String(exits.diff ?? ''),
    measured: String(measured),
    summary: ran.map((name) => `${name} exit ${exits[name]}`).join(', ') + (measured ? '' : '; not measured'),
  };
}

// The same rule as the CLI's own output: no line of server text may start a workflow command
// (the runner trims leading white space before `::`, and finds `##[` anywhere in a line).
const noCommands = (text) => text.replace(/^([\s\u0085]*)::/gm, '$1?::').replaceAll('##[', '##?[');

/**
 * The last lines the server wrote to stderr, as the command's JSON report recorded them (masked by
 * the CLI), for the step log: `--format github` does not print them, and a server that exits before
 * it answers `initialize` is exit 1 with its reason only in the report. Empty when the command
 * passed, wrote no report, or the server wrote nothing to stderr.
 */
export function stderrTail(reportDir, name, status) {
  if (status === 0) return '';
  let lines;
  try {
    lines = JSON.parse(fs.readFileSync(path.join(reportDir, `${name}.json`), 'utf8')).stderrTail;
  } catch {
    return '';
  }
  if (!Array.isArray(lines) || lines.length === 0) return '';
  const tail = lines.map((l) => `  ${noCommands(String(l)).replace(/\r\n?|\n/g, '\n  ')}\n`).join('');
  return `plune mcp ${name}: the last lines the server wrote to stderr (secrets masked):\n${tail}`;
}

export function run(env, spawn = (args) => spawnPlune(args), log = (text) => process.stdout.write(text)) {
  let p;
  try {
    p = plan(env);
  } catch (err) {
    if (!(err instanceof InputError)) throw err;
    return { error: err.message, outputs: { ...results({}), measured: 'false', summary: `input error: ${err.message}` } };
  }
  // A second use of the action in one job must not comment or upload the first one's reports.
  for (const dir of [p.reportDir, p.debugDir].filter(Boolean)) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  const exits = {};
  for (const { name, args } of p.commands) {
    const status = spawn(args);
    // The CLI writes its files before it exits 0, 1 or 3. No JSON report means no result from it at
    // all (npx could not install it, a signal killed it): an npm failure's exit 1 is not a finding.
    const wrote = fs.existsSync(path.join(p.reportDir, `${name}.json`));
    exits[name] = Number.isInteger(status) && (wrote || status === 2) ? status : 2;
    const tail = stderrTail(p.reportDir, name, exits[name]);
    if (tail) log(tail);
  }
  return { outputs: { ...results(exits), 'report-dir': p.reportDir } };
}

// GitHub's exact limit for a comment body is not confirmed in its docs (65 536 is the figure
// usually cited); 60 000 leaves room for the marker and the note.
export const COMMENT_LIMIT = 60000;

/**
 * The CLI's markdown reports in run order, as written; the comment's marker is added by the upsert.
 * With `limit`, a longer text is cut at the last whole line and ends with where the rest is. With
 * no report at all, a short text that says so: the comment must not keep an older run's verdict.
 */
export function commentBody(reportDir, summary, { limit, artifactName = 'plune-mcp-reports' } = {}) {
  const parts = ORDER.map((name) => path.join(reportDir, `${name}.md`))
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f, 'utf8'));
  if (parts.length === 0) return `### MCP\n\nThis run produced no report: ${summary}; see the job log.\n`;
  const text = parts.join('\n');
  if (!limit || text.length <= limit) return text;
  const note = `\n… the full report is in the job summary and the \`${artifactName}\` artifact\n`;
  const kept = text.slice(0, limit - note.length);
  return kept.slice(0, kept.lastIndexOf('\n') + 1) + note;
}

const WHY = {
  1: 'failed (exit 1): see its annotations and the report.',
  2: 'could not test the server (exit 2): it did not start, could not be reached, refused the credentials, or a flag is wrong. The step log has the reason.',
  3: 'measured nothing (exit 3): not measured is not clean.',
};

/** Errors fail the check; with fail-on never nothing does: exit 2 and 3 warn, exit 1 is a notice. */
export function gate(exits, failOn) {
  const errors = [];
  const warnings = [];
  const notices = [];
  for (const name of ORDER) {
    const code = exits[name];
    if (code === undefined || code === 0) continue;
    const message = `plune mcp ${name} ${WHY[code] ?? `exited ${code}.`}`;
    if (failOn !== 'never') errors.push(message);
    else if (code === 1) notices.push(`${message} Advisory: fail-on is never.`);
    else warnings.push(message);
  }
  return { errors, warnings, notices };
}

// Workflow-command escaping of a message (https://github.com/actions/toolkit, `escapeData`).
const escape = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function main(mode, env) {
  if (mode === 'run') {
    const res = run(env);
    fs.appendFileSync(
      env.GITHUB_OUTPUT,
      // One line each: an input error's text in `summary` must not start a second output.
      Object.entries(res.outputs).map(([k, v]) => `${k}=${String(v).replace(/[\r\n]+/g, ' ')}\n`).join(''),
    );
    if (res.error) {
      console.log(`::error::${escape(res.error)}`);
      return 1;
    }
    return 0;
  }
  if (mode === 'body') {
    // The job summary: the whole text, no cut (its limit is far above a comment's).
    process.stdout.write(commentBody(path.join(env.RUNNER_TEMP, 'plune-mcp'), env.PLUNE_MCP_SUMMARY || 'the run step did not finish'));
    return 0;
  }
  if (mode === 'gate') {
    const exits = {};
    for (const name of ORDER) {
      const v = env[`PLUNE_MCP_${name.toUpperCase()}_EXIT`];
      if (v) exits[name] = Number(v);
    }
    const { errors, warnings, notices } = gate(exits, env.PLUNE_MCP_FAIL_ON);
    for (const n of notices) console.log(`::notice::${escape(n)}`);
    for (const w of warnings) console.log(`::warning::${escape(w)}`);
    for (const e of errors) console.log(`::error::${escape(e)}`);
    return errors.length > 0 ? 1 : 0;
  }
  console.error(`usage: node mcp.mjs run|body|gate`);
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv[2], process.env);
}
