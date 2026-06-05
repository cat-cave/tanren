# Project view (chat-primary)

**Surface**: the project's operator home — a Forge narration card with attention queue, suboptimal callouts, activity feed, velocity card, and a live DAG. DAG-primary mode ships (the real DAG canvas).

**Owning spec**: P2B-0003 (see [`ROADMAP.md`](../../../ROADMAP.md)).

**Hi-fi reference**: `tanren-hi-fidelity/project/view-project.jsx` `ProjectViewChat`. The DAG-primary mode (`ProjectViewDag`) is built (`components/project/DagCanvas.tsx`, `ProjectDagBody.tsx`).

## In scope for Phase 2

- [ ] **Page head**: eyebrow with project name, title "what needs your attention", "+ discover spec ↗" CTA, live indicator "forge live · 12s ago".
- [ ] **KPI strip**: in-flight runs, needs-you count, week-spend vs cap, velocity, blocked count. Numbers wire to real run/cost/spec data from P2A-0014 and P2A-0011.
- [ ] **Forge narration card** (left, scrollable):
  - **State turn**: one-sentence project pulse generated from P2A-0019 templates. Sub-line names the most-recent material events (review-ready PR, in-flight subtask, week-to-date spend).
  - **Attention queue turn**: ranked list of items needing the operator. Each row has a priority pill, title, sub-line, and an action button routing to the appropriate surface (review handoff, spec discovery placeholder for Phase 2, ad-hoc URL).
  - **Suboptimal callouts turn**: the workflow-insights. Surfaces `retry_hotspot`, `model_mismatch`, `pace_anomaly`, `stuck`, and `review_stall`. Each callout has a title, body explaining the finding, and 2-3 action buttons.
  - **Prompts turn**: 3-5 suggested follow-up prompts as clickable chips.
  - **Composer input**: textbox + ⌘K/↵ chip. Submission runs through the thick real-LLM Forge author (shipped — `/forge/threads/:id/ask`).
- [ ] **Right rail**:
  - **DAG snapshot**: SVG showing milestones + nodes. Nodes carry status colors (done, live, review, blocked, queued). Click routing: `live`/`done` → run detail, `review` → review handoff.
  - **Velocity card**: sparkline + milestone ETA from milestone metadata.
- [ ] **Activity feed**: collapsible right-rail panel showing recent events (rendered from P2A-0014 event stream) with severity icons.

## Reductions from the hi-fi

- **DAG-primary mode**: shipped (the real DAG canvas + DAG-from-data layout).
- **`stuck` callout**: shipped (`engine/insights/stuck.ts`).
- **`review_stall` callout**: shipped (`engine/insights/reviewStall.ts`).
- **Live Forge LLM responses to composer input**: shipped (the thick real-LLM Forge author).
- **Forge composer auto-suggestions while typing**: future polish.

## Done when

An operator with a working project (linked repo, configured routing, at least one in-flight or completed run) opens the project view and sees a live attention queue, at least one real workflow-insight if their data supports it, navigable DAG snapshot, and accurate KPI numbers. Clicking any node in the DAG snapshot, attention row, or activity row routes correctly.
