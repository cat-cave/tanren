# Phase 1 Mergify Stack Lessons

Captured from Phase 1's seven-spec build. These notes feed every Phase 2 stack and should be treated as operating procedure, not background.

## What worked

- **Stacking dependent specs**. P1-0001 through P1-0007 were planned as a single dependency chain; per-commit PRs let reviewers see exactly the contract surface each spec produced. Independent specs landed faster than they would have as one large PR.
- **Per-stack CI boundaries**. Each commit ran the full check pipeline. CI red on a downstream PR did not block earlier merges in the stack.
- **`mergify stack push` over `git push`**. The CLI rebased automatically and updated draft PR bodies from commit messages. Avoided the manual chain-retargeting work entirely.
- **Commit messages as PR bodies**. Stack pushes derive PR title and body from the commit subject and message. Specs with rich commit messages had reviewable PRs without separate description writing.

## What did not work, and how to do it differently

- **Manual stack merging after a squash-merge**. Once the first stacked PR squash-merged onto `main`, the remaining stack commits did not retarget cleanly. Subsequent PRs needed rebasing or replacement PRs. **Fix:** always run `mergify stack sync` after a stack PR merges, before pushing or amending the rest of the stack. Never resolve a dirty stack by manually editing PR base branches or rewriting commits in another worktree.
- **Long stacks for loosely-coupled work**. P1-0003 (real Writer adapter), P1-0004 (GitHub PR contract), and P1-0006 (Answerer checks) were independent; chaining them produced needless serialization and made one PR's churn ripple through unrelated PRs. **Fix:** independent specs go on separate stacks. Keep each stack to genuinely dependent commits.
- **Implicit stack PR lifecycle policy**. Phase 1 expected stack PRs to stay drafts until the operator marked them ready, but it was not written down anywhere. **Fix:** the policy is now explicit in `docs/playbooks/github-workflow.md` — stack PRs remain drafts until the operator manually marks them ready for review.
- **Bypassing hooks to "just push"**. `git push --no-verify` was tempting when the Mergify stack guard fired on what looked like a non-stack branch. Resist this. **Fix:** the pre-push guard fires whenever commits carry `Change-Id:` lines (which the prepare-commit-msg hook adds). Use `mergify stack push` even for branches you do not consider a stack — it works for a single-commit branch and creates a single PR cleanly.

## Procedure for any Phase 2 stack

1. `mergify stack new stack/<name>` from `main`. Use a short, descriptive name (`stack/security`, `stack/typed-contracts`).
2. Commit per-spec. Write commit subjects as PR titles. Write commit bodies as PR descriptions including the spec's owned paths, validation steps, and version-verification sources.
3. `mergify stack push` to create or update PRs. Each commit becomes one PR targeting the previous (or `main` for the first).
4. Mark each PR ready for review only after local checks and any required compose smoke are green.
5. After a stack PR merges, `mergify stack sync` before pushing or amending remaining commits.
6. If a stack ends up dirty after an upstream change, prefer landing a clean replacement stack over manual repair.

## When to start a new stack vs. extend an existing one

- **New stack** if the work is independent of any currently-open PR in the stack. Independent work in parallel keeps merge windows small.
- **Extend the stack** only when the new commit truly depends on a prior open PR. If unsure, lean toward a new stack.

## Pre-push hook expectations

Two pre-push jobs run sequentially via lefthook: the Mergify stack guard and `corepack pnpm run check:fast`. Both must pass for a `git push` to succeed. `mergify stack push` sets `MERGIFY_STACK_PUSH=1` to bypass the guard but still runs the fast check.

`just fast-check` runs the same components (format, lint, architecture, type-check, tests, compose config) and is the right iteration signal before invoking the stack push.
