# OCR review pipeline — cutover runbook

**Status: DONE and LIVE.** The legacy `ci.yml` `check` job is deleted (#1312); review is
mandatory on every PR; the dedicated reviewer App posts a real `Approved`; the native GitHub
**merge queue is enabled and proven** (#1322 + #1323 both merged through it). Two-tier CI is the
live topology (#1321 pass-through, #1323 finalize). This file documents the live config + the
gotchas that had to be solved.

## What is live

- **Required contexts on `main`: `gate` + `review/verdict`** (`strict=false`).
  - `gate` is Actions-pinned (`app_id 15368`) — only CI can report it.
  - `review/verdict` is **un-pinned** (any status-writer) so a maintainer can override a
    `rule_change` PR by stamping the reviewed SHA (see §rule_change) without `--admin`. The
    untrusted lane has no write token, so it cannot forge it.
- **`gate` is a SHARED job name** produced on both events by the event-appropriate workflow:
  `ci-light.yml`'s `gate` job (`just fast-check`) runs on `pull_request`; `ci-heavy.yml`'s `gate`
  job (`just ci` + `just smoke`) runs on `merge_group` (+ `push:main` safety net). One required
  context, always reportable on the current event → the queue never waits on a missing check.
- **Merge queue**: ruleset `main-merge-queue` (`ops/review/merge-queue-ruleset.json`), SQUASH +
  ALLGREEN grouping. The PR "Merge" button is "Merge when ready".
- The reviewer App (`REVIEWER_APP_ID`/`REVIEWER_APP_PRIVATE_KEY`, `REVIEW_BOT_LOGIN`) posts the
  native `Approved` / `Request changes`; the enforced gate is the `review/verdict` **status**.
- Secrets: `OPENROUTER_API_KEY` (untrusted lane → OCR, spend-capped). Maintainer toggle still
  recommended: Settings → Actions → General → **"Require approval for all outside collaborators"**.

## Merge-queue mechanics (the two-tier design)

GitHub's merge queue splits gating into two events; a required check that does not report on the
event it is evaluated on **deadlocks the queue**, and a check that only runs in-queue cannot gate
entry. The `gate` shared-name trick + the `review/verdict` pass-through make every required
context reportable on **both** events:

| gate            | event          | `gate` is…                        | `review/verdict` is…                    |
| --------------- | -------------- | --------------------------------- | --------------------------------------- |
| **queue entry** | `pull_request` | ci-light `just fast-check`        | set by the OCR trusted lane             |
| **in queue**    | `merge_group`  | ci-heavy `just ci` + `just smoke` | stamped by the merge_group pass-through |

- The heavy suite runs **only in the queue** (batched/rebased across the merge group), never
  per-PR. Entry is fast: `gate`(fast-check) + `review/verdict`.
- **`review-verdict-passthrough`** (`ci-heavy.yml`, merge_group only) stamps
  `review/verdict=success` on the merge-group head. The review is enforced at ENTRY; only the
  advisory LLM verdict is carried, not re-run per rebase. Code correctness IS re-verified on the
  rebased merge group by the `gate` (ci-heavy) job.

## Gotchas solved (do not regress)

- **App-pinning.** Setting required checks via the legacy `contexts` field auto-pins them to
  whatever app last reported them (Actions, `15368`). That made a maintainer's `review/verdict`
  status-stamp not count. Fix: set required checks via the `checks` array with explicit `app_id`
  (`gate`→15368, `review/verdict`→`-1`/any).
- **Push restriction vs the queue.** Branch protection "Restrict who can push" (an allowlist)
  **rejects the merge queue's final merge-push** (the queue's actor isn't on the list), so a PR
  passes every check then gets silently ejected ~after checks. Fix: remove the push allowlist;
  "Require a pull request before merging" + `allow_force_pushes=false` preserve the protection.

## rule_change PRs (reviewer-config changes)

A PR touching `ops/review/**`, `.opencodereview/**`, or `.github/workflows/ocr-*` forces
`review/verdict=failure` ("maintainer review required") — a PR cannot weaken its own reviewer.
To land one: review the diff, confirm it doesn't weaken enforcement, then stamp
`gh api -X POST repos/<o>/<r>/statuses/<head_sha> -f state=success -f context=review/verdict`
(works because `review/verdict` is un-pinned) and let it merge through the queue. This is NOT a
CI bypass — `gate` (ci-heavy) still runs for real.

## Rollback

Set the `main-merge-queue` ruleset `enforcement` to `disabled` (or delete it) and re-add
`pull_request` to `ci-heavy.yml` so the `gate` heavy job runs per-PR again; PRs then merge
directly under `gate` + `review/verdict`.

## Notes

- `review/verdict` is per-SHA: any new push (fix or the queue's rebase) yields a new SHA with no
  status → not mergeable until re-reviewed. A stale green can never authorize unreviewed code.
- The review scripts run OCR from git root, rules from the trusted base only (never PR head —
  issue #110), with the untrusted/trusted secrets split. See ops/review/DESIGN.md §SECURITY.
