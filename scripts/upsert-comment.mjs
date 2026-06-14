// Sticky PR-comment upsert for the Plune eval-diff Action (ADR-GA04).
//
// Invoked from action.yml via `actions/github-script`, which injects `github` (an authenticated
// octokit) and `context`. Finds an existing comment carrying a hidden marker and updates it in
// place; otherwise creates one — so re-runs on the same PR never spawn duplicate comments (AC-3.2).
// On a read-only token (fork PRs → 401/403) it skips quietly so the comment step never fails the
// Action; the diff and the check conclusion still stand (GA04).
//
// Note: scans the first 100 comments for the marker. A PR with >100 comments could miss it and
// create a second sticky comment — acceptable for v0.2; revisit with pagination if it bites.

export const MARKER = '<!-- plune-eval-diff -->';

export async function upsertStickyComment(github, context, body) {
  const { owner, repo } = context.repo;
  const issueNumber = context.issue?.number ?? context.payload?.pull_request?.number;
  if (!issueNumber) {
    return { action: 'skipped', reason: 'no pull-request number in context' };
  }

  try {
    const { data: comments } = await github.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    });
    const existing = comments.find((c) => typeof c.body === 'string' && c.body.includes(MARKER));

    if (existing) {
      await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
      return { action: 'updated', id: existing.id };
    }
    await github.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
    return { action: 'created' };
  } catch (err) {
    const status = err?.status;
    if (status === 401 || status === 403) {
      return { action: 'skipped', reason: 'read-only token (fork PR?)' };
    }
    throw err;
  }
}
