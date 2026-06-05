#!/usr/bin/env bash
# Prune agent worktrees whose branch has already landed on main.
#
# Subagents that run with worktree isolation get a checkout under
# `.claude/worktrees/agent-*` (each carrying its own node_modules + build
# output — ~50-200MB apiece). The harness auto-cleans a worktree only if it was
# left UNCHANGED; once an agent commits work and that work merges, the worktree
# lingers forever. Left unattended these accumulate into gigabytes and have
# filled the disk. This reaper removes any agent worktree whose branch is fully
# contained in `origin/main` (a real merge or fast-forward), plus abandoned
# branches that carry no unique diff. A branch with genuine unmerged commits is
# always KEPT — this never destroys un-landed work.
#
# Usage:
#   scripts/prune-merged-worktrees.sh            # prune
#   scripts/prune-merged-worktrees.sh --dry-run  # report only, remove nothing
#
# Run it after merging a subagent's PR, or periodically. Safe + idempotent.
set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
MAIN_WT="$REPO_ROOT"

git fetch origin main --quiet || echo "warn: could not fetch origin/main; using local ref" >&2

# Optional: squash-merged branches are NOT ancestors of main, so consult GitHub's
# merged set when `gh` is available. Absent gh, we fall back to the ancestor +
# empty-diff checks (which cover the native merge-queue's real-merge strategy).
MERGED_SET=""
if command -v gh >/dev/null 2>&1; then
  MERGED_SET="$(gh pr list --state merged --limit 400 --json headRefName --jq '.[].headRefName' 2>/dev/null || true)"
fi

removed=0 kept=0
while IFS=$'\t' read -r path br; do
  [ "$path" = "$MAIN_WT" ] && continue          # never the primary checkout
  [ -z "${br:-}" ] && continue                  # detached worktrees: leave alone

  prunable=0 reason=""
  if git merge-base --is-ancestor "$br" origin/main 2>/dev/null; then
    prunable=1 reason="merged (ancestor of main)"
  elif git diff --quiet "origin/main...$br" 2>/dev/null; then
    prunable=1 reason="no unique diff vs main"
  elif [ -n "$MERGED_SET" ] && grep -qxF "$br" <<<"$MERGED_SET"; then
    prunable=1 reason="merged (gh squash)"
  fi

  if [ "$prunable" = 1 ]; then
    if [ "$DRY_RUN" = 1 ]; then
      echo "would prune: $br  [$reason]"
    else
      git worktree remove --force "$path" && git branch -D "$br" >/dev/null 2>&1 || true
      echo "pruned: $br  [$reason]"
    fi
    removed=$((removed + 1))
  else
    ahead="$(git rev-list --count "origin/main..$br" 2>/dev/null || echo '?')"
    echo "kept:   $br  (unmerged, ahead $ahead)"
    kept=$((kept + 1))
  fi
done < <(git worktree list --porcelain | awk '
  /^worktree /{wt=$2}
  /^branch /{br=$2; sub("refs/heads/","",br); print wt"\t"br}
')

[ "$DRY_RUN" = 1 ] || git worktree prune
echo "---"
echo "$([ "$DRY_RUN" = 1 ] && echo 'would prune' || echo 'pruned') $removed worktree(s); kept $kept unmerged."
