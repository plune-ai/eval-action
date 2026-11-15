// Run with `node --test scripts/` — no dependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMENT_BUDGET, MARKER, fitComment, upsertStickyComment } from './upsert-comment.mjs';

const NOTE = /^_\d+ more lines? in the job summary_$/;
// A body of `n` lines of `w` characters each, under the marker.
const body = (n, w = 99) => [MARKER, ...Array.from({ length: n }, (_, i) => `row ${i}`.padEnd(w, '.'))].join('\n');

test('comment size · the budget is 60,000, under the commonly cited 65,536 (not confirmed by documentation)', () => {
  assert.equal(COMMENT_BUDGET, 60_000);
});

test('comment size · a marker sharing its line with a huge text still gives a body within the budget, marker first', () => {
  const text = MARKER + 'x'.repeat(70_000) + '\nlast';
  const out = fitComment(text, MARKER);
  assert.ok(out.length <= COMMENT_BUDGET, `length ${out.length}`);
  const lines = out.split('\n');
  assert.equal(lines[0], MARKER);
  assert.match(lines.at(-1), NOTE);
});

test('comment size · a body exactly at the budget is left alone', () => {
  const text = MARKER + '\n' + 'x'.repeat(COMMENT_BUDGET - MARKER.length - 1);
  assert.equal(text.length, COMMENT_BUDGET);
  assert.equal(fitComment(text, MARKER), text);
});

test('comment size · one character over is cut by whole lines, marker first, a closing line says where the rest is', () => {
  const text = body(3, 20) + '\n' + 'y'.repeat(COMMENT_BUDGET - 80);
  assert.ok(text.length > COMMENT_BUDGET);
  const out = fitComment(text, MARKER);
  assert.ok(out.length <= COMMENT_BUDGET);
  const lines = out.split('\n');
  assert.equal(lines[0], MARKER);
  assert.match(lines.at(-1), NOTE);
  // Whole lines only: every kept line is a line of the original.
  for (const l of lines.slice(0, -1)) assert.ok(text.split('\n').includes(l));
});

test('comment size · one line over the budget loses exactly that line', () => {
  const lines = body(700).split('\n');
  const text = lines.join('\n');
  assert.ok(text.length > COMMENT_BUDGET);
  const out = fitComment(text, MARKER).split('\n');
  assert.match(out.at(-1), NOTE);
  const kept = out.length - 1;
  assert.deepEqual(out.slice(0, -1), lines.slice(0, kept));
  assert.equal(Number(out.at(-1).match(/\d+/)[0]), lines.length - kept);
  // The next line would not have fitted.
  assert.ok(out.join('\n').length + lines[kept].length + 1 > COMMENT_BUDGET || kept === lines.length);
});

test('comment size · the marker survives even when it is not on the first line', () => {
  const text = 'z'.repeat(70_000) + '\n' + MARKER + '\n' + 'tail';
  const out = fitComment(text, MARKER);
  assert.ok(out.startsWith(MARKER));
  assert.ok(out.length <= COMMENT_BUDGET);
});

test('comment size · a custom marker is kept first too', () => {
  const m = '<!-- plune-mcp -->';
  const out = fitComment(m + '\n' + ('w'.repeat(99) + '\n').repeat(1000), m);
  assert.ok(out.startsWith(m + '\n'));
  assert.match(out.split('\n').at(-1), NOTE);
});

test('comment size · upsert posts the cut body, not the whole one', async () => {
  const sent = [];
  const github = { rest: { issues: {
    listComments: async () => ({ data: [] }),
    createComment: async ({ body: b }) => void sent.push(b),
  } } };
  await upsertStickyComment(github, { repo: { owner: 'o', repo: 'r' }, issue: { number: 1 } }, body(2000));
  assert.equal(sent.length, 1);
  assert.ok(sent[0].length <= COMMENT_BUDGET);
  assert.ok(sent[0].startsWith(MARKER));
});

test('comment size · a body under the budget goes out as it came', async () => {
  const sent = [];
  const github = { rest: { issues: {
    listComments: async () => ({ data: [] }),
    createComment: async ({ body: b }) => void sent.push(b),
  } } };
  const text = body(10);
  await upsertStickyComment(github, { repo: { owner: 'o', repo: 'r' }, issue: { number: 1 } }, text);
  assert.equal(sent[0], text);
});
