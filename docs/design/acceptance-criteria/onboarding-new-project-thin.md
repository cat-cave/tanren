# Greenfield new project (thin, stretch)

**Surface**: a one-page project-create form for greenfield projects, with no Forge interview.

**Owning spec**: P2B-0009 — **stretch** (`docs/roadmap/phase-2b-specs.md`). Ships only if Phase 2B is otherwise on schedule; otherwise greenfield migrates entirely to Phase 3.

**Hi-fi reference**: `tanren-hi-fidelity/project/view-onboard-new.jsx` — the full hi-fi shows a 3-step multi-round Forge interview that derives a 71-spec DAG; this v0 surface ships only the title/repo/behaviors form. Low-fi import at `docs/design/operator-flows/onboarding-new-project-thin.svg`.

## In scope for Phase 2 (stretch)

- [ ] **Single-step form**: project name, one-sentence description, target GitHub repository (new empty repo created via P2A-0013 + the GitHub App OR selected from an existing empty repo in the org), behaviors list as free-text rows (each producing a `behaviors` row in P2A-0018 with a default persona), initial milestone seed (a single "M1" row).
- [ ] **Validation**: project name unique within the org; repo must be reachable via the GitHub App; behaviors require at least one entry.
- [ ] **Explicit "thin" framing**: the page header carries a `phase 3 · full Forge interview` badge that communicates the long-term vision — the v0 thin surface is the operator-experience floor, not the design ceiling.
- [ ] **Confirmation**: submitting routes the operator to the project view with an empty run list, no specs, the seeded behaviors visible.

## Reductions from the hi-fi

- **Forge vision interview**: deferred to Phase 3 (depends on thick Forge LLM backend).
- **Derived spec DAG**: deferred to Phase 3 (depends on full DAG canvas + DAG-from-interview derivation).
- **Sources / scheduled audits / arrival surfaces**: Phase 4+ scheduled audits library + Phase 3 issue ingestion.
- **Design DNA picker**: Phase 3 (depends on a wider design-system selection mechanism).
- **Rulesets locked card**: Phase 3 governance posture.

## Done when

If shipped: an operator can create a greenfield project from a single form, with behaviors and a milestone persisted, and run a spec against it within ten minutes of org setup.

If not shipped: the sidenav "new project" row renders a `phase 3` placeholder and greenfield onboarding moves entirely to Phase 3 along with the Forge interview surface.
