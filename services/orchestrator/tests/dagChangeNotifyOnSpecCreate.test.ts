// The producer half of the spec-creation → DagWalker wake (subscriber.ts): proves
// `createSpec` fires `NOTIFY tanren_dag, '<projectId>'` at the INSERT seam, so a
// freshly-derived/created DAG (pending specs, ZERO runs — the run-activity channel
// never fires for it) wakes the walker without a worker reboot. The consumer half
// (the subscriber walking on a dag-change wake) is covered in
// dagWalkerSubscriber.test.ts; the NOTIFY statement shape in notify.test.ts. The
// derive / discovery-accept / brownfield-seed paths all funnel through `createSpec`,
// so emitting here covers them all.

import { DAG_CHANGE_CHANNEL } from "@tanren/db";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { createSpec } from "../src/engine/workflow/projectSpec.js";

// A minimal pool answering only the reads `createSpec` issues on the null-org
// (pool) path, and recording every NOTIFY statement so the test can assert the
// dag-change wake fired on the SAME client as the spec INSERT.
function recordingPool(projectId: string): { pool: pg.Pool; notifies: string[] } {
  const notifies: string[] = [];
  const query = async (sql: string): Promise<{ rows: unknown[]; rowCount: number }> => {
    const text = sql.trim();
    if (text.startsWith("NOTIFY")) {
      notifies.push(text);
      return { rows: [], rowCount: 0 };
    }
    // ensureProjectExists: the project is present.
    if (text.startsWith("SELECT project_id FROM projects")) {
      return { rows: [{ project_id: projectId }], rowCount: 1 };
    }
    // INSERT INTO specs + any other read default to a benign empty result.
    return { rows: [], rowCount: 0 };
  };
  return { pool: { query } as unknown as pg.Pool, notifies };
}

describe("createSpec dag-change wake", () => {
  it("fires NOTIFY on the dag-change channel with the project id when a spec is created", async () => {
    const projectId = "project_fresh";
    const { pool, notifies } = recordingPool(projectId);

    // Null-org actor ⇒ the direct pool path (no org scope), so the recording pool
    // sees both the INSERT and the trailing NOTIFY on the same client.
    const spec = await createSpec(pool, {
      projectId,
      title: "First DAG node",
      description: "The first ready spec",
      acceptanceCriteria: ["It exists"],
    });

    expect(spec.projectId).toBe(projectId);
    expect(spec.status).toBe("pending");
    expect(notifies).toContain(`NOTIFY ${DAG_CHANGE_CHANNEL}, '${projectId}'`);
  });
});
