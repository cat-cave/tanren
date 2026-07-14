# Greenfield new project (thin, stretch)

**Surface**: a one-page project-create form for greenfield projects, with no Forge interview.

**Owning spec**: P2B-0009 (see [`ROADMAP.md`](../../../ROADMAP.md)). The greenfield onboarding track is **mounted** (`mountGreenfieldOnboarding` → `/onboarding/new`); it is not a Phase 3 placeholder.

**Hi-fi reference**: `tanren-hi-fidelity/project/view-onboard-new.jsx` — multi-round vision interview → derived spec DAG → arrival. Low-fi import at `docs/design/operator-flows/onboarding-new-project-thin.svg` (historical thin-form sketch; the live path is the full greenfield track, not a single-step stub).

## In scope (shipped path)

- [ ] **Greenfield onboarding track** under `/onboarding/new`: multi-round vision interview → derived spec DAG → arrival (not a permanent sidenav row; reached from onboarding entry points).
- [ ] **Validation**: project name unique within the org; repo must be reachable via the GitHub App; behaviors / derived specs satisfy schema constraints.
- [ ] **Confirmation**: successful completion routes the operator into the project view with the derived DAG / seeded work visible.

## Reductions from the hi-fi

- **Depth of the vision interview / derived DAG cards** may still lag the hi-fi's multi-round interview polish — residual product depth, not an unmounted surface.
- **Sources / scheduled audits / arrival surfaces**: scheduled audits library is **mounted** (`/audits`); candidate inbox issue ingestion is **mounted** (`/inbox`). Residual is wire-up depth, not "Phase 3 placeholders."
- **Design DNA picker**: may still lag a wider design-system selection mechanism in the hi-fi.
- **Rulesets locked card**: residual governance-posture copy depth (posture itself is implemented in engine).

## Done when

An operator can complete greenfield onboarding from `/onboarding/new`, land in the project view with derived work visible, and run a spec without hitting a `phase 3+` placeholder for the greenfield track itself.
