// Run with `node --test scripts/` — no dependencies. The fake client stands in for the octokit that
// `actions/github-script` injects: one PR, its comments in memory, the same page size as the API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKER, upsertStickyComment } from './upsert-comment.mjs';

function fakeGithub(comments = [], { failWith } = {}) {
  const calls = { list: 0, create: 0, update: 0 };
  let nextId = 1000;
  const fail = () => {
    if (failWith) throw Object.assign(new Error(`HTTP ${failWith}`), { status: failWith });
  };
  const github = {
    rest: {
      issues: {
        async listComments({ per_page = 30, page = 1 }) {
          calls.list++;
          fail();
          const size = Math.min(per_page, 100);
          return { data: comments.slice((page - 1) * size, page * size) };
        },
        async createComment({ body }) {
          calls.create++;
          fail();
          const c = { id: nextId++, body };
          comments.push(c);
          return { data: c };
        },
        async updateComment({ comment_id, body }) {
          calls.update++;
          fail();
          comments.find((c) => c.id === comment_id).body = body;
          return { data: {} };
        },
      },
    },
  };
  return { github, comments, calls };
}

const context = { repo: { owner: 'o', repo: 'r' }, issue: { number: 7 } };
const filler = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, body: `comment ${i + 1}` }));

test('upsertStickyComment · default marker · creates once, then updates the same comment', async () => {
  const { github, comments } = fakeGithub();
  const body = `${MARKER}\nfirst`;
  assert.equal((await upsertStickyComment(github, context, body)).action, 'created');
  const second = await upsertStickyComment(github, context, `${MARKER}\nsecond`);
  assert.equal(second.action, 'updated');
  assert.equal(comments.length, 1);
  assert.equal(comments[0].body, `${MARKER}\nsecond`);
});

test('upsertStickyComment · default marker · is the eval-diff marker, unchanged', () => {
  assert.equal(MARKER, '<!-- plune-eval-diff -->');
});

test('upsertStickyComment · two markers · keep two independent comments in one PR', async () => {
  const { github, comments } = fakeGithub();
  const mcp = '<!-- plune-mcp -->';
  await upsertStickyComment(github, context, `${MARKER}\neval 1`);
  await upsertStickyComment(github, context, 'mcp 1', mcp);
  await upsertStickyComment(github, context, `${MARKER}\neval 2`);
  await upsertStickyComment(github, context, 'mcp 2', mcp);
  assert.equal(comments.length, 2);
  assert.equal(comments[0].body, `${MARKER}\neval 2`);
  assert.equal(comments[1].body, `${mcp}\nmcp 2`);
});

test('upsertStickyComment · a body without the marker · gets it prepended, so the next run finds it', async () => {
  const { github, comments } = fakeGithub();
  await upsertStickyComment(github, context, 'no marker here', '<!-- plune-mcp -->');
  assert.ok(comments[0].body.startsWith('<!-- plune-mcp -->\n'));
  assert.equal((await upsertStickyComment(github, context, 'again', '<!-- plune-mcp -->')).action, 'updated');
  assert.equal(comments.length, 1);
});

test('upsertStickyComment · marker past the first 100 comments · is found by paging', async () => {
  const { github, comments, calls } = fakeGithub([...filler(150), { id: 9999, body: `${MARKER}\nold` }]);
  const res = await upsertStickyComment(github, context, `${MARKER}\nnew`);
  assert.deepEqual(res, { action: 'updated', id: 9999 });
  assert.equal(comments.length, 151);
  assert.equal(calls.list, 2);
});

test('upsertStickyComment · exactly 100 comments, none marked · reads the empty next page, then creates', async () => {
  const { github, comments, calls } = fakeGithub(filler(100));
  assert.equal((await upsertStickyComment(github, context, `${MARKER}\nx`)).action, 'created');
  assert.equal(calls.list, 2);
  assert.equal(comments.length, 101);
});

for (const status of [401, 403]) {
  test(`upsertStickyComment · read-only token (${status}) · skips quietly`, async () => {
    const { github } = fakeGithub([], { failWith: status });
    const res = await upsertStickyComment(github, context, 'x', '<!-- plune-mcp -->');
    assert.equal(res.action, 'skipped');
  });
}

test('upsertStickyComment · another API error · is thrown to the caller', async () => {
  const { github } = fakeGithub([], { failWith: 500 });
  await assert.rejects(upsertStickyComment(github, context, 'x'), /HTTP 500/);
});

test('upsertStickyComment · no pull request in context · skips', async () => {
  const { github, calls } = fakeGithub();
  const res = await upsertStickyComment(github, { repo: context.repo, issue: {}, payload: {} }, 'x');
  assert.equal(res.action, 'skipped');
  assert.equal(calls.list, 0);
});
