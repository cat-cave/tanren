# Review handoff

**Surface**: the per-PR review screen — a behavior checklist, deferral resolutions, preview pane, and readiness gate that displays state (but does not act on merge in Phase 2).

**Owning spec**: P2B-0004 (`docs/roadmap/phase-2b-specs.md`).

**Hi-fi reference**: `tanren-hi-fidelity/project/view-review.jsx`. Low-fi import at `docs/design/operator-flows/review-handoff.svg`.

## In scope for Phase 2

- [ ] **Page head**: eyebrow with PR number + repo, title "review with forge", sub-line naming the spec, change title, forging cli, cost. Action buttons: back to project, open PR on GitHub ↗.
- [ ] **Forge review chat** (left): a Forge thread bound to the PR via P2A-0019. Renders an opening narration ("Ready to review. Walk through N behaviors and N items I deferred during the run."), a clickable behavior checklist (each row tied to a behavior from the spec, with CI duration hint and a "you ✓ / you ○" toggle), the deferral cards from the writer's run with "handle now · replan + subtasks" / "defer · spawn follow-up spec" / "dismiss · won't fix" actions, and a nudge turn that updates based on remaining unverified behaviors and unresolved deferrals.
- [ ] **Preview pane** (right): a static preview rendering for the change. v0 renders a placeholder card with the PR URL link and device-tab buttons (desktop / tablet / mobile) that adjust the placeholder dimensions; live preview-deploy iframes are Phase 3. An `open ↗` button takes the operator to the PR's preview URL if one is declared in the project config.
- [ ] **Readiness gate**: bottom bar with three state pills (`ci green`, `N / M you-verified`, `N deferred · M resolved`) plus a note. Sign-off CTAs render per the per-repo merge-integration configuration (from P2A-0006 project config):
  - Projects configured for Mergify: `sign off · queue with mergify` (renders disabled in v0 with a "merge integration · not wired in v0 — Phase 3" tooltip).
  - Projects configured for direct merge: `sign off · merge now ↗` (same disabled treatment).
  - Projects configured for external reviewer: `approve · notify reviewer` (same disabled treatment).
  - Projects without configured merge integration: `sign off · merge integration not configured` (disabled) with a link to the project settings.
- [ ] **`request changes`** CTA is always available and routes through P2A-0013 to mark the spec as needing rework (the planner-feedback loop in P2A-0012 picks it up).

## Reductions from the hi-fi

- **Live merge-now / queue-with-mergify backends**: Phase 3 (real review/merge contract).
- **Live preview-deploy iframe**: Phase 3.
- **Per-behavior "verify in preview" CTAs that target specific UI states**: Phase 3 (depends on richer preview infrastructure).
- **`review_stall` callout**: Phase 3 (depends on review polling).
- **Mergify queue integration**: Phase 3 (the per-repo merge-integration toggle in project config is a Phase 3 surface).

## Done when

An operator reviewing a fixture-medium PR can walk through every behavior in the checklist, resolve all writer-deferred items, see the readiness gate update its state pills live, and either request changes (which loops the spec back to the planner) or — for projects with merge-integration configured — see the disabled-but-correct sign-off CTAs labeled with the configured merge backend. Tanren itself does not act on the merge in Phase 2.
