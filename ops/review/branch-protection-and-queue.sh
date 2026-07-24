#!/usr/bin/env bash
# Branch-protection + merge-queue config for the OCR review pipeline.
#
# ⚠️  DO NOT run blindly. This changes LIVE merge gating for `main`. Apply only after the
#     workflows (ci-light, ci-heavy, ocr-review-untrusted/trusted) are merged and green, and
#     the review secrets/vars are set. Follow ops/review/CUTOVER.md ordering. Review each call.
#
# Gate model (why a status, not required approvals):
#   The review verdict is a COMMIT STATUS (`review/verdict`) the bot sets — a GitHub App cannot
#   self-approve its own PRs, so required_approving_review_count can't be the gate. The merge
#   gate is: ci-light (fast checks) + review/verdict (no open P0/P1) on the PR, then ci-heavy
#   on the batched merge_group. strict=false because the merge queue owns up-to-dateness.
set -euo pipefail
REPO="${REPO:-cat-cave/tanren}"
BRANCH="${BRANCH:-main}"
: "${APPLY:=0}"   # export APPLY=1 to actually execute; default is dry-print.

run() { echo "+ $*"; [ "$APPLY" = 1 ] && "$@"; }

# 1) PR-side branch protection: require ci-light + review/verdict; drop strict; linear history;
#    conversation resolution; 0 required approvals (the status is the gate). Force-push/deletion
#    stay off. enforce_admins left OFF here — set true only if you want to remove the break-glass
#    (aligns with the "never bypass CI" lesson, but blocks fast barrier/hotfix PRs). Decide + edit.
read -r -d '' PROTECTION <<'JSON' || true
{
  "required_status_checks": { "strict": false, "contexts": ["ci-light", "review/verdict"] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 0, "dismiss_stale_reviews": false },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
run gh api -X PUT "repos/${REPO}/branches/${BRANCH}/protection" \
  -H "Accept: application/vnd.github+json" --input - <<<"$PROTECTION"

# 2) Merge queue. GitHub configures the queue via a repository RULESET (type: merge_queue) OR the
#    Settings → Branches UI. The merge_group required check is `ci-heavy`. Recommended parameters:
#      grouping_strategy=ALLGREEN, merge_method=SQUASH,
#      max_entries_to_build=5, min_entries_to_merge=1, min_entries_to_merge_wait_minutes=5,
#      max_entries_to_merge=5, check_response_timeout_minutes=60.
#    The REST shape has shifted across GitHub versions — VERIFY against current docs, or use the UI
#    (Settings → Branches → add rule → "Require merge queue"). Ruleset JSON template:
read -r -d '' QUEUE_RULESET <<'JSON' || true
{
  "name": "main-merge-queue",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [
    { "type": "merge_queue", "parameters": {
        "grouping_strategy": "ALLGREEN", "merge_method": "SQUASH",
        "max_entries_to_build": 5, "min_entries_to_merge": 1,
        "min_entries_to_merge_wait_minutes": 5, "max_entries_to_merge": 5,
        "check_response_timeout_minutes": 60 } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [ { "context": "ci-heavy" } ] } }
  ]
}
JSON
echo "--- merge-queue ruleset (verify/apply via: gh api -X POST repos/${REPO}/rulesets --input -, or the UI) ---"
echo "$QUEUE_RULESET"
[ "$APPLY" = 1 ] && [ "${APPLY_QUEUE:-0}" = 1 ] && gh api -X POST "repos/${REPO}/rulesets" --input - <<<"$QUEUE_RULESET" || true

# 3) Allow auto-merge (so the CRA can `gh pr merge --auto` a verdict-passed PR into the queue).
run gh api -X PATCH "repos/${REPO}" -f allow_auto_merge=true

echo "Done (APPLY=${APPLY}). Re-run with APPLY=1 (and APPLY_QUEUE=1 for the ruleset) to execute."
