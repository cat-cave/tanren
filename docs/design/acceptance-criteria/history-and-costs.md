# History & costs

**Surface**: org-level history list, total-spend stacked bar across the four cost sources, per-provider breakdown, burn projection, and headroom panel.

**Owning spec**: P2B-0005 (`docs/roadmap/phase-2b-specs.md`).

**Hi-fi reference**: `tanren-hi-fidelity/project/view-costs.jsx`. Low-fi import at `docs/design/operator-flows/history-and-costs.svg`.

## In scope for Phase 2

- [ ] **Page head**: eyebrow naming the all-sources scope, title "where the money goes", date-range filter pills (7d, 30d, 90d, all), export-csv action.
- [ ] **Total spend stacked bar**: total figure with delta-vs-projected, four-source stacked bar (per-token / subscription window / opportunity / infra), and per-source breakdown cards naming the dollar figure, percentage of total, and a short hint (e.g. "openai + claude api · ~69%"). All numbers wire to P2A-0011 cost records and respect the four cost-source colors from the design tokens.
- [ ] **Provider breakdown table**: rows are `(cli · model · auth)` triples with runs, tokens, dollar-or-equivalent, and share percent. Source-color dot prefixes each row. No unknown-source rows; every row's cost source is explicit.
- [ ] **Burn projection panel**: 14-day daily sparkline, daily-spend average, current-rate this-month figure with cap, next-30d projection range.
- [ ] **Headroom · subscription windows panel**: per-subscription headroom (e.g. "chatgpt · monthly cap unused: $X equiv left over"), opportunity (idle GPU) headroom, and a one-line callout naming the potential agent-throughput uplift if headroom were filled.
- [ ] **Observed metrics panel**: simple text grid showing specs merged, average cost per merged spec, halt-rate, median lead time, deploy frequency. Each value pulls from run outcomes; the panel header notes "reported, not targeted · steady-state first" — DORA panel is Phase 3 (this panel is the v0 stub).

## Reductions from the hi-fi

- **Subscription-window utilization heatmap**: deferred to Phase 3 (30d × 5-windows utilization rollup).
- **Full DORA panel**: Phase 3 (the v0 panel is a thin reported-only stub).
- **"Ask forge to schedule overnight audits" CTA**: Phase 3 (depends on scheduled audits library).
- **Filtering breakdown by source / provider / project**: Phase 3 (v0 ships totals across the org; per-project history is reachable from the project view).

## Done when

An operator viewing the costs surface on a stack with multiple completed Phase 1+ runs sees a complete, attributed cost picture across all three v0 cost sources plus infra. Every row has an explicit source. Burn projection and headroom panels render numbers that match the underlying run data.
