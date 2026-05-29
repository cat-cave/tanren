# Run detail

**Surface**: the per-run drilldown showing live cost, trajectory spine, writer reasoning, and per-task detail.

**Owning spec**: P2B-0004 (`docs/roadmap/phase-2b-specs.md`).

**Hi-fi reference**: `tanren-hi-fidelity/project/view-run.jsx`. Low-fi import at `docs/design/operator-flows/run-detail.svg`.

## In scope for Phase 2

- [ ] **Page head**: eyebrow with the trajectory framing, title "the agent's thinking", sub-line `{run_id} · {spec} · started {ago} · branch <code>{branch}</code>`, action buttons (back to project, ask forge, tail logs, cancel run).
- [ ] **Unified cost bar**: four cells —
  - **Per-token**: cost figure, percentage of soft cap, tiny meter.
  - **Window**: subscription-window usage percentage, sub-line naming the subscription with reset hint.
  - **Tokens in/out**: numerals plus cached count.
  - **Spend rate (60s)**: sparkline of recent cost burn.
  - **Run meta cell**: cli, attempt N of N, elapsed, retries.
    All cost figures wire to P2A-0011 cost records and respect the four cost-source colors from the design tokens. No unknown-source placeholders.
- [ ] **Trajectory spine** (left): ordered list of moments (plan, write subtask N, check, audit, pr, ci, merge). Each row is clickable and shows phase, duration, status dot, title, optional IO summary. Selected row populates the reasoning pane on the right. Spine fills (color gradient) as the run progresses; queued rows are visually distinct.
- [ ] **Writer reasoning pane** (right): when a writer or planner moment is selected, the pane renders:
  - **Moment header**: eyebrow + writer-stated headline (e.g. "wire localStorage persistence").
  - **Suboptimal callout** (if applicable, from P2A-0020): inline `pace_anomaly` or other workflow-insight row.
  - **Intent + BDD side-by-side**: writer's declared intent and the BDD scenario from the spec's behavior.
  - **Tools called**: count + list of structured tool invocations with arg and output summary (from P2A-0007 semantic event fields).
  - **Decisions**: bullet list of structured decisions captured during the run.
  - **Ask-Forge CTA**: a chip that would open a Forge thread bound to this moment (Phase 2 writes a thread row via P2A-0019 but the LLM-driven response ships in Phase 3).
- [ ] **Live updates**: SSE stream from P2A-0014 keeps the cost bar, trajectory spine, and reasoning pane live without page reload.
- [ ] **Redaction**: any high-entropy or credential-shaped string is redacted-by-default per P2A-0009; a `view raw` action is available only to admins and emits an audit event.

## Reductions from the hi-fi

- **Live preview deploy iframe** (only on review handoff in the hi-fi, not here): N/A here.
- **Forge composer that actually answers "why slow?"**: ships as a thread-creation stub in v0; LLM responses are Phase 3.
- **`pace_anomaly` callout**: in scope for v0; `stuck` is Phase 3.

## Done when

An operator viewing a live or completed run sees a correct cost bar across all four sources, a streaming trajectory spine, a writer reasoning pane that renders intent / BDD / tool calls / decisions from the typed event payloads (not stdout strings), and a working ask-forge button that creates a thread record.
