# Operator Flows (low-fi wireframes)

This directory was intended to hold low-fi wireframe imports (one per operator
surface) named after the owning spec. **Those imports were never done** — the
operator surfaces were built directly against the hi-fi vision bundle
(`tanren-hi-fidelity/`) and the per-surface acceptance criteria in
`../acceptance-criteria/`, so the intermediate low-fi artifacts proved
unnecessary.

The surfaces themselves shipped: the ⌘K Forge palette + chat morph, onboarding
(org / credentials / notifications / brownfield / greenfield), project view
(chat-primary + DAG + spec drawer/page), run detail + review handoff, failure
recovery, and history & costs are all mounted in
`services/dashboard/src/app/screens.ts`. The current hi-fi ↔ implementation gap
audit is the live source of design-vs-build truth:
[`../phase-3-hifi-gaps.md`](../phase-3-hifi-gaps.md).

This directory is kept only as a placeholder; no wireframe imports are expected.
