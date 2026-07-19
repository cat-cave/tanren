// MQ-5 durable land-group store. A multi-member authority decision forms one
// group before the existing MergeAuthority CAS and reconciles every member only
// after that exact CAS succeeds. The reconcile token is also the host effect key.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { memberKey } from "../contracts/integrationNodes.js";
import type { LandAuthorization, LandBindingMember } from "../contracts/mergeAuthority.js";
import { PgEventStore } from "../eventStore.js";
import { serviceAuditActor } from "../events/schemas/audit.js";
import { applyFinalizeLand, authorityDecisionIdFor } from "./mergeAuthorityLandFinalizer.js";
import type { AuthorityLandStore } from "./mergeAuthorityV2Impl.js";

export interface LandGroupMemberContext extends Omit<LandBindingMember, "disposition"> {
  readonly prNumber: number;
  readonly prUrl: string;
  readonly projectId: string;
  readonly taskId: string;
}

export interface PgLandGroupStoreInput {
  readonly pool: pg.Pool;
  readonly orgId: string;
  readonly projectId: string;
  readonly groupId: string;
  readonly partitionId: string;
  readonly policyVersion: number;
  readonly members: ReadonlyArray<LandGroupMemberContext>;
}

interface GroupRow {
  readonly state: string;
  readonly main_sha: string | null;
}

interface ReceiptRow {
  readonly audit_id: string;
}

/**
 * AuthorityLandStore for one exact authorized batch. Its first write forms a
 * group and emits `merge.group.formed`; its receipt path completes every member
 * before atomically marking the group complete and emitting the frozen completion
 * event. A completed reconcile token returns before the host CAS is re-invoked.
 */
export class PgLandGroupStore implements AuthorityLandStore {
  private readonly reconcileToken: string;

  constructor(private readonly input: PgLandGroupStoreInput) {
    this.reconcileToken = `land-group-${input.groupId}`;
  }

  async persistAuthorizedDecision(input: {
    authorization: LandAuthorization;
  }): Promise<{ effectIntentId: string; completed?: { mainSha: string; auditId: string } }> {
    this.assertMembers(input.authorization);
    const decisionId = authorityDecisionIdFor(input.authorization);
    return runWithOrgScope(this.input.pool, this.input.orgId, async (client) => {
      await this.persistDecision(client, input.authorization, decisionId);
      const formed = await client.query<{ id: string }>(
        `INSERT INTO land_groups
           (org_id, id, decision_id, expected_main_sha, authorized_sha, state, reconcile_token)
         VALUES ($1,$2,$3,$4,$5,'formed',$6)
         ON CONFLICT (org_id, id) DO NOTHING
         RETURNING id`,
        [
          this.input.orgId,
          this.input.groupId,
          decisionId,
          input.authorization.envelope.expectedMainSha,
          input.authorization.envelope.headSha,
          this.reconcileToken,
        ],
      );
      await this.persistMembers(client, input.authorization);
      if (formed.rows[0] !== undefined) await this.appendFormed(client, input.authorization);

      const group = await client.query<GroupRow>(
        "SELECT state, main_sha FROM land_groups WHERE org_id = $1 AND id = $2",
        [this.input.orgId, this.input.groupId],
      );
      const row = group.rows[0];
      if (row?.state !== "completed" || row.main_sha === null) return { effectIntentId: this.reconcileToken };
      const receipt = await client.query<ReceiptRow>(
        "SELECT audit_id FROM authority_land_receipts WHERE org_id = $1 AND effect_intent_id = $2",
        [this.input.orgId, this.reconcileToken],
      );
      const auditId = receipt.rows[0]?.audit_id;
      if (auditId === undefined) throw new Error(`completed land group ${this.input.groupId} has no receipt`);
      return { effectIntentId: this.reconcileToken, completed: { mainSha: row.main_sha, auditId } };
    });
  }

