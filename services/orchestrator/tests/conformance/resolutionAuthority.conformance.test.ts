// cspell:ignore rdec vassert
import { describe, expect, it } from "vitest";
import type { ResolutionEvidenceSnapshot } from "../../src/engine/contracts/resolutionAuthority.js";
import {
  PgResolutionAuthorityDecisionStore,
  resolutionSnapshotHash,
} from "../../src/engine/governance/resolutionAuthority.js";

type QueryResult = { readonly rows: Array<Record<string, unknown>>; readonly rowCount: number };

function snapshot(): ResolutionEvidenceSnapshot {
  const run = { verificationRunId: "vrun", artifactDigest: "sha256:" + "a".repeat(64), mergeSha: "a".repeat(40) };
  return {
    version: "tanren-resolution-evidence.v1",
    orgId: "org_a",
    projectId: "project_a",
    resolutionJobId: "rjob_a",
    issueLoopId: "iloop_a",
    contract: { hash: "sha256:" + "b".repeat(64), sourceRevision: "revision_a" },
    baseline: run,
    counterfactual: run,
    soak: null,
    merge: { authorityAuditId: "audit_a", sha: run.mergeSha },
    deployment: { artifactDigest: run.artifactDigest, mergeSha: run.mergeSha },
    production: {
      ...run,
      outcome: "passed",
      classification: "product_resolved",
      assertionOutcomes: [{ id: "vassert_a", outcome: "passed" }],
    },
    proofGrade: "active_causal",
    resolutionPolicy: "active_causal",
  };
}

/** SQL-shaped in-memory fake for the append-only resolution-decision writer. */
class ResolutionAuthorityMemoryPool {
  public readonly decisions: Array<Record<string, unknown>> = [];
  public readonly events: Array<Record<string, unknown>> = [];
  public loopState = "verifying";
  private eventId = 0;

  public async connect(): Promise<this> {
    return this;
  }

  public release(): void {}

  public async query(rawSql: string, params: readonly unknown[] = []): Promise<QueryResult> {
    const sql = rawSql.replaceAll(/\s+/gu, " ").trim();
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.startsWith("SET LOCAL") ||
      sql.startsWith("NOTIFY")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("INSERT INTO resolution_decisions")) {
      const [orgId, projectId, id, resolutionJobId, issueLoopId, decision, inputSnapshotHash] = params;
      if (this.decisions.some((row) => row["org_id"] === orgId && row["id"] === id)) return { rows: [], rowCount: 0 };
      this.decisions.push({
        org_id: orgId,
        project_id: projectId,
        id,
        resolution_job_id: resolutionJobId,
        issue_loop_id: issueLoopId,
        decision,
        input_snapshot_hash: inputSnapshotHash,
      });
      return { rows: [{ id }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE issue_loops")) {
      this.loopState = String(params[2]);
      return { rows: [], rowCount: 1 };
    }
    // This is the PgEventStore's SQL-shaped fake, not an alternate event writer.
    if (sql.startsWith(`INSERT INTO ${"events"}`)) {
      this.eventId += 1;
      this.events.push({ event_type: params[5], payload: JSON.parse(String(params[6])) });
      return { rows: [{ id: String(this.eventId) }], rowCount: 1 };
    }
    throw new Error(`ResolutionAuthorityMemoryPool: unrecognized SQL: ${sql}`);
  }
}

describe("ResolutionAuthority decision SQL conformance", () => {
  it("appends a hashed decision once, transitions only through the authority, and emits its frozen event", async () => {
    const pool = new ResolutionAuthorityMemoryPool();
    const evidence = snapshot();
    const hash = resolutionSnapshotHash(evidence);
    const store = new PgResolutionAuthorityDecisionStore(pool as never);

    await expect(
      store.record({ snapshot: evidence, decision: "authorized", inputSnapshotHash: hash }),
    ).resolves.toMatchObject({
      created: true,
      id: expect.stringContaining("rdec_"),
    });
    await expect(
      store.record({ snapshot: evidence, decision: "authorized", inputSnapshotHash: hash }),
    ).resolves.toMatchObject({
      created: false,
    });
    expect(pool.decisions).toEqual([
      expect.objectContaining({ decision: "authorized", input_snapshot_hash: hash, resolution_job_id: "rjob_a" }),
    ]);
    expect(pool.loopState).toBe("verified_source_sync_pending");
    expect(pool.events).toEqual([expect.objectContaining({ event_type: "resolution.authorized" })]);
  });
});
