# Failure recovery (P2B-0008)

When a run halts, it is a dead end until an operator recovers it. The dashboard
surfaces every halted run and offers four recovery actions — all without the
CLI or DB access.

## What routes here

A run lands on the recovery surface when its `outcome ∈ {halted,
escape_hatch_hit, retry_budget_exhausted, window_exhausted}` (or its status is
`halted`). The sidenav **halted runs** row (`/runs/halted`) lists them; each
links to its per-run recovery surface at `/runs/:runId/recover`.

## The recovery surface

- **Failure context** — four cells: what blocked it (from the planner-feedback
  loop's auditor/checker rejection events), last good commit, downstream specs
  blocked (from `dependsOn` edges), and elapsed/retries/$ at the hatch.
- **Recovery chat** — templated v0 narration analyzing the failure and pointing
  at the recommended path (thick Forge LLM responses are Phase 3).
- **Recovery cards** — the four actions plus a last-resort abandon link.
- **DAG impact** — a flat list of downstream-blocked specs (full DAG layout is
  Phase 3).

## The four recovery actions

Each action enforces org + project + run access, persists a typed
`recovery.*` lineage event on the **original halted run** (so the run-detail
history shows the halt → recover chain), and — where it re-runs work — queues a
fresh planner run that the P2A-0012 loop picks up.

| Action | What it does | Guardrail |
| --- | --- | --- |
| **revise the spec** | Records the intent + opens the P2B-0003 spec-edit form. On submit you replan with the revised spec. | — |
| **replan with instructions** | Appends your steering note to the spec and re-invokes the planner. | Empty note is rejected. |
| **rollback the code** | Resets the workspace to a named known-good commit and re-queues from there. | Disabled when no prior commit exists; requires an explicit confirm checkbox before it submits. |
| **resolve via conversation** | Opens a run-scoped Forge inspection thread with read access to the disagreement history. | Read-only — changes no state. |

## Lineage

Recovery actions persist into the `events` table as `recovery.revise_routed`,
`recovery.replan_queued`, `recovery.rollback_queued`, and
`recovery.inspection_opened` events bound to the halted run. There is no
separate lineage table — the events row IS the lineage record, so a recovered
run's history reads halt → revise → replan in the run-detail event list.

## Recovering an auditor-disagreement halt (the canonical path)

1. A fixture-medium run halts with `retry_budget_exhausted` after the auditor
   and writer disagree three times on a behavior.
2. Open it from **halted runs**. The context strip shows "auditor disagrees
   with writer".
3. Pick **revise the spec**, split the ambiguous behavior into verifiable
   criteria, and submit.
4. Pick **replan with instructions** with a steering note. A fresh planner run
   is queued and runs to completion on the happy path.
5. The run-detail history shows the halt → revise → replan chain.

A `run.halted` notification fires through P2A-0017 per the operator's
notification-matrix config when a run halts.
