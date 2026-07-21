// cspell:ignore unpartitioned
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { parseDigest } from "../src/engine/contracts/cas.js";
import { memberKey } from "../src/engine/contracts/integrationNodes.js";
import type { BatchAuthorityBinding } from "../src/engine/contracts/batchMergeCoordinator.js";
import type { LandAuthorization, LandBindingEnvelope } from "../src/engine/contracts/mergeAuthority.js";
import { applyFinalizeLand } from "../src/engine/merge/mergeAuthorityLandFinalizer.js";
import { PgLandGroupStore } from "../src/engine/merge/landGroupStore.js";
import { PgMergeQueuePartitionStore } from "../src/engine/merge/mergeQueuePartitionStore.js";
import { batchArtifactDigest, batchProofRoot } from "../src/engine/merge/multiMemberAuthorityTypes.js";

type QueryResult<Row extends object = Record<string, never>> = { rows: Row[]; rowCount: number };

class CanonicalLandClient {
  readonly events: string[] = [];
  readonly deliveryRuns: Array<{ decisionId: string; mergeSha: string }> = [];
  readonly memberOutcomes = new Map<string, string | null>();
  readonly specs = new Map<string, string>([
    ["spec-a", "in_flight"],
    ["spec-b", "in_flight"],
  ]);
  groupState = "formed";
  groupMainSha: string | null = null;
  groupCreated = false;
  receiptAuditId: string | undefined;
  private eventId = 0;

  async query<Row extends object = Record<string, never>>(
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<QueryResult<Row>> {
    const text = sql.replaceAll(/\s+/gu, " ").trim();
    if (
      text === "BEGIN" ||
      text === "COMMIT" ||
      text === "ROLLBACK" ||
      text.startsWith("SET LOCAL") ||
      text.startsWith("NOTIFY")
    ) {
      return this.rows<Row>([]);
    }
    if (text.startsWith("SELECT status FROM specs")) {
      const status = this.specs.get(String(params[1]));
      return this.rows(status === undefined ? [] : ([{ status }] as Row[]));
    }
    if (text.startsWith(["INSERT INTO", "events"].join(" "))) {
      this.events.push(String(params[5]));
      this.eventId += 1;
      return this.rows([{ id: String(this.eventId) }] as Row[]);
    }
    if (text.startsWith("UPDATE specs SET status")) {
      this.specs.set(String(params[0]), String(params[1]));
      return this.rows([]);
    }
    if (text.startsWith("INSERT INTO delivery_runs")) {
      this.deliveryRuns.push({ decisionId: String(params[3]), mergeSha: String(params[4]) });
      return this.rows([]);
    }
    if (text.startsWith("INSERT INTO authority_decisions") || text.startsWith("INSERT INTO authority_effect_intents")) {
      return this.rows([]);
    }
    if (text.startsWith("INSERT INTO land_groups")) {
      if (this.groupCreated) return this.rows([]);
      this.groupCreated = true;
      return this.rows([{ id: String(params[1]) }] as Row[]);
    }
    if (text.startsWith("INSERT INTO land_group_members")) {
      this.memberOutcomes.set(String(params[2]), "pending");
      return this.rows([]);
    }
    if (text.startsWith("SELECT state, main_sha FROM land_groups")) {
      return this.rows([{ state: this.groupState, main_sha: this.groupMainSha }] as Row[]);
    }
    if (text.startsWith("SELECT audit_id FROM authority_land_receipts")) {
      return this.rows(this.receiptAuditId === undefined ? [] : ([{ audit_id: this.receiptAuditId }] as Row[]));
    }
    if (text.startsWith("SELECT member_key, outcome FROM land_group_members")) {
      return this.rows([...this.memberOutcomes].map(([member_key, outcome]) => ({ member_key, outcome })) as Row[]);
    }
    if (text.startsWith("UPDATE land_group_members SET outcome = 'landed'")) {
      this.memberOutcomes.set(String(params[2]), "landed");
      return this.rows([]);
    }
    if (text.startsWith("SELECT count(*)::text AS count FROM land_group_members")) {
      const pending = [...this.memberOutcomes.values()].filter((outcome) => outcome !== "landed").length;
      return this.rows([{ count: String(pending) }] as Row[]);
    }
    if (text.startsWith("INSERT INTO authority_land_receipts")) {
      this.receiptAuditId = String(params[5]);
      return this.rows([]);
    }
    if (text.startsWith("UPDATE land_groups SET state = 'completed'")) {
      if (this.groupState === "completed") return this.rows([]);
      this.groupState = "completed";
      this.groupMainSha = String(params[2]);
      return this.rows([{ id: String(params[1]) }] as Row[]);
    }
    throw new Error(`unexpected canonical-land query: ${text}`);
  }

  release(): void {}

  private rows<Row extends object>(rows: Row[]): QueryResult<Row> {
    return { rows, rowCount: rows.length };
  }
}

class PartitionClient {
  status = "queued";
  owner: string | null = null;
  epoch = 0;
  unpartitioned = true;
  readonly heartbeat = new Date("2026-07-21T00:00:00.000Z");

