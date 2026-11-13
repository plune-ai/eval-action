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

// How long the comment may be, in characters. GitHub rejects a comment body over a limit that the tracker issue
// gives as 65,536; that figure is not confirmed by documentation (GitHub's REST reference for issue comments
// states none), so the budget stays well below it. The CLI keeps its own diff within the same 60,000.
export const COMMENT_BUDGET = 60_000;

const moreNote = (n) => `_${n} more ${n === 1 ? 'line' : 'lines'} in the job summary_`;

/**
 * `text` cut by whole lines to fit COMMENT_BUDGET, ending with a line that says the rest is in the job summary.
 * The marker is always the first line and is never cut: the next run finds the comment by it. A text that fits
 * is returned as it is.
 */
export function fitComment(text, marker = MARKER) {
  if (text.length <= COMMENT_BUDGET) return text;
  const lines = text.split('\n');
  const kept = lines[0].includes(marker) ? [] : [marker];
  let used = kept.length > 0 ? marker.length : 0;
  let i = 0;
  for (; i < lines.length; i++) {
    const add = (used > 0 ? 1 : 0) + lines[i].length;
    // Room for this line and for the closing note, counted as if every later line were left out.
    if (used + add + 1 + moreNote(lines.length - i - 1).length > COMMENT_BUDGET && (i > 0 || kept.length > 0)) break;
    kept.push(lines[i]);
    used += add;
  }
  // The marker line is kept whatever its length; a later line that overflows ends the text.
  return [...kept, moreNote(lines.length - i)].join('\n');
}

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
  const text = fitComment(body.includes(marker) ? body : `${marker}\n${body}`, marker);

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