  async recordLandReceipt(input: {
    authorization: LandAuthorization;
    effectIntentId: string;
    mainSha: string;
  }): Promise<{ auditId: string }> {
    if (input.effectIntentId !== this.reconcileToken) throw new Error("land group reconcile token mismatch");
    this.assertMembers(input.authorization);
    // Finalize the WHOLE group on one client/transaction. The former per-member
    // writer calls committed member A before member B could fail, leaving an
    // externally-landed group half-finalized after a crash. The group-row lock
    // serializes replay, and a rollback leaves every member + receipt untouched.
    return runWithOrgScope(this.input.pool, this.input.orgId, async (client) => {
      const group = await client.query<GroupRow>(
        "SELECT state, main_sha FROM land_groups WHERE org_id = $1 AND id = $2 FOR UPDATE",
        [this.input.orgId, this.input.groupId],
      );
      const groupRow = group.rows[0];
      if (groupRow === undefined) throw new Error(`land group ${this.input.groupId} is missing`);
      if (groupRow.state === "completed") return this.receiptForCompleted(client, groupRow);

      const memberRows = await client.query<{ member_key: string; outcome: string | null }>(
        `SELECT member_key, outcome FROM land_group_members
          WHERE org_id = $1 AND land_group_id = $2
          FOR UPDATE`,
        [this.input.orgId, this.input.groupId],
      );
      const outcomes = new Map(memberRows.rows.map((row) => [row.member_key, row.outcome]));
      for (const member of this.input.members) {
        const key = memberIdentity(input.authorization.envelope.expectedMainSha, member);
        // Resumes a legacy partial group exactly once; every group created by this
        // version commits all following writes together.
        if (outcomes.get(key) === "landed") continue;
        await applyFinalizeLand(client, {
          orgId: this.input.orgId,
          runId: member.runId,
          specId: member.specId,
          projectId: member.projectId,
          taskId: member.taskId,
          prUrl: member.prUrl,
          prNumber: member.prNumber,
          integration: "native_queue",
          mergeSha: input.mainSha,
          authorityDecisionId: authorityDecisionIdFor(input.authorization),
          auditEnvelope: { policyVersion: this.input.policyVersion, initiatingActor: serviceAuditActor },
        });
        await client.query(
          `UPDATE land_group_members SET outcome = 'landed'
            WHERE org_id = $1 AND land_group_id = $2 AND member_key = $3`,
          [this.input.orgId, this.input.groupId, key],
        );
      }
      return this.completeOnClient(client, input.authorization, input.mainSha);
    });
  }

  private async persistDecision(client: pg.PoolClient, auth: LandAuthorization, decisionId: string): Promise<void> {
    const envelope = auth.envelope;
    await client.query(
      `INSERT INTO authority_decisions
         (org_id, project_id, id, integration_node_id, subject_kind, head_sha, expected_main_sha,
          artifact_digest, proof_root, member_set_hash, policy_version, decision)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'authorized')
       ON CONFLICT (org_id, id) DO NOTHING`,
      [
        this.input.orgId,
        this.input.projectId,
        decisionId,
        auth.subject.id,
        auth.subject.kind,
        envelope.headSha,
        envelope.expectedMainSha,
        envelope.artifactDigest,
        envelope.proofRoot,
        envelope.memberSetHash,
        envelope.policyVersion,
      ],
    );
    await client.query(
      `INSERT INTO authority_effect_intents
         (org_id, project_id, id, decision_id, integration_node_id, into_main, authorized_sha,
          expected_main_sha, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (org_id, idempotency_key) DO NOTHING`,
      [
        this.input.orgId,
        this.input.projectId,
        this.reconcileToken,
        decisionId,
        auth.subject.id,
        envelope.target.intoMain,
        envelope.headSha,
        envelope.expectedMainSha,
        this.reconcileToken,
      ],
    );
  }

  private async persistMembers(client: pg.PoolClient, auth: LandAuthorization): Promise<void> {
    for (const member of this.input.members) {
      await client.query(
        `INSERT INTO land_group_members
           (org_id, land_group_id, member_key, pr_number, run_id, spec_id, outcome)
         VALUES ($1,$2,$3,$4,$5,$6,'pending')
         ON CONFLICT (org_id, land_group_id, member_key) DO NOTHING`,
        [
          this.input.orgId,
          this.input.groupId,
          memberIdentity(auth.envelope.expectedMainSha, member),
          String(member.prNumber),
          member.runId,
          member.specId,
        ],
      );
    }
  }

