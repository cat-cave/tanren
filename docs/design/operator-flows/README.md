# Operator Flows (low-fi wireframes)

This directory will hold the low-fi wireframe imports for every operator surface Phase 2B builds. The imports are sourced from the design tool the project uses (Claude Design today). Each flow is a per-surface artifact (PDF, PNG, or SVG) named after the owning P2B spec.

## Status (as of Phase 2A foundation)

Low-fi imports are pending — they ship as part of an ongoing hi-fi vision iteration (see `docs/design/hifi-vision-changes.md`). Acceptance criteria for each surface are already locked in `../acceptance-criteria/` and reference this directory by filename; once imports land, no acceptance-criteria edits should be needed unless the vision itself shifts.

## Expected files

| File | Owning spec |
|---|---|
| `shell-and-palette.{pdf,png,svg}` | P2B-0001 |
| `onboarding-org-setup.*` | P2B-0002 |
| `onboarding-existing-project-minimal.*` | P2B-0002 |
| `onboarding-new-project-thin.*` | P2B-0009 (stretch) |
| `credentials.*` | P2B-0002 |
| `notifications-matrix.*` | P2B-0002 |
| `project-and-spec.*` | P2B-0003 |
| `routing-and-limits.*` | P2B-0003 |
| `run-detail.*` | P2B-0004 |
| `review-handoff.*` | P2B-0004 |
| `failure-recovery.*` | P2B-0008 |
| `history-and-costs.*` | P2B-0005 |

When importing, prefer SVG for surfaces that include callouts and PDF/PNG only as a fallback. Each import must be referenced by exactly one acceptance-criteria file.
