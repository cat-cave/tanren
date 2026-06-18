# Design docs

This directory holds two distinct things — keep them separate:

1. **The hi-fi reference for Tanren's OWN dashboard.** The full-product vision is
   mocked in the `tanren-hi-fidelity/` bundle (exported from Claude Design) and its
   design tokens live under `tokens/`. These are a **human reference** so the build
   recreates Tanren's dashboard faithfully; the engine never reads them. The docs
   that track the hi-fi ↔ implementation gap and the revision SOP live here:
   - `phase-3-hifi-gaps.md` — the code-grounded hi-fi ↔ implementation gap audit.
   - `hifi-work-needed.md` — the inverse-direction work-list for the hi-fi bundle.
   - `hifi-revision-process.md` — the SOP for turning a new hi-fi revision into work.
   - `acceptance-criteria/` — per-screen acceptance specs for the dashboard surfaces.
   - `tokens/` — the source-of-truth design tokens + the `tanren-design` brand skill.

2. **The native design subsystem** (design as a first-class phase of the products
   Tanren _builds_) is **built and wired into the spec loop** — it is NOT in this
   directory. Its canonical doc is `docs/roadmap/native-design-subsystem.md`. The
   subsystem (`DesignContract` entity → design agent/phase → writer injection →
   design oracle, all in one DAG, no handoff) is e2e-wired and proven-to-close via a
   canned-model fixture harness, but has **not yet been exercised on a live run**
   (visual fidelity / live-render is the WS-D4a follow-on). Do not conflate the
   hand-done hi-fi bundle (a human reference for Tanren's dashboard) with the native
   subsystem (how Tanren designs the apps it ships).

The notes here refine `PROJECT_BRIEF.md`. When implementing a dashboard surface,
lift tokens from `tokens/colors_and_type.css` (consumed through
`services/dashboard/src/design/`, drift-checked) and follow `tokens/SKILL.md` as the
engineering contract.
