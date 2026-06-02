# Budget model — flexible, itemized cost governance (design)

Tanren spends **real money, autonomously, on the user's behalf**, across several
distinct resource types. Budget is therefore not a nice-to-have dial — it is the
core cost-governance + safety primitive. This doc records where the budget model
is, what the flexible long-term shape should be, and whether/when itemized
(per-dimension) budgets are worth building. It is a design reference, not a
runbook.

> **Principle (binding).** A budget is a **configuration setting on an org/project
> basis — never an environment variable or deployment tweak.** It is data, like
> `governancePosture` / `reviewPolicy`. (The original `TANREN_BUDGET_CEILING_USD`
> env var was dead on arrival — nothing read it — for exactly this reason.)

## v0 — what is built now

A single **total dollar ceiling** as a project/org config knob, enforced by the
DagWalker:

- Config: `budget: { ceilingUsd, period }` on project config, with an org-level
  default the project overrides (merged like every other setting).
- Enforcement: before enqueuing new spec runs in a tick, the walker sums the
  project's real spend from `cost_records` over the period; at/above the ceiling
  it enqueues nothing and emits the (now genuinely budget-meaning) `dag.budget.paused`.
  In-flight runs finish (they are already bounded by the iteration escape-hatches);
  the gate stops **new** work.
- API: `GET .../projects/:id/budget` (read: ceiling, period, spent, remaining,
  paused) and `PUT .../projects/:id/budget` (update). Unlimited when unset.

v0 is sufficient for the immediate need (a hard, observable, operator-settable
project ceiling). Everything below is the forward shape.

## The cost dimensions Tanren actually incurs

Itemized budgeting only makes sense against the real cost levers. Tanren's spend
breaks down into genuinely independent dimensions a user may want to govern
separately:

| Dimension             | What it is                                                                                                                           | Tracked today?                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **LLM / tokens**      | planner/writer/checker/auditor/forge model calls; the dominant cost. Per-role, per-provider (managed router vs BYOK), tokens in/out. | **Yes** — `cost_records` with the 4-source basis (ccusage / provider_pricing) + the managed-mode margin line. |
| **Compute / VM**      | allocator VMs per run (Hetzner/cloud), priced per-hour × duration.                                                                   | **No** — VMs are provisioned + torn down but not dollarized into `cost_records`.                              |
| **Integration / API** | Sentry, Linear, Slack, etc. — some metered, some flat.                                                                               | **No.**                                                                                                       |
| **Deploy / hosting**  | preview deploys + the built product's runtime (Vercel/Fly build minutes + hosting).                                                  | **No.**                                                                                                       |
| **CI**                | GitHub Actions minutes (matters on private repos).                                                                                   | **No.**                                                                                                       |

**The gating insight: itemized budgets require itemized cost _tracking_ first.**
Today only the LLM dimension is dollarized. A per-dimension ceiling over
un-recorded spend would be fiction. So the real prerequisite is extending
`cost_records` with a **`dimension`/`category`** tag (`llm` | `compute` |
`integration` | `deploy` | `ci`) and emitting cost rows for the non-LLM
dimensions (VM-hours at allocation/teardown, deploy at deploy, CI at poll). Once
every dollar Tanren spends is a tagged `cost_records` row, every budget — total or
itemized — is just a grouped sum-and-compare.

## The flexible budget model (target)

A budget is the cross-product of four axes. v0 fixes three of them (total
dimension, project scope, pause action); the flexible model makes each explicit:

1. **Scope** — `org` ▸ `project` ▸ `run`/`spec`. Hierarchical: the org cap is the
   umbrella; project caps are bounded by it; a per-run cap bounds a single unit of
   work (a runaway spec can't drain the project). Resolution mirrors the existing
   org-default → project-override config merge.
2. **Dimension** — `total` (umbrella) plus optional per-dimension sub-ceilings:
   `{ total?, llmUsd?, computeUsd?, integrationUsd?, deployUsd?, ciUsd?, tokens? }`.
   A sub-ceiling hit pauses (by policy) either just that dimension's work or the
   whole project. Independent levers are the whole point — "up to $200 on LLM but
   cap VMs at $20" is a real ask total-only can't express. Note `tokens` as a
   first-class **non-dollar** budget: some users/quotas think in tokens, and it
   maps onto the provider-window concept that already exists (`window_exhausted`).
3. **Period** — `total` (lifetime) | `monthly` (billing-aligned) | `weekly` |
   `rolling-N-days` | `per-run`. The window the sum is taken over.
4. **Action on exhaustion** — `pause` (hold new work, in-flight completes — v0
   default) | `hard_halt` (also stop in-flight) | `warn_only` (the old
   narration behavior, made explicit) | `require_approval` (pause + an operator
   must raise the ceiling to continue). Plus a **soft threshold** (warn at e.g.
   80%) distinct from the **hard** ceiling (act at 100%).

So a budget entry is `(scope, dimension, period, ceiling, action, softThreshold?)`,
and a project/org carries a small list of them. v0 is the single entry
`(project, total, monthly|total, ceilingUsd, pause)`.

## Should we do itemized budgets? — recommendation

**Yes, but staged, and behind itemized cost tracking.** The dimensions above are
genuinely independent cost levers, and a managed-hosting product will want
per-dimension governance (and per-dimension transparency for billing). But it is
not worth building per-dimension ceilings before the non-LLM dimensions are even
recorded.

Staged rollout:

- **v0 (built)** — single total $ ceiling, project/org config, walker-enforced,
  GET/PUT. Covers the safety need now.
- **v1 — itemized cost tracking** — add the `dimension` tag to `cost_records`;
  emit rows for compute (VM-hours), deploy, CI, integration. This is the
  foundational data work; it also immediately enriches the existing cost views +
  the managed-mode margin breakdown. No new budget semantics yet — just make every
  dollar a tagged row.
- **v2 — itemized + scoped + policy budgets** — the full `(scope, dimension,
period, action)` model: per-dimension sub-ceilings, per-run caps, soft/hard
  thresholds, `require_approval`, and a token budget. Cheap to build once v1's data
  exists (ceilings are sums over tagged rows) and v0's walker-enforcement +
  config-merge pattern is in place.

The shape is deliberately additive: v0's `{ ceilingUsd, period }` is the
degenerate single-entry case of the v2 list, so nothing has to be unwound.
