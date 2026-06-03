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
import { AllowAllPeerVerifier, type MtlsFetch } from "../src/engine/contracts/index.js";
import { HttpRunStateWriter } from "../src/engine/worker/index.js";
import { createInternalRunStateWriteRoutes } from "../src/routes/internal/runStateWrites.js";

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

// An org-scoped recording pool: `runWithOrgScope` (the control-plane endpoint's
// scope) checks out a client and runs BEGIN / SET LOCAL / the work / COMMIT, so the
// pool must answer `connect()`. The single client records every NOTIFY so the test
// asserts the dag-change wake fires from the control-plane create-spec path too.
function orgScopedRecordingPool(projectId: string): { pool: pg.Pool; notifies: string[] } {
  const notifies: string[] = [];
  const client = {
    query: async (sql: string): Promise<{ rows: unknown[]; rowCount: number }> => {
      const text = sql.trim();
      if (text.startsWith("NOTIFY")) {
        notifies.push(text);
        return { rows: [], rowCount: 0 };
      }
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SELECT set_config)/u.test(text)) {
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith("SELECT project_id FROM projects")) {
        return { rows: [{ project_id: projectId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
    query: client.query,
  } as unknown as pg.Pool;
  return { pool, notifies };
}

/** Route a fake MtlsFetch straight into the real internal write-routes app. */
function fetchInto(app: ReturnType<typeof createInternalRunStateWriteRoutes>): MtlsFetch {
  return (url, init) => app.request(new URL(url).pathname, init as RequestInit, { incoming: { socket: {} } });
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

  // Plane-split cold-start survival: the autonomous intake creates a spec through
  // the control-plane `/internal/create-spec` endpoint (the de-privileged data plane
  // can no longer `INSERT INTO specs` directly). The endpoint runs the SAME
  // `createSpec` server-side — so the `tanren_dag` NOTIFY MUST STILL fire there,
  // waking the walker for the freshly-created (zero-run) DAG. Without this, an
  // intake-routed spec under remote-writes would sit idle until a worker reboot.
  it("fires the dag-change NOTIFY when a spec is created via the control-plane /internal/create-spec path", async () => {
    const projectId = "project_via_control_plane";
    const { pool, notifies } = orgScopedRecordingPool(projectId);
    const app = createInternalRunStateWriteRoutes({ pool, verifier: new AllowAllPeerVerifier() });
    const writer = new HttpRunStateWriter("https://control.internal:3110", fetchInto(app));

    // The intake's auto-route actor carries the org (platform:admin) — the endpoint
    // runs createSpec under that org scope, which still funnels through the shared
    // createSpecOnClient → notifyDagChanged seam.
    const spec = await writer.createSpec({
      input: {
        projectId,
        title: "Intake-routed DAG node",
        description: "auto-routed",
        acceptanceCriteria: ["It exists"],
      },
      actor: { userId: "intake", orgId: "org_x", projectId: null, scopes: ["platform:admin"], source: "local_dev" },
    });

    expect(spec.projectId).toBe(projectId);
    // The cold-start wake fired through the control-plane create-spec path.
    expect(notifies).toContain(`NOTIFY ${DAG_CHANGE_CHANNEL}, '${projectId}'`);
  });
});
