# OCR review pipeline — cutover runbook

**Status: the HARD cutover is DONE.** The legacy `ci.yml` `check` job is deleted (#1312),
`ci-heavy` (`just ci` + `just smoke`) + `review/verdict` are the required PR gates, review is
on for every PR, and the dedicated reviewer App posts a real `Approved`. This file now documents
the config that is live plus the **merge-queue mechanics** (the remaining optimization: move the
heavy gate off per-PR and onto the batched queue).

## What is live

- Required PR contexts on `main`: **`ci-heavy`** + **`review/verdict`** (`strict=false`).
- `ci-heavy` triggers on `pull_request` + `merge_group` + `push:main`.
- `review/verdict` is set per-SHA by the OCR trusted lane (`success` iff zero open P0/P1).
- The reviewer App (`REVIEWER_APP_ID`/`REVIEWER_APP_PRIVATE_KEY`, `REVIEW_BOT_LOGIN`) posts the
  native `Approved` / `Request changes`; the enforced gate is the `review/verdict` **status**,
  not the approval.
- Secrets: `OPENROUTER_API_KEY` (untrusted lane → OCR, spend-capped). Maintainer toggle still
  recommended: Settings → Actions → General → **"Require approval for all outside collaborators"**
  so a fork PR cannot run any workflow until a maintainer approves it.

## Merge-queue mechanics (the two-tier design)

GitHub's merge queue splits gating into two events, and a required check that does not report on
the event it is evaluated on **deadlocks the queue**. So the checks are placed deliberately:

| gate            | event          | required check(s)             | purpose                                |
| --------------- | -------------- | ----------------------------- | -------------------------------------- |
| **queue entry** | `pull_request` | `ci-light` + `review/verdict` | fast checks + LLM review gate the PR   |
| **in queue**    | `merge_group`  | `ci-heavy`                    | full `just ci` + `just smoke`, batched |

- **`ci-light`** (`pull_request`) — `just fast-check`. Cheap; gates queue ENTRY and the review
  trigger. A PR cannot be queued until it is green.
- **`review/verdict`** (`pull_request`) — gates ENTRY. It never reports on `merge_group`, so
  `ci-heavy.yml` has a **`review-verdict-passthrough`** job (merge_group only) that stamps
  `review/verdict=success` onto the merge-group head. The review is enforced pre-queue; only the
  advisory LLM verdict is carried, not re-run per rebase. Code correctness IS re-verified on the
  rebased merge group by `ci-heavy`.
- **`ci-heavy`** (`merge_group`) — the real merge gate, run on the batched/rebased queue commit
  (amortized across the batch) plus `push:main` as a post-merge safety net.

Why not make `ci-heavy` a required _PR_ check too? Because that runs the full heavy suite on
every PR push — the exact per-PR cost the queue exists to amortize. Once the queue is proven,
`ci-heavy`'s `pull_request` trigger is removed so it runs ONLY in the queue, and the required PR
contexts become `ci-light` + `review/verdict` (entry), with `ci-heavy` gating the merge group.

## Enabling / operating the queue

1. **Land the pass-through** (this branch): `ci-heavy.yml` `review-verdict-passthrough` job +
   `ops/review/merge-queue-ruleset.json`. Merges under the current gate (`ci-heavy` on PR).
2. **Enable the queue**: `gh api -X POST repos/<owner>/<repo>/rulesets --input ops/review/merge-queue-ruleset.json`
   (squash, ALLGREEN grouping). This turns the PR "Merge" button into "Merge when ready".
3. **Prove it** on a throwaway PR: ci-light + review/verdict green → add to queue
   (`gh pr merge --squash --auto <pr>`) → `merge_group` runs `ci-heavy` + the passthrough →
   merges. Confirm a seeded P0 blocks entry and a failing `ci-heavy` ejects the culprit.
4. **Finalize** (through the now-working queue): remove `pull_request` from `ci-heavy`'s triggers
   and switch the required PR contexts to `ci-light` + `review/verdict`. `ci-heavy` stays required
   on the merge group. Full batched two-tier design.

## Rollback

Set the merge-queue ruleset `enforcement` to `disabled` (or delete the ruleset); PRs merge
directly again under the required PR contexts (`ci-heavy` + `review/verdict` while the stopgap
`pull_request` trigger remains).

## Notes

- `review/verdict` is per-SHA: any new push (fix or the queue's rebase) yields a new SHA with no
  status → not mergeable until re-reviewed. A stale green can never authorize unreviewed code.
- The review scripts run OCR from git root, rules from the trusted base only (never PR head —
  issue #110), with the untrusted/trusted secrets split. See ops/review/DESIGN.md §SECURITY.
