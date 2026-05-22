# Design Notes

Design notes that refine `PROJECT_BRIEF.md` live here.

Phase 2 is the right time to pull the external beta design system into this repository, because Phase 1 now has real workflow states that need an operator-visible surface. Import the design system first as source artifacts under `docs/design/**`; apply it to runtime UI only when a spec owns the relevant dashboard paths.

Good trigger points:

- project/spec creation UI
- run detail views with durable task state
- PR/CI/review status surfaces
- credential onboarding flows

Until one of those specs owns UI paths, keep backend and workflow changes visually generic and avoid applying early design-system churn across the app.

Before dashboard implementation, the workflow design inventory should include onboarding, credential setup, project setup, spec creation, run detail, review handoff, failure recovery, settings, and history/cost views.
