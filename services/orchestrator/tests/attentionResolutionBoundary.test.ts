import { describe, expect, it } from "vitest";
import { eventsAfterAttentionResolvedSql } from "../src/engine/workflow/attentionResolutionBoundary.js";

// The boundary is a SQL FRAGMENT spliced into somebody else's parameter list. A wrong
// placeholder index is the failure mode with no symptom: the SQL still parses, the subquery
// just reads whatever value happens to sit at that index, and the convergence history comes
// back silently blanked or silently unbounded. These tests pin that the index is the
// caller's to state and that a nonsense index is refused loudly instead of emitted.
describe("eventsAfterAttentionResolvedSql", () => {
  it("binds the spec id at the caller's placeholder index", () => {
    expect(eventsAfterAttentionResolvedSql(1)).toContain("spec_id = $1");
    expect(eventsAfterAttentionResolvedSql(3)).toContain("spec_id = $3");
    // Not merely "contains $3" — the $1 must be GONE, or a consumer binding elsewhere
    // would still silently read the first parameter.
    expect(eventsAfterAttentionResolvedSql(3)).not.toContain("$1");
  });

  it("keeps the no-resolution case unbounded via COALESCE(..., 0)", () => {
    const sql = eventsAfterAttentionResolvedSql(1);
    expect(sql).toContain("COALESCE(");
    expect(sql).toContain(", 0)");
    // `events.id` is a bigserial starting at 1, so `id > 0` admits every row.
    expect(sql.startsWith("id > COALESCE(")).toBe(true);
  });

  it("reads only the spec's own attention-resolved events", () => {
    expect(eventsAfterAttentionResolvedSql(1)).toContain("event_type = 'dag.spec.attention_resolved'");
    expect(eventsAfterAttentionResolvedSql(1)).toContain("MAX(id)");
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses the invalid placeholder index %s", (bad) => {
    expect(() => eventsAfterAttentionResolvedSql(bad)).toThrow(RangeError);
  });
});
