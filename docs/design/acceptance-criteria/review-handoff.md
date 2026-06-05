# Review handoff

> **Currency note.** The review screen shipped as a state-display surface, and the
> action side is now **built**: the real merge contract / per-repo merge
> integration (`native_queue` · `direct_merge` · external-reviewer handoff) drives
> the merge. Mergify is removed — `native_queue` is the merge engine. The
> "renders disabled — later phase" merge-CTA framing below is historical and is
> updated to the shipped state.

**Surface**: the per-PR review screen — a behavior checklist, deferral resolutions, preview pane, and readiness gate.

**Owning spec**: P2B-0004 (see [`ROADMAP.md`](../../../ROADMAP.md)).

**Hi-fi reference**: `tanren-hi-fidelity/project/view-review.jsx`.

## In scope for Phase 2

- [ ] **Page head**: eyebrow with PR number + repo, title "review with forge", sub-line naming the spec, change title, forging cli, cost. Action buttons: back to project, open PR on GitHub ↗.
- [ ] **Forge review chat** (left): a Forge thread bound to the PR. Renders an opening narration ("Ready to review. Walk through N behaviors and N items I deferred during the run."), a clickable behavior checklist (each row tied to a behavior from the spec, with CI duration hint and a "you ✓ / you ○" toggle), the deferral cards from the writer's run with "handle now · replan + subtasks" / "defer · spawn follow-up spec" / "dismiss · won't fix" actions, and a nudge turn that updates based on remaining unverified behaviors and unresolved deferrals.
- [ ] **Preview pane** (right): a preview rendering for the change with the PR URL link and device-tab buttons (desktop / tablet / mobile). An `open ↗` button takes the operator to the PR's preview URL if one is declared in the project config (the DeployAdapter demo surface wires the live preview).
- [ ] **Readiness gate**: bottom bar with three state pills (`ci green`, `N / M you-verified`, `N deferred · M resolved`) plus a note. Sign-off CTAs render per the per-repo merge-integration configuration:
  - Projects configured for the native merge queue: `sign off · queue` → enters Tanren's `native_queue` (the merge engine).
  - Projects configured for direct merge: `sign off · merge now ↗` → `direct_merge`.
  - Projects configured for external reviewer: `approve · notify reviewer` → `external_reviewer` hand-off.
  - Projects without configured merge integration: `sign off · merge integration not configured` (disabled) with a link to the project settings.
- [ ] **`request changes`** CTA is always available and marks the spec as needing rework (the planner-feedback loop picks it up).

## Reductions from the hi-fi

- **Live merge backends**: shipped — `native_queue` / `direct_merge` / `external_reviewer` via `engine/workflow/reviewMerge/mergeDispatch.ts`.
- **Live preview-deploy iframe**: wired through the DeployAdapter demo surface (`contracts/deployAdapter.ts`, `demoOnDeploy`); richer per-state preview remains polish.
- **Per-behavior "verify in preview" CTAs that target specific UI states**: future polish (depends on richer preview infrastructure).
- **`review_stall` callout**: shipped (`engine/insights/reviewStall.ts`).

## Done when

An operator reviewing a fixture-medium PR can walk through every behavior in the checklist, resolve all writer-deferred items, see the readiness gate update its state pills live, and either request changes (which loops the spec back to the planner) or sign off — entering the configured merge backend (`native_queue` / `direct_merge` / `external_reviewer`).