  async query<Row extends object = Record<string, never>>(
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<QueryResult<Row>> {
    const text = sql.replaceAll(/\s+/gu, " ").trim();
    const row = () => ({
      org_id: "org-1",
      project_id: "project-1",
      queue_id: "queue-1",
      run_id: "run-a",
      spec_id: "spec-a",
      pr_url: "https://example.test/pr/1",
      pr_number: "1",
      scope_fingerprint: "scope-a",
      id: "partition-1",
      scope_key: "scope-a",
      mode: "scoped",
      generation: 2,
      capacity: 1,
      state: "active",
      lease_owner: this.owner,
      lease_epoch: this.epoch,
      lease_expires_at: this.owner === null ? null : this.heartbeat,
    });
    if (text.includes("partition_id IS NULL")) {
      if (!this.unpartitioned) return this.rows<Row>([]);
      this.unpartitioned = false;
      return this.rows([
        {
          org_id: "org-1",
          project_id: "project-1",
          queue_id: "queue-1",
          spec_id: "spec-a",
          scope_fingerprint: "scope-a",
        },
      ] as Row[]);
    }
    if (
      text.startsWith("INSERT INTO merge_queue_partitions") ||
      text.startsWith("SELECT id, scope_key, mode, generation")
    ) {
      return this.rows([{ id: "partition-1", scope_key: "scope-a", mode: "scoped", generation: 2 }] as Row[]);
    }
    if (text.startsWith("UPDATE merge_queue SET partition_id")) return this.rows([]);
    if (text.includes("JOIN merge_queue_partitions") && text.includes("status = 'queued'")) {
      return this.rows(this.status === "queued" ? ([row()] as Row[]) : []);
    }
    if (text.startsWith("SELECT count(*)::text AS count")) return this.rows([{ count: "0" }] as Row[]);
    if (text.startsWith("UPDATE merge_queue SET status = 'merging'")) {
      this.status = "merging";
      this.owner = String(params[1]);
      this.epoch += 1;
      return this.rows([{ lease_epoch: this.epoch, lease_expires_at: this.heartbeat }] as Row[]);
    }
    if (text.startsWith("UPDATE merge_queue mq SET claimed_at")) return this.rows([row()] as Row[]);
    if (text.includes("LEFT JOIN merge_queue_partitions") && text.includes("status = 'merging'")) {
      return this.rows(this.status === "merging" ? ([row()] as Row[]) : []);
    }
    if (text.startsWith("UPDATE merge_queue SET status = $4")) {
      this.status = String(params[3]);
      this.owner = null;
      return { rows: [], rowCount: 1 } as QueryResult<Row>;
    }
    throw new Error(`unexpected partition query: ${text}`);
  }

  private rows<Row extends object>(rows: Row[]): QueryResult<Row> {
    return { rows, rowCount: rows.length };
  }
}

function poolFor(client: CanonicalLandClient): pg.Pool {
  return { connect: async () => client } as unknown as pg.Pool;
}

function authorization(): { binding: BatchAuthorityBinding; authorization: LandAuthorization } {
  const members = [
    { specId: "spec-a", runId: "run-a", branch: "tanren/a", headSha: "head-a" },
    { specId: "spec-b", runId: "run-b", branch: "tanren/b", headSha: "head-b" },
  ];
  const memberSetHash = memberKey(
    "main-before",
    members.map((member) => member.headSha),
  );
  const binding: BatchAuthorityBinding = {
    nodeId: "node-exact",
    baseBranch: "main",
    baseSha: "main-before",
    headSha: "integration-head",
    treeHash: "integration-tree",
    members,
    memberSetHash,
    gateConfigHash: "gate-v1",
    policyVersion: "policy-v1",
    proof: {
      verdict: "passed",
      keyInput: {
        memberKey: memberSetHash,
        gateConfigHash: "gate-v1",
        policyVersion: "policy-v1",
        runnerImage: "runner-canonical-store",
        appEnvHash: "env-canonical-store",
        quarantineVersion: "quarantine-canonical-store",
      },
      gateProofBundleId: "gate-proof-bundle-node-exact",
      proofBundleDigest: parseDigest(`sha256:${"a".repeat(64)}`),
      proofRoot: parseDigest(`sha256:${"b".repeat(64)}`),
    },
  };
  const envelope: LandBindingEnvelope = {
    subject: { kind: "integration_node", id: binding.nodeId },
    members: members.map((member) => ({ ...member, disposition: "admit" })),
    headSha: binding.headSha,
    expectedMainSha: binding.baseSha,
    artifactDigest: batchArtifactDigest(binding),
    proofRoot: batchProofRoot(binding),
    memberSetHash: binding.memberSetHash,
    policyVersion: binding.policyVersion,
    target: { repo: { owner: "org", name: "repo" }, intoMain: "main" },
  };
  return {
    binding,
    authorization: { decision: "authorized", subject: envelope.subject, envelope, reasons: [] },
  };
}

describe("canonical queue authority durable land store", () => {
  it("forms and finalizes the exact group once, then returns the completed receipt on replay", async () => {
    const client = new CanonicalLandClient();
    const pool = poolFor(client);
    const fixture = authorization();
    const store = new PgLandGroupStore({
      pool,
      orgId: "org-1",
      projectId: "project-1",
      groupId: "group-1",
      partitionId: "partition-1",
      policyVersion: 1,
      members: fixture.binding.members.map((member, index) => ({
        ...member,
        prNumber: index + 1,
        prUrl: `https://example.test/pr/${index + 1}`,
        projectId: "project-1",
        taskId: `task-${index + 1}`,
      })),
    });

    const first = await store.persistAuthorizedDecision({ authorization: fixture.authorization });
    expect(first).toEqual({ effectIntentId: "land-group-group-1" });
    expect(client.events).toEqual(["merge.group.formed"]);

    const receipt = await store.recordLandReceipt({
      authorization: fixture.authorization,
      effectIntentId: first.effectIntentId,
      mainSha: fixture.binding.headSha,
    });
    expect(receipt).toEqual({ auditId: "run-b" });
    expect(client.specs.get("spec-a")).toBe("merged");
    expect(client.specs.get("spec-b")).toBe("merged");
    expect(client.deliveryRuns).toEqual([
      { decisionId: "decision-node-exact-integration-head", mergeSha: "integration-head" },
      { decisionId: "decision-node-exact-integration-head", mergeSha: "integration-head" },
    ]);
    expect(client.events).toEqual([
      "merge.group.formed",
      "merge.completed",
      "merge.completed",
      "merge.land_group.completed",
    ]);

    await expect(store.persistAuthorizedDecision({ authorization: fixture.authorization })).resolves.toEqual({
      effectIntentId: "land-group-group-1",
      completed: { mainSha: "integration-head", auditId: "run-b" },
    });
    await expect(
      store.recordLandReceipt({
        authorization: fixture.authorization,
        effectIntentId: "land-group-group-1",
        mainSha: fixture.binding.headSha,
      }),
    ).resolves.toEqual({ auditId: "run-b" });
  });

  it("refuses a mismatched member binding or reconciliation token before any durable write", async () => {
    const client = new CanonicalLandClient();
    const fixture = authorization();
    const store = new PgLandGroupStore({
      pool: poolFor(client),
      orgId: "org-1",
      projectId: "project-1",
      groupId: "group-1",
      partitionId: "partition-1",
      policyVersion: 1,
      members: fixture.binding.members.map((member, index) => ({
        ...member,
        ...(index === 0 && { headSha: "changed-head" }),
        prNumber: index + 1,
        prUrl: `https://example.test/pr/${index + 1}`,
        projectId: "project-1",
        taskId: `task-${index + 1}`,
      })),
    });

    await expect(store.persistAuthorizedDecision({ authorization: fixture.authorization })).rejects.toThrow(
      "land group members do not match the authorized integration",
    );
    await expect(
      store.recordLandReceipt({
        authorization: fixture.authorization,
        effectIntentId: "not-the-group-token",
        mainSha: fixture.binding.headSha,
      }),
    ).rejects.toThrow("land group reconcile token mismatch");
    expect(client.events).toEqual([]);
  });

  it("fails a direct finalizer call closed when the durable spec does not exist", async () => {
    const client = new CanonicalLandClient();
    await expect(
      applyFinalizeLand(client, {
        orgId: "org-1",
        runId: "run-missing",
        specId: "spec-missing",
        projectId: "project-1",
        taskId: "task-missing",
        prUrl: "https://example.test/pr/missing",
        prNumber: 9,
        integration: "native_queue",
        mergeSha: "integration-head",
        authorityDecisionId: "decision-node-exact-integration-head",
        auditEnvelope: { policyVersion: 1, initiatingActor: { kind: "service", id: "tanren" } },
      }),
    ).rejects.toThrow("cannot finalize land: spec spec-missing is missing");
  });

  it("adopts an unpartitioned queue member, fences its lease, and releases it durably", async () => {
    const client = new PartitionClient();
    const events = {
      emitPartitionLeased: vi.fn<() => void>(),
      emitPartitionReleased: vi.fn<() => void>(),
    };
    const store = new PgMergeQueuePartitionStore(events as never);

    await expect(
      store.getOnClient(client as never, { projectId: "project-1", targetBranch: "main", scopeFingerprint: "scope-a" }),
    ).resolves.toMatchObject({
      id: "partition-1",
    });
    const lease = await store.acquireOnClient(client as never, "queue-1");
    expect(lease).toMatchObject({
      partitionId: "partition-1",
      leaseEpoch: 1,
      generation: 2,
      scopeFingerprint: "scope-a",
    });
    expect(events.emitPartitionLeased).toHaveBeenCalledOnce();

    const renewed = await store.renewOnClient(client as never, {
      queueId: "queue-1",
      leaseOwner: lease!.leaseOwner,
      leaseEpoch: lease!.leaseEpoch,
    });
    expect(renewed).toMatchObject({ partitionId: "partition-1", leaseEpoch: 1 });
    await expect(store.claimedOnClient(client as never, "project-1")).resolves.toEqual([
      { queueId: "queue-1", leaseOwner: lease!.leaseOwner, leaseEpoch: 1 },
    ]);
    await expect(
      store.releaseOnClient(client as never, {
        queueId: "queue-1",
        leaseOwner: lease!.leaseOwner,
        leaseEpoch: lease!.leaseEpoch,
        nextStatus: "merged",
      }),
    ).resolves.toBe(true);
    expect(events.emitPartitionReleased).toHaveBeenCalledOnce();
  });
});
