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
    contract: { id: "contract_a", hash: "sha256:" + "b".repeat(64), sourceRevision: "revision_a" },
    baseline: run,
    counterfactual: run,
    soak: null,
    merge: { authorityAuditId: "audit_a", sha: run.mergeSha },
    deployment: { releaseInstanceId: "release_a", artifactDigest: run.artifactDigest, mergeSha: run.mergeSha },
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
  public readonly sourceSyncOutbox: Array<Record<string, unknown>> = [];
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
      const [
        orgId,
        projectId,
        id,
        resolutionJobId,
        issueLoopId,
        decision,
        decisionReasons,
        authorityVersion,
        contractId,
        releaseInstanceId,
        verificationRunId,
        inputSnapshotHash,
      ] = params;
      if (this.decisions.some((row) => row["org_id"] === orgId && row["id"] === id)) return { rows: [], rowCount: 0 };
      this.decisions.push({
        org_id: orgId,
        project_id: projectId,
        id,
        resolution_job_id: resolutionJobId,
        issue_loop_id: issueLoopId,
        decision,
        decision_reasons: JSON.parse(String(decisionReasons)),
        authority_version: authorityVersion,
        contract_id: contractId,
        release_instance_id: releaseInstanceId,
        verification_run_id: verificationRunId,
        input_snapshot_hash: inputSnapshotHash,
      });
      return { rows: [{ id }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE issue_loops")) {
      this.loopState = String(params[2]);
      return { rows: [{ source_id: "src_a" }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT 1 FROM resolution_decisions AS decision")) {
      const [orgId, decisionId, issueLoopId, sourceId] = params;
      const authorized = this.decisions.some(
        (decision) =>
          decision["org_id"] === orgId &&
          decision["id"] === decisionId &&
          decision["issue_loop_id"] === issueLoopId &&
          sourceId === "src_a" &&
          (decision["decision"] === "authorized" || decision["decision"] === "waived"),
      );
      return authorized ? { rows: [{ "?column?": 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("INSERT INTO source_sync_outbox")) {
      const [orgId, id, issueLoopId, sourceId, operation, payload, payloadHash, resolutionDecisionId] = params;
      if (this.sourceSyncOutbox.some((row) => row["org_id"] === orgId && row["id"] === id))
        return { rows: [], rowCount: 0 };
      const now = new Date();
      const row = {
        org_id: orgId,
        id,
        issue_loop_id: issueLoopId,
        source_id: sourceId,
        operation,
        state: "pending",
        payload: JSON.parse(String(payload)),
        payload_hash: payloadHash,
        resolution_decision_id: resolutionDecisionId,
        attempt: 0,
        next_attempt_at: now,
        provider_receipt: null,
        readback: null,
        last_error: null,
        claim_owner: null,
        claim_expires_at: null,
        created_at: now,
        updated_at: now,
      };
      this.sourceSyncOutbox.push(row);
      return { rows: [row], rowCount: 1 };
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
  it("appends a hashed decision once, queues source sync, transitions only through the authority, and emits frozen events", async () => {
    const pool = new ResolutionAuthorityMemoryPool();
    const evidence = snapshot();
    const hash = resolutionSnapshotHash(evidence);
    const store = new PgResolutionAuthorityDecisionStore(pool as never);

    await expect(
      store.record({
        snapshot: evidence,
        decision: "authorized",
        decisionReasons: [],
        authorityVersion: "tanren-resolution-authority.v1",
        inputSnapshotHash: hash,
      }),
    ).resolves.toMatchObject({
      created: true,
      id: expect.stringContaining("rdec_"),
    });
    await expect(
      store.record({
        snapshot: evidence,
        decision: "authorized",
        decisionReasons: [],
        authorityVersion: "tanren-resolution-authority.v1",
        inputSnapshotHash: hash,
      }),
    ).resolves.toMatchObject({
      created: false,
    });
    expect(pool.decisions).toEqual([
      expect.objectContaining({
        decision: "authorized",
        decision_reasons: [],
        authority_version: "tanren-resolution-authority.v1",
        contract_id: "contract_a",
        release_instance_id: "release_a",
        verification_run_id: "vrun",
        input_snapshot_hash: hash,
        resolution_job_id: "rjob_a",
      }),
    ]);
    expect(pool.loopState).toBe("verified_source_sync_pending");
    expect(pool.sourceSyncOutbox).toEqual([
      expect.objectContaining({
        issue_loop_id: "iloop_a",
        source_id: "src_a",
        operation: "close",
        state: "pending",
      }),
    ]);
    expect(pool.events.map((event) => event["event_type"])).toEqual([
      "source_issue.sync.enqueued",
      "resolution.authorized",
    ]);
  });
});
