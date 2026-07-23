// Issue #1072 F2 PROOF: a project ROW that EXISTS but carries `org_id = NULL` must NOT
// drain silently. Such a project can never enqueue (no tenant scope ⇒ RLS denies every read),
// and — unlike the corrupt-config path, which emits `dag.config.corrupt` — the null-org drain
// previously returned `projectLifecycle: "missing"` with NO signal at all. A misconfigured
// project would vanish from the timeline with no way for an operator to see WHY.
//
// The fix cannot durably append an org-scoped `dag.*` event (there is no org to scope it to,
// and `events.org_id` is NOT NULL + FK-tied — the doctrine is never to fake tenancy), so the
// loud signal is a grep-able ERROR log naming the project + `reason: null_org_project`,
// mirroring the precedent `dagEventEmitterPg.withScopedStore` already set for the null-org
// event-drop case. A GENUINELY ABSENT row (a benign teardown race) must stay quiet — only the
// present-row misconfiguration is loud.
//
// Driven through PgDagReadModel with a fake pg.Pool (the same double the stable-order test uses)
// and a console.error spy, asserted deterministically with no DB.

import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDagReadModel } from "../src/engine/dag/walkerPg.js";

/**
 * A pg.Pool double for PgDagReadModel's project probe. `projectRow` is what the
 * system-scoped `SELECT org_id, lifecycle FROM projects` returns:
 *   - an object ⇒ the row is PRESENT (rowCount 1);
 *   - `undefined` ⇒ the row is ABSENT (rowCount 0 — the teardown-race case).
 * The spec select is never reached on the null-org branch (loadSnapshot returns first).
 */
function fakePool(projectRow?: { org_id: string | null; lifecycle: string }): pg.Pool {
  const client = {
    query: async (sql: string): Promise<{ rows: unknown[]; rowCount: number }> => {
      const text = sql.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/u.test(text)) {
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith("SELECT org_id, lifecycle FROM projects")) {
        return projectRow === undefined ? { rows: [], rowCount: 0 } : { rows: [projectRow], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  return {
    connect: async () => client,
    query: client.query,
  } as unknown as pg.Pool;
}

describe("PgDagReadModel — null-org drain is LOUD, absent-row drain is quiet (issue #1072 F2)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // log.error routes to console.error (structured JSON line). Silence + capture it.
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("a PRESENT project row with org_id = NULL drains but surfaces a LOUD null_org_project error (not silent)", async () => {
    // A misconfigured project: the row exists (even lifecycle `active`) but has no org.
    const model = new PgDagReadModel(fakePool({ org_id: null, lifecycle: "active" }));

    const snapshot = await model.loadSnapshot("project_null_org");

    // Still drains cleanly (no schedule), same fail-closed outcome as before...
    expect(snapshot).toEqual({ projectId: "project_null_org", nodes: [], projectLifecycle: "missing" });

    // ...but NOT silently: exactly one loud ERROR line names the project + reason so an operator
    // has a grep-able signal instead of an invisible drain.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = errorSpy.mock.calls[0]?.[0] as string;
    expect(line).toContain("null_org_project");
    expect(line).toContain("project_null_org");
    expect(line).toMatch(/"level":"error"/u);
  });

  it("a GENUINELY ABSENT project row (teardown race) drains QUIETLY — no false alarm", async () => {
    // The benign case: the project row is gone. Nothing to signal; must stay silent.
    const model = new PgDagReadModel(fakePool());

    const snapshot = await model.loadSnapshot("project_gone");

    expect(snapshot).toEqual({ projectId: "project_gone", nodes: [], projectLifecycle: "missing" });
    // No loud signal for a benign absent row — only the present-row misconfiguration is loud.
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
