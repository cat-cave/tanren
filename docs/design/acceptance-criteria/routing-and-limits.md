# Routing & limits settings

**Surface**: the per-project routing chain editor, Vault credential policy display, and escape-hatches editor.

**Owning spec**: P2B-0003 (`docs/roadmap/phase-2b-specs.md`).

**Hi-fi reference**: `tanren-hi-fidelity/project/view-settings.jsx`. Low-fi import at `docs/design/operator-flows/routing-and-limits.svg`.

## In scope for Phase 2

- [ ] **6-role fallback chain editor**: rows are `plan`, `write`, `check`, `audit`, `demo`, `forge`. Each row contains an ordered list of `(cli, model, authRef, healthHint)` entries with drag-to-reorder, add-fallback, and remove actions. Health hint is a colored pill: `ok`, `warn`/`rate-limited`, `fail`. The schema accepts entries for any v0 or future provider; v0 only ships Codex bindings that are functional.
- [ ] **Per-role descriptions**: each role row shows its responsibility text (e.g. "plan — spec → ordered subtasks · runs once per loop", "demo — spec-completion narration for review · cheap, optional"). The Forge row explicitly names its read-only-with-write-buttons contract.
- [ ] **Vault per-cred policy panel**: read-only list of Vault entries with label, path, rotation policy, and a contextual detail line (e.g. "session cookie refreshes on each runner launch · no manual rotation needed"). No values rendered.
- [ ] **Escape hatches editor**: card row per limit — max writer iter per subtask (default 5), max planner re-runs per spec (default 3), max retries per task on transient fail (default 3), max spec-discovery rounds (default 20 — phase-badged stub). Each card shows the "on exceed" action (escalate, try next fallback, halt). Header copy explicitly names "escape hatches, not perf budgets" with the brief explanation.
- [ ] **Conditional audit-gate UI**: a panel at the bottom of the page shows the "tell forge to change config" input. When the org's audit-gate setting is on, the panel caption reads "edits land as a pr in `<org>/tanren-config` · review before merge"; when off (Phase 2 default), it reads "edits land in the dashboard · no PR required". The audit-gate setting itself is hidden in v0 (toggleable in Phase 3); Phase 2 always renders the off state.
- [ ] **Save flow**: edits to the matrix or escape hatches save to DB via P2A-0013 (which delegates to P2A-0006). No PR is opened against any target repo. Save shows the previous value as a diff cue per edit.

## Reductions from the hi-fi

- **`tanren-config` audit-gate PR write path**: Phase 3 toggle.
- **`Forge` natural-language config editor**: ships as a stub input in v0; full Forge LLM-authored config-edit PRs are Phase 3.
- **Health pills** for cli/model availability: only `ok` is wired in v0 (Codex). `warn` / `fail` states render correctly but their data source is Phase 3 (provider expansion + rate-limit observability).

## Done when

An operator can edit the routing chain for any role on a v0-supported provider (Codex), reorder fallback entries, change retry budgets via the escape-hatches editor, save the configuration to DB, and see those choices reflected in the next live run's task routing decisions.
