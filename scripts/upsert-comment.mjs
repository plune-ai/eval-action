// Sticky PR-comment upsert for the Plune Actions (ADR-GA04).
//
// Invoked via `actions/github-script`, which injects `github` (an authenticated octokit) and
// `context`. Finds an existing comment carrying a hidden marker and updates it in place; otherwise
// creates one — so re-runs on the same PR never spawn duplicate comments (AC-3.2). Each kind of
// comment has its own marker (the eval diff keeps the default; the MCP action passes its own), so
// both live side by side in one PR. On a read-only token (fork PRs → 401/403) it skips quietly so
// the comment step never fails the Action; the result and the check conclusion still stand (GA04).
//
// Tested by upsert-comment.test.mjs (`node --test scripts/*.test.mjs`).

export const MARKER = '<!-- plune-eval-diff -->';

const PER_PAGE = 100;

async function findMarked(github, params, marker) {
  // Every page, not just the first 100: on a busy PR a missed marker would mean a second comment.
  for (let page = 1; ; page++) {
    const { data } = await github.rest.issues.listComments({ ...params, per_page: PER_PAGE, page });
    // Only a bot's comment: a person who quotes the marker must not have their comment rewritten.
    const hit = data.find((c) => c.user?.type === 'Bot' && typeof c.body === 'string' && c.body.includes(marker));
    if (hit || data.length < PER_PAGE) return hit;
  }
}

export async function upsertStickyComment(github, context, body, marker = MARKER) {
  const { owner, repo } = context.repo;
  const issueNumber = context.issue?.number ?? context.payload?.pull_request?.number;
  if (!issueNumber) {
    return { action: 'skipped', reason: 'no pull-request number in context' };
  }
  // A body without the marker could never be found again: the next run would add a second comment.
  const text = body.includes(marker) ? body : `${marker}\n${body}`;

  try {
    const existing = await findMarked(github, { owner, repo, issue_number: issueNumber }, marker);
    if (existing) {
      await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body: text });
      return { action: 'updated', id: existing.id };
    }
    await github.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body: text });
    return { action: 'created' };
  } catch (err) {
    const status = err?.status;
    if (status === 401 || status === 403) {
      return { action: 'skipped', reason: 'read-only token (fork PR?)' };
    }
    throw err;
  }
}
