# Routing & limits settings

**Surface**: the per-project routing chain editor, Vault credential policy display, and escape-hatches editor.

**Owning spec**: P2B-0003 (see [`ROADMAP.md`](../../../ROADMAP.md)).

**Hi-fi reference**: `tanren-hi-fidelity/project/view-settings.jsx`.

## In scope for Phase 2

- [ ] **6-role fallback chain editor**: rows are `plan`, `write`, `check`, `audit`, `demo`, `forge`. Each row contains an ordered list of `(cli, model, authRef, healthHint)` entries with drag-to-reorder, add-fallback, and remove actions. Health hint is a colored pill: `ok`, `warn`/`rate-limited`, `fail`. The schema accepts entries for any v0 or future provider; v0 only ships Codex bindings that are functional.
- [ ] **Per-role descriptions**: each role row shows its responsibility text (e.g. "plan — spec → ordered subtasks · runs once per loop", "demo — spec-completion narration for review · cheap, optional"). The Forge row explicitly names its read-only-with-write-buttons contract.
- [ ] **Vault per-cred policy panel**: read-only list of Vault entries with label, path, rotation policy, and a contextual detail line (e.g. "session cookie refreshes on each runner launch · no manual rotation needed"). No values rendered.
- [ ] **Escape hatches editor**: card row per limit — max writer iter per subtask (default 5), max planner re-runs per spec (default 3), max retries per task on transient fail (default 3), max spec-discovery rounds (default 20). Each card shows the "on exceed" action (escalate, try next fallback, halt). Header copy explicitly names "escape hatches, not perf budgets" with the brief explanation.
- [ ] **Conditional audit-gate UI**: a panel at the bottom of the page shows the config-edit input. When the org's `auditGateEnabled` setting is on, the caption reads "edits land as a pr in `<org>/tanren-config` · review before merge"; when off (the default), it reads "edits land in the dashboard · no PR required".
- [ ] **Save flow**: edits to the matrix or escape hatches save to DB. When the audit gate is **on**, a Bucket-B change (routing chains + escape-hatch limits) does not apply directly — it renders as a `tanren.yaml` diff, opens a PR in the configured `tanren-config` repo, and applies to the DB only on merge (apply-on-merge); see `engine/config/tanrenConfigGate.ts`. Save shows the previous value as a diff cue per edit.

## Reductions from the hi-fi

- **`tanren-config` audit-gate PR write path**: shipped — an org toggle (`auditGateEnabled`) routes Bucket-B config writes through a `tanren-config` PR with apply-on-merge.
- **Forge-authored config-edit PRs**: not built as a Forge tool. The four propose-able write tools are `create_spec` / `trigger_run` / `rerun_task` / `acknowledge_insight`; config edits flow through the routing editor's gated save path, not a Forge NL config tool.
- **Health pills** for cli/model availability: only `ok` is wired (Codex). `warn` / `fail` states render correctly but their live data source (provider expansion + rate-limit observability) is future work.

## Done when

An operator can edit the routing chain for any role on a v0-supported provider (Codex), reorder fallback entries, change retry budgets via the escape-hatches editor, save the configuration to DB, and see those choices reflected in the next live run's task routing decisions.
