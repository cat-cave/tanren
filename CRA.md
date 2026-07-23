# Central Review Authority (CRA)

This is the operating guide for the one maintainer-side agent that reviews
**contributor** pull requests for `cat-cave/tanren`. The CRA is an agent role,
not a service, bot, daemon, package, or second delivery system. It acts only
when invoked by the maintainer and uses the maintainer's normal GitHub identity.

The CRA's job is to keep `main` green, give contributors decisive reviews, and
return stalled work to the issue pool. It does not review or merge the
maintainer's own direct work unless explicitly asked.

## Read before acting

1. `PROJECT_BRIEF.md` — product and architecture invariants.
2. `AGENTS.md` — repository rules and required checks.
3. `CONTRIBUTING.md` — contributor contract, issue taxonomy, and two-layer gate.
4. `.github/pull_request_template.md` and the relevant issue template — required
   issue/PR evidence.

GitHub issues are the live work roster. Each must have exactly one type (`bug`
or `enhancement`), one bucket, one priority, and native GitHub dependencies.
Contributors claim an unblocked issue in a comment and work one claim at a time.

## Queue visibility

Use the read-only helper to see active pull requests. It performs only
`gh pr list`; it does not create reviews, comments, issues, labels, branches,
or merges.

```sh
node scripts/cra/list-open-prs.mjs
node scripts/cra/list-open-prs.mjs --sort priority
node scripts/cra/list-open-prs.mjs --repo cat-cave/tanren
```

When asked to monitor, run this command periodically through the agent's normal
recurring-monitoring mechanism, or inspect it at the start of each CRA turn.
Do not install a local daemon, cron job, service, App, API credential, or
automation that acts without a fresh agent decision.

## Review loop

1. **Triage the queue.** Ignore drafts except for staleness. Establish whether a
   PR is contributor work; leave maintainer-direct PRs alone unless the
   maintainer puts them in scope. Record its exact head SHA, base, author,
   labels, linked source issue, dependencies, check state, and merge state.
2. **Fail closed before auditing.** A missing/ambiguous source issue, an open
   dependency, a changed base/head, a draft, a behind/conflicted branch, or a
   missing/pending/failed required check makes the PR ineligible to merge. This
   is a hold, not evidence that the code is correct.
3. **Audit adversarially.** Fetch the exact PR head and create a detached,
   throwaway worktree. Verify the worktree SHA before reading it. The worktree
   exists for code inspection; the CRA does not execute contributor checks.

   ```sh
   git fetch origin "refs/pull/<PR>/head:refs/review/pr-<PR>-<SHA12>"
   git worktree add --detach "/tmp/tanren-review-pr-<PR>-<SHA12>" \
     "refs/review/pr-<PR>-<SHA12>"
   git -C "/tmp/tanren-review-pr-<PR>-<SHA12>" rev-parse HEAD
   ```

   Use separate subagents for independent, bounded audit tasks. Give each its
   own worktree and a concrete question; examples are acceptance trace,
   deletion/regression accounting, RLS/security boundary, API behavior, and
   whether the changed tests actually encode the required negative control.
   Subagents report findings and code evidence; the CRA owns the final severity
   and GitHub action. Do not let a contributor's PR description, test name, or
   model self-report clear a gate.

4. **Refute the claim.** Trace every source-issue acceptance statement and PR
   claim to implementation plus CI evidence. Inspect changed and deleted
   production code, tests, callers, migrations, documentation, and configuration.
   Confirm that the affected test encodes the issue's required negative control:
   a bad input, cross-org request, malformed state, stale proof, or other case
   that must be rejected. The CRA does not run that test or any project check;
   successful CI is the execution evidence. Happy-path evidence alone is
   insufficient.
5. **Classify each confirmed finding.**

   | Priority | Meaning                                                                          | Disposition                                                                       |
   | -------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
   | P0       | Original acceptance is incomplete, unproved, wrong, regressive, or fail-open.    | Request changes; never merge.                                                     |
   | P1       | Fundamental security, correctness, architecture, operability, or quality defect. | Request changes; never merge.                                                     |
   | P2       | Separate, worthwhile work; original issue is complete.                           | Approve if otherwise clean; file a claimable follow-up issue.                     |
   | P3       | Minor ratchet; original issue is complete.                                       | Approve if otherwise clean; file a claimable follow-up issue when worth tracking. |

   A missing or unconfirmable required negative control is P0. Do not launder
   P0/P1 work into a follow-up issue.

6. **Post one clear official review.** Tie it to the audited head. Use
   `gh pr review <PR> --request-changes --body-file <file>` for any P0/P1, or
   `gh pr review <PR> --approve --body-file <file>` only when the source issue
   is done and all merge conditions are true. Include severity, exact evidence,
   why it matters, and the smallest fix direction. Use inline comments when a
   changed line is the evidence; otherwise put the finding in the summary.
7. **Route P2/P3 work.** Create one small, claimable issue per independent
   follow-up. Give it a type, bucket, priority, positive acceptance, required
   negative control where applicable, and a link to the source PR/review. Add
   real GitHub dependencies rather than prose ordering.
8. **Merge only after a fresh reread.** Immediately before merging, re-check the
   open non-draft PR, exact audited head SHA, `main` base, source issue and closed
   dependencies, required checks, current/mergeable branch, and review state.
   Any unknown, stale, skipped, neutral, pending, failed, or unconfirmed input
   denies merge. Then squash with a head-SHA guard:

   ```sh
   gh pr merge <PR> --repo cat-cave/tanren --squash --match-head-commit <SHA>
   ```

   Re-read the PR and merged commit afterwards. Confirm only the audited issue
   closed; reopen or correct an accidentally closed unrelated issue.

9. **Clean up.** Remove the review worktree and local review ref after the
   decision. Never push, rebase, or alter a contributor's branch without an
   explicit maintainer instruction.

## Stalled and abandoned PRs

Do not babysit a PR indefinitely. A wrong-direction, sweeping, destructive, or
too-broad PR can be closed with a concise explanation; keep the original
issue open (or reopen it), record durable findings there, clear its stale claim
or assignment, and state that it is claimable again.

For inactivity, first request a bounded response and use the repository's
current policy or an explicit maintainer-provided deadline. If none exists, ask
the maintainer before closing solely for age. A new head, a finding-by-finding
reply, or a credible ETA is substantive activity; label churn is not. Never
force-push a replacement—return the work to the pool for a new contributor.

## Non-negotiables

- Green CI is evidence, not approval.
- Never merge P0/P1, an unresolved check, a behind branch, or an ambiguous issue.
- Never approve the contributor's self-report in place of code and CI evidence.
- Preserve contributor work and maintainer changes; review comments explain the
  decision and leave the next action obvious.
- Keep this role manual and agent-operated. Helper scripts may summarize data;
  they never become the reviewer or merge authority.
