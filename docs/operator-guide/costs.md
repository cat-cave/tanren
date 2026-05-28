# Costs

Tanren records the dollar cost of every real Codex planner/writer/checker/auditor call
in the `cost_records` table. P2A-0011 makes the recorder mandatory: a task cannot
complete without a `cost_records` row, and there is no `unknown_source` fallback —
unattributable usage fails the task with `failureKind="cost.unattributable"` and
halts the run.

## The three v0 cost models

PROJECT_BRIEF §4 defines three first-class cost models. Tanren implements all
three; the table below maps each model to the credential prefix and the v0
formula used to compute the dollar figure.

| Model                  | `cost_source`          | `pricing_mode`        | Credential prefix              | Formula                                                                                                              |
| ---------------------- | ---------------------- | --------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Token-billed (§4.1)    | `provider_direct`      | `per_token`           | `credential/openai-api/...`    | `(input_tokens * input_rate + output_tokens * output_rate + cached_tokens * cached_rate) / 1_000_000`                |
|                        |                        |                       | `credential/anthropic/...`     | Rate table lives in `services/orchestrator/src/engine/costs/sources.ts`.                                             |
|                        |                        |                       | `credential/openrouter/...`    |                                                                                                                      |
| Subscription (§4.3)    | `codexbar`             | `subscription_window` | `credential/codex/...`         | `(subscription_monthly_fee / observed_max_monthly_tokens) * tokens_used`                                             |
| Flat-fee self-host §4.2 | `opportunity_computed` | `opportunity_cost`    | `credential/self-hosted/...`   | `hourly_opportunity_cost * (runtime_seconds / 3600)`                                                                  |

The CHECK constraint on `cost_records.cost_source` admits these three plus the
historical `ccusage` value reserved for future Claude-window probes; v0 never
writes `ccusage`. There is no placeholder source — see `AGENTS.md`.

## Attribution rules

The recorder reads the adapter's `authRef` (the same Vault path the writer or
answerer used to authenticate) and classifies it:

1. `credential/codex/...` → `codexbar` (Codex CLI consuming a ChatGPT
   subscription). Never `provider_direct`, even though the underlying provider
   is OpenAI — a ChatGPT-Pro operator does not pay per token.
2. `credential/anthropic/...`, `credential/openai-api/...`,
   `credential/openrouter/...` → `provider_direct` with the matching rate
   table entry.
3. `credential/self-hosted/...` → `opportunity_computed` with the configured
   hourly opportunity cost (default $0.50/hour in v0).
4. Anything else → the recorder raises `CostUnattributableError`. The task
   fails with `failureKind="cost.unattributable"`, an event named
   `cost.unattributable` is appended, and the run halts. **No cost row is
   written in this case** — by design.

Adapters that do not exercise a real LLM (the hello-world fake adapters and
fixture tests) declare `authRef = "credential/self-hosted/tanren-fake"` so the
recorder still runs the full attribution path. Their dollar figures are
synthetic and intentionally tiny.

## Subscription-window denominator refinement

`codexbar` cost relies on a denominator — the operator's observed maximum
monthly token throughput at a given credential. The v0 default is
intentionally conservative: a brand-new `credential/codex/...` ref starts with
a theoretical max of 50 million tokens/month, which keeps the per-call dollar
figure small until real usage history accumulates.

After every `codexbar` write the recorder:

1. Sums `input_tokens + output_tokens + cached_tokens` over the last 30 days
   of `cost_records` rows at that `authRef`.
2. Upserts the value into `subscription_window_denominators` (a single row
   per auth ref).
3. The next `codexbar` attribution reads that row before computing the
   dollar figure, so estimates refine over time.

A first month under-counts dollars (small denominator until history grows).
This is the documented PROJECT_BRIEF §4.3 behavior.

## Operational checks

* Query `SELECT cost_source, COUNT(*) FROM cost_records GROUP BY cost_source`.
  Every value must be one of `provider_direct`, `codexbar`,
  `opportunity_computed`. The CHECK constraint enforces it; the recorder
  refuses to write anything else.
* Query `SELECT t.task_id FROM tasks t LEFT JOIN cost_records c ON
  c.task_id = t.task_id WHERE t.status = 'done' AND c.id IS NULL`. A
  successful task without a cost row is a P2A-0011 invariant violation.
* `events.event_type = 'cost.unattributable'` rows are the audit trail for
  failed attribution attempts. Each row carries the adapter's `authRef`
  (redacted) and the matched reason.

## Rate-table updates

`services/orchestrator/src/engine/costs/sources.ts` pins per-provider rates at
known v0 list prices (OpenAI $2.50/$10 per million for input/output, Anthropic
$3/$15, OpenRouter $5/$15). Updating these is a one-line edit in that file;
keep `docs/operator-guide/costs.md` synchronized with the source date and
include the upstream link in the commit message (see AGENTS.md "Version
Verification").
