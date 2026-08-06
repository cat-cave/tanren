// 0113's JSON→rows member backfill: the predicate that decides which legacy
// `integration_nodes.members` elements become authoritative `integration_node_members` rows.
//
// WHY A SQL-TEXT TEST. This repo has no harness that can APPLY a migration inside a unit
// run: no pg-mem/PGlite, `db/src/migrate.ts` needs a real server, and the only suites that
// drive it are the env-gated `*.integration.test.ts` ones. Rather than fake an execution,
// this pins the two predicate properties that make the backfill safe, both of which are
// mechanically checkable in the statement text — and both of which the pre-fix predicate
// violated. The behaviors they stand for, verified against a real PostgreSQL 18:
//   - `[{"specId":"s","runId":"r","branch":null,"headSha":"abc"}]` → the OLD predicate
//     aborts the whole migration with `null value in column "branch" … violates not-null`,
//     because `elem ? 'branch'` is TRUE when the KEY exists with a null VALUE. The new one
//     applies cleanly and writes zero rows for that node.
//   - a two-element array whose SECOND element is bad → the OLD predicate writes ONE row
//     (the good element), leaving the member rows and the JSON mirror disagreeing so
//     `sameOrderedMembers` fails that node closed forever. The new one writes ZERO.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../migrations/0113_authoritative_integration_lineage.sql", import.meta.url),
);

/** The single backfill statement (the `INSERT … ON CONFLICT DO NOTHING;` at the tail). */
async function backfillStatement(): Promise<string> {
  const sql = await readFile(migrationPath, "utf8");
  const start = sql.indexOf('INSERT INTO "integration_node_members"');
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start);
}

const REQUIRED_FIELDS = ["specId", "runId", "branch", "headSha"] as const;

describe("0113 member backfill predicate", () => {
  it("guards EVERY NOT NULL member field against null-or-empty, not just specId/runId", async () => {
    const statement = await backfillStatement();
    for (const field of REQUIRED_FIELDS) {
      // `COALESCE(x ->> 'f', '') <> ''` rejects a missing key, an explicit null, AND an empty
      // string. Empty strings matter as much as nulls: they satisfy the NOT NULL column but
      // `decodeMembersStrict` rejects them, so the node becomes permanently unreadable.
      expect(statement).toContain(`COALESCE(elem ->> '${field}', '') <> ''`);
    }
  });

  it("does not rely on key-existence (`?`) for the guard — it is true for a null value", async () => {
    const statement = await backfillStatement();
    // The negative control for the abort: `elem ? 'branch'` passes `{"branch": null}` straight
    // into a NOT NULL column.
    expect(statement).not.toMatch(/elem \? '(specId|runId|branch|headSha)'/u);
  });

  it("is node-level all-or-nothing so a partially-bad node is skipped WHOLE", async () => {
    const statement = await backfillStatement();
    // Per-element filtering alone would truncate a node's vector, and normalized rows that
    // disagree with the JSON mirror fail `sameOrderedMembers` closed for that node forever.
    // The node-level `NOT EXISTS` re-scans the SAME array and skips the node entirely.
    expect(statement).toMatch(/NOT EXISTS\s*\(/u);
    const guard = statement.slice(statement.indexOf("NOT EXISTS"));
    expect(guard).toContain('FROM jsonb_array_elements(n."members")');
    for (const field of REQUIRED_FIELDS) {
      expect(guard).toContain(`COALESCE(bad.elem ->> '${field}', '') = ''`);
    }
  });
});
