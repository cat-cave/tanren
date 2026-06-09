// apex pre-run §7.5 — the triage/discovery grounding query is BOUNDED: it caps the
// rows + orders active-first then by recency, instead of rendering EVERY spec
// title-ordered with no LIMIT (which bloats every grounding prompt on a long-lived
// project). Asserted at the query level with a capturing fake client.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { DiscoveryStore } from "../src/engine/repositories/discovery.js";
import { systemActor } from "../src/engine/state/actor.js";

type QueryClient = Pick<pg.Pool, "query">;

function capturingClient(rows: Array<{ spec_id: string; title: string; status: string }>): {
  client: QueryClient;
  captured: { sql: string; params: unknown[] }[];
} {
  const captured: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: (async (sql: string, params: unknown[]) => {
      captured.push({ sql, params });
      return { rows, rowCount: rows.length };
    }) as unknown as pg.Pool["query"],
  };
  return { client, captured };
}

describe("DiscoveryStore.listExistingSpecs — bounded grounding (§7.5)", () => {
  it("caps the row count with a LIMIT and orders active-first then by recency", async () => {
    const { client, captured } = capturingClient([
      { spec_id: "spec_1", title: "B", status: "in_flight" },
      { spec_id: "spec_2", title: "A", status: "merged" },
    ]);
    const result = await DiscoveryStore.listExistingSpecs(client, "proj_1", systemActor);

    expect(result).toHaveLength(2);
    const { sql, params } = captured[0]!;
    // It is bounded: a LIMIT bound param is threaded.
    expect(sql).toContain("LIMIT $2");
    expect(typeof params[1]).toBe("number");
    expect(params[1] as number).toBeGreaterThan(0);
    // Active (non-terminal) specs sort FIRST, then recency — NOT title-ordered.
    expect(sql).toContain("status IN ('open','in_flight','review','needs_attention')");
    expect(sql).toContain("created_at DESC");
    expect(sql).not.toContain("ORDER BY title");
  });
});
