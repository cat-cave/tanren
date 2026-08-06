// The operator-requeue CONVERGENCE-HISTORY boundary. When an operator resolves a
// `needs_attention` escalation (`requeueAttentionSpec.ts`) the spec flips back to `open`
// and a `dag.spec.attention_resolved` event lands. Until this module existed that event
// had ZERO consumers: the fixed-point readers still counted the spec's ENTIRE
// `dag.spec.redriven` history, so a requeued spec re-entered the DAG carrying every prior
// failure — the very NEXT failure of the same classified code re-tripped cycle detection
// and re-parked it almost immediately. Live evidence from a running instance: four specs
// each requeued 3-4 times and re-parked 4-5 times, with the operator's requeue buying at
// most one attempt.
//
// The boundary makes the resolution event mean what `requeueAttentionSpec.ts` always
// claimed it meant: history BEFORE the most recent resolution is spent, history AFTER it
// is the spec's fresh budget. Escalation is NOT disabled — a requeued spec that racks up a
// new cycle of same-code failures escalates again on the post-resolution evidence alone.
//
// WHY `id` AND NOT `ts`: `events.id` is a `bigserial` PRIMARY KEY — strictly monotonic with
// NO tie ambiguity. `ts` defaults to `now()`, which is the TRANSACTION timestamp, so a
// redriven event and the resolution event can share a `ts` to the microsecond (and every
// event written inside one transaction certainly does). A `ts >` comparison would then
// silently drop post-resolution re-drives (or keep pre-resolution ones, on `>=`). The
// readers keep their existing `ORDER BY ts ASC, id ASC` — the boundary changes WHICH rows
// are read, never their order.

/**
 * Build the SQL predicate restricting an `events` scan to rows strictly AFTER the spec's
 * most recent `dag.spec.attention_resolved` event, binding the spec id at `specIdParam`.
 *
 * The index is a PARAMETER and not baked in because getting it wrong fails SILENTLY: a
 * consumer that binds the spec id at `$2` still produces valid SQL, the subquery just reads
 * whatever value sits at `$1`. The boundary then blanks the history (no rows match a
 * foreign spec's resolution id) or leaves it unbounded — with no query error to notice.
 *
 * `COALESCE(..., 0)` is the no-resolution case: `events.id` is a `bigserial` starting at 1,
 * so `id > 0` admits EVERY row — a spec that has never been operator-requeued reads its
 * full history exactly as it did before this boundary existed.
 */
export function eventsAfterAttentionResolvedSql(specIdParam: number): string {
  if (!Number.isInteger(specIdParam) || specIdParam < 1) {
    throw new RangeError(`spec id placeholder must be a positive integer, got ${String(specIdParam)}`);
  }
  return `id > COALESCE(
       (SELECT MAX(id) FROM events WHERE spec_id = $${specIdParam} AND event_type = 'dag.spec.attention_resolved'), 0)`;
}