  private async appendFormed(client: pg.PoolClient, auth: LandAuthorization): Promise<void> {
    const tail = this.input.members.at(-1);
    if (tail === undefined) throw new Error("a land group requires at least two members");
    await new PgEventStore(client).append({
      runId: tail.runId,
      specId: tail.specId,
      projectId: this.input.projectId,
      orgId: this.input.orgId,
      eventType: "merge.group.formed",
      payload: {
        projectId: this.input.projectId,
        groupId: this.input.groupId,
        partitionId: this.input.partitionId,
        baseSha: auth.envelope.expectedMainSha,
        memberKeys: this.memberKeys(auth),
        policyHash: auth.envelope.proofRoot,
      },
    });
  }

  private async receiptForCompleted(client: pg.PoolClient, group: GroupRow): Promise<{ auditId: string }> {
    if (group.main_sha === null) throw new Error(`completed land group ${this.input.groupId} has no main sha`);
    const receipt = await client.query<ReceiptRow>(
      "SELECT audit_id FROM authority_land_receipts WHERE org_id = $1 AND effect_intent_id = $2",
      [this.input.orgId, this.reconcileToken],
    );
    const auditId = receipt.rows[0]?.audit_id;
    if (auditId === undefined) throw new Error(`completed land group ${this.input.groupId} has no receipt`);
    return { auditId };
  }

  private async completeOnClient(
    client: pg.PoolClient,
    auth: LandAuthorization,
    mainSha: string,
  ): Promise<{ auditId: string }> {
    const unfinished = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM land_group_members
          WHERE org_id = $1 AND land_group_id = $2 AND outcome IS DISTINCT FROM 'landed'`,
      [this.input.orgId, this.input.groupId],
    );
    if (Number(unfinished.rows[0]?.count ?? "0") !== 0) throw new Error("land group members are not fully reconciled");
    const auditId = this.input.members.at(-1)?.runId;
    if (auditId === undefined) throw new Error("a land group requires at least two members");
    await client.query(
      `INSERT INTO authority_land_receipts (org_id, project_id, id, effect_intent_id, main_sha, audit_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (org_id, effect_intent_id) DO NOTHING`,
      [this.input.orgId, this.input.projectId, `receipt-${this.reconcileToken}`, this.reconcileToken, mainSha, auditId],
    );
    const completed = await client.query<{ id: string }>(
      `UPDATE land_groups SET state = 'completed', main_sha = $3
          WHERE org_id = $1 AND id = $2 AND state <> 'completed'
          RETURNING id`,
      [this.input.orgId, this.input.groupId, mainSha],
    );
    if (completed.rows[0] !== undefined) await this.appendCompleted(client, auth, mainSha);
    return { auditId };
  }

  private async appendCompleted(client: pg.PoolClient, auth: LandAuthorization, mainSha: string): Promise<void> {
    const tail = this.input.members.at(-1);
    if (tail === undefined) throw new Error("a land group requires at least two members");
    await new PgEventStore(client).append({
      runId: tail.runId,
      specId: tail.specId,
      projectId: this.input.projectId,
      orgId: this.input.orgId,
      eventType: "merge.land_group.completed",
      payload: {
        projectId: this.input.projectId,
        landGroupId: this.input.groupId,
        decisionId: authorityDecisionIdFor(auth),
        expectedMainSha: auth.envelope.expectedMainSha,
        authorizedSha: auth.envelope.headSha,
        mainSha,
        memberKeys: this.memberKeys(auth),
      },
    });
  }

  private assertMembers(auth: LandAuthorization): void {
    if (this.input.members.length < 2 || this.input.members.length !== auth.envelope.members.length) {
      throw new Error("land group must bind every authorized member");
    }
    if (
      !this.input.members.every((member, index) => {
        const bound = auth.envelope.members[index];
        return (
          bound !== undefined &&
          member.specId === bound.specId &&
          member.runId === bound.runId &&
          member.branch === bound.branch &&
          member.headSha === bound.headSha
        );
      })
    ) {
      throw new Error("land group members do not match the authorized integration");
    }
  }

  private memberKeys(auth: LandAuthorization): string[] {
    return this.input.members.map((member) => memberIdentity(auth.envelope.expectedMainSha, member));
  }
}

function memberIdentity(baseSha: string, member: Pick<LandBindingMember, "specId" | "runId" | "headSha">): string {
  return `${memberKey(baseSha, [member.headSha])}:${member.specId}:${member.runId}`;
}
