# OCR review pipeline — cutover runbook

The CI split + merge queue is a **coordinated cutover**: applied piecemeal it leaves `main`
either double-gated (wasteful) or un-gated (unsafe). Do it in this order. Nothing here is
auto-applied; each step is a deliberate maintainer action.

## Invariant to preserve

Today, the legacy `ci.yml` `check` job runs `just ci` + `just smoke` (full build + RLS smoke)
on every PR — that is the _only_ thing keeping broken code off `main`. It must not be removed
until `ci-heavy` is required on the merge queue and proven green. Until then, keep `check`.

## Order

1. **Merge the review layer + workflows** to `main` (this branch): `ops/review/**`,
   `.github/workflows/{ci-light,ci-heavy,ocr-review-untrusted,ocr-review-trusted}.yml`.
   At this point `ci-light` and `ci-heavy` exist but are NOT yet required; legacy `check`
   still gates. (`ci-heavy` will run on `push:main` from now on — verify it goes green there.)

2. **Set review secrets/vars** (repo Settings → Secrets/Variables):
   - secret `OPENROUTER_API_KEY` = the OpenRouter key (value of `TANREN_E2E_MANAGED_ROUTER_KEY`).
     The untrusted lane maps it to OCR's `OCR_LLM_AUTH_TOKEN` at the OCR-run step; the
     endpoint (`OCR_LLM_URL` = `https://openrouter.ai/api/v1`) and protocol
     (`OCR_LLM_PROTOCOL` = `openai`) are set inline as non-secret env, and the model comes
     from `model-routing.json`. This is the ONLY secret the untrusted lane carries — a
     spend-capped, low-value key, NOT a repo-write token (the write token lives in the
     trusted lane, which never runs OCR/PR code).
   - **Cap the blast radius of that key:** in the OpenRouter dashboard set a per-key
     **monthly spend cap** on `OPENROUTER_API_KEY` (a leaked untrusted-lane key can then only
     burn capped LLM spend, never touch the repo).
   - **Require approval for outside runs:** repo Settings → Actions → General →
     "Fork pull request workflows from outside collaborators" → set **"Require approval for
     all outside collaborators"** so a fork PR cannot run any workflow (and thus cannot reach
     even the untrusted lane) until a maintainer approves it.
   - **Dedicated reviewer App identity (for a REAL `Approved` review).** GitHub bars
     `github-actions[bot]` / the default `GITHUB_TOKEN` from _approving_ PRs — an APPROVE 422s and
     post-review falls back to a COMMENT review. A GitHub App **installation token** is NOT the
     Actions bot and CAN approve. To get a real green `Approved` review on a clean PR, register a
     small GitHub App (a "Tanren Reviewer"), install it on the repo with **Pull requests: read &
     write** permission, and set:
     - secret `REVIEWER_APP_ID` = the App's numeric App ID.
     - secret `REVIEWER_APP_PRIVATE_KEY` = the App's PEM private key.
     - var `REVIEW_BOT_LOGIN` = the App's bot login (e.g. `tanren-reviewer[bot]`) so the pipeline
       reconciles against the reviewer's OWN prior comments/reviews + scopes gather-signal's
       resolve/reaction lookup to the reviewer's ocr-finding comments.

     The trusted lane mints an installation token via
     `actions/create-github-app-token` (SHA-pinned) **guarded on `secrets.REVIEWER_APP_ID != ''`**,
     and post-review posts with it. **Graceful degradation — the App is OPTIONAL:** if
     `REVIEWER_APP_ID` is unset the mint step is skipped, post-review uses `github.token`, the
     APPROVE downgrades to a COMMENT review (body: "No open P0/P1 findings — `review/verdict`
     passes.", never a false "Approved"), and `REVIEW_BOT_LOGIN` defaults to
     `github-actions[bot]`. Either way the **gate is the `review/verdict` commit status** the
     verdict step sets (still on `github.token` — the status needs no reviewer identity), NOT the
     approval; the App only improves the reviewer UX by turning the pass into a real `Approved`.

3. **Shadow-run the review** on a few open PRs (the untrusted job produces the JSON artifact;
   let the trusted job post but leave the verdict advisory / not-yet-required). Confirm finding
   quality, grounding, dedup, and that no secrets leak to the untrusted lane. Tune the rule file
   if needed. Cost target: ~$0.30–0.50/PR (luna); ensemble adds hy3 on high-stakes paths.

4. **Enable the merge queue + required checks** — run `ops/review/branch-protection-and-queue.sh`
   (with `APPLY=1`, and `APPLY_QUEUE=1` or the UI for the queue). This makes `ci-light` +
   `review/verdict` required on PRs and `ci-heavy` required on the merge group. Verify a test PR
   flows: ci-light green + verdict green → auto-enters queue → ci-heavy green → merges; and that a
   seeded P0 blocks, and a failing ci-heavy bisects/ejects.

5. **Remove the legacy gate.** Only now delete `ci.yml` (or strip it to nothing) — `ci-light`
   (PR) + `ci-heavy` (queue) fully replace it. Update the required-context list to drop `check`.

## Rollback

Re-add `check` as a required context (it still runs on `push:main` history) and set the merge
queue ruleset `enforcement` to `disabled`; PRs merge directly again under `check`.

## Notes

- `review/verdict` is per-SHA: any new push (fix or the queue's rebase) yields a new SHA with no
  status → not mergeable until re-reviewed. A stale green can never authorize unreviewed code.
- The review scripts run OCR from git root, rules from the trusted base only (never PR head —
  issue #110), with the untrusted/trusted secrets split. See ops/review/DESIGN.md §SECURITY.
