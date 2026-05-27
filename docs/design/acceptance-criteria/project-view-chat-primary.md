# Project view (chat-primary)

**Surface**: the project's operator home — a Forge narration card with attention queue, suboptimal callouts, activity feed, velocity card, and a small live DAG snapshot. DAG-primary mode is Phase 3.

**Owning spec**: P2B-0003 (`docs/roadmap/phase-2b-specs.md`).

**Hi-fi reference**: `tanren-hi-fidelity/project/view-project.jsx` `ProjectViewChat`. Low-fi import at `docs/design/operator-flows/project-view-chat-primary.svg`. The dag-primary mode (`ProjectViewDag`) is Phase 3.

## In scope for Phase 2

- [ ] **Page head**: eyebrow with project name, title "what needs your attention", "+ discover spec ↗" CTA, live indicator "forge live · 12s ago".
- [ ] **KPI strip**: in-flight runs, needs-you count, week-spend vs cap, velocity, blocked count. Numbers wire to real run/cost/spec data from P2A-0014 and P2A-0011.
- [ ] **Forge narration card** (left, scrollable):
  - **State turn**: one-sentence project pulse generated from P2A-0019 templates. Sub-line names the most-recent material events (review-ready PR, in-flight subtask, week-to-date spend).
  - **Attention queue turn**: ranked list of items needing the operator. Each row has a priority pill, title, sub-line, and an action button routing to the appropriate surface (review handoff, spec discovery placeholder for Phase 2, ad-hoc URL).
  - **Suboptimal callouts turn**: the workflow-insights from P2A-0020. v0 surfaces `retry_hotspot`, `model_mismatch`, `pace_anomaly`. Each callout has a title, body explaining the finding, and 2-3 action buttons routing through P2A-0013 (`switch writer · this spec class`, `open bdd · refine`, etc.).
  - **Prompts turn**: 3-5 suggested follow-up prompts as clickable chips.
  - **Composer input**: textbox + ⌘K/↵ chip. In Phase 2, submission is a placeholder (Phase 3 thick Forge will handle it).
- [ ] **Right rail**:
  - **DAG snapshot**: read-only SVG showing milestones + nodes from P2A-0018. Nodes carry status colors (done, live, review, blocked, queued). Click routing: `live`/`done` → run detail, `review` → review handoff, `blocked`/`queued` → no-op (Phase 3 will open a "why blocked?" inspection thread).
  - **Velocity card**: sparkline + milestone ETA from milestone metadata.
- [ ] **Activity feed**: collapsible right-rail panel showing recent events (rendered from P2A-0014 event stream) with severity icons.

## Reductions from the hi-fi

- **DAG-primary mode**: deferred to Phase 3 (depends on full DAG canvas + DAG-from-data layout engine).
- **`stuck` callout**: Phase 3 (depends on spec-dependency-chain analysis).
- **`review_stall` callout**: Phase 3 (depends on review polling).
- **Live preview of Forge LLM responses to composer input**: Phase 3.
- **Forge composer auto-suggestions while typing**: Phase 3.

## Done when

An operator with a working project (linked repo, configured routing, at least one in-flight or completed run) opens the project view and sees a live attention queue, at least one real workflow-insight if their data supports it, navigable DAG snapshot, and accurate KPI numbers. Clicking any node in the DAG snapshot, attention row, or activity row routes correctly.
