# Failure recovery

**Surface**: the dedicated page a halted run routes to — context cells, four recovery cards, downstream-impact list.

**Owning spec**: P2B-0008 (see [`ROADMAP.md`](../../../ROADMAP.md)).

**Hi-fi reference**: `tanren-hi-fidelity/project/view-failure.jsx`.

## In scope for Phase 2

- [ ] **Page head**: eyebrow with halted-run framing, title "get the engine moving again", sub-line naming run id, spec id, retry exhaustion, elapsed, dollar spent. A halted-pill in the action area.
- [ ] **Failure context strip**: four cells —
  - **What blocked it**: a structured reason from the planner-feedback loop in P2A-0012 (e.g. "auditor disagrees with writer · 3×").
  - **Last good state**: commit SHA + ago.
  - **Blocks downstream**: count of downstream specs blocked (from P2A-0018 dependency edges) with a one-line list.
  - **Elapsed at hatch**: time + retry count + dollar burned + which escape hatch fired.
- [ ] **Recovery chat** (left, scrollable): a Forge thread bound to the halted run rendering an opening turn analyzing the failure, a recommended-path turn pointing to one of the four recovery cards, and a third turn offering steering. The thick real-LLM Forge author drives these turns (shipped); the templated narration generator remains available for the deterministic pulse turn.
- [ ] **Recovery cards** (right):
  - **Revise the spec** (often the recommended): opens a spec-edit form via P2A-0013 / P2A-0018 with a "split behavior · 5 → 5a + 5b" affordance for the failing behavior. On submit, the planner is re-invoked with the revised spec.
  - **Replan with instructions**: presents a textarea for operator steering, then routes through P2A-0012 to re-invoke the planner with the steering note appended to the spec.
  - **Rollback the code**: shows the last-good commit, offers a rollback action that resets the workspace to that commit and re-queues from there. Requires explicit confirmation.
  - **Resolve via conversation**: opens an inspection thread (Forge thread bound to the run with read access to the auditor/writer disagreement history). Operator reads + decides; the thread doesn't trigger any state change by itself.
  - **Last-resort · abandon**: cancels the run, moves the spec to backlog, preserves the workspace; downstream specs stay blocked.
- [ ] **DAG impact strip**: flat list (not a layout) of downstream-blocked specs with a "→ M4 finish" rendering. (The full DAG canvas now ships in project view; this surface keeps the flat list.)
- [ ] **Notifications**: halting fires `run.failed` through P2A-0017; the operator gets a ntfy notification per matrix config. The persisted run status may be `halted` while the terminal event is `run.failed`.

## Reductions from the hi-fi

- **Full DAG layout strip on this page**: this surface keeps the flat downstream-blocked list; the full DAG canvas lives in project view.
- **"Show me the disagreement" pane that renders the auditor's last N verdicts side-by-side**: ships as a basic event-history list; structured verdict-comparison rendering remains future polish.
- **Forge LLM-driven recovery suggestions tailored to the specific failure**: shipped — the thick real-LLM Forge author drives the recovery chat.

## Done when

A fixture-medium run forced to halt by an auditor-disagreement scenario routes to this page. The operator can pick "revise the spec", edit the failing behavior, and submit, after which the spec re-runs and (in the happy path) completes successfully. Lineage records survive across the recovery so the run-detail history shows the halt → revise → replan chain.
