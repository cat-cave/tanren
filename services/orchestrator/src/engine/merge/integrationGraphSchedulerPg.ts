// RLS- and CodeHost-backed facts for IntegrationGraphScheduler. This is the only
// production producer of semantic diff classifications; an unreadable fact is held.

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { memberKey } from "../contracts/integrationNodes.js";
import type { CodeHost, CodeHostRepoRef } from "../contracts/codeHost.js";
import type { MergeQueueEntry, MergeQueueSnapshot } from "../contracts/mergeCoordinator.js";
import { PgMergeQueuePartitionStore } from "./mergeQueuePartitionStore.js";
import type { ProjectAuthorityRow } from "./multiMemberAuthorityPgState.js";
import {
  classifySemanticPartition,
  type ActivePartitionLeaseFacts,
  type IntegrationScheduleFactsResolver,
  type ScheduleFactsResolution,
  type ScheduleMemberFacts,
} from "./integrationGraphScheduler.js";

const FULL_SHA = /^[0-9a-f]{40}$/u;

interface ProjectRow extends ProjectAuthorityRow {
  readonly org_id: string;
}

interface CandidateRow {
  readonly queue_id: string;
  readonly run_id: string;
  readonly spec_id: string;
  readonly branch: unknown;
  readonly partition_id: string | null;
  readonly scope_fingerprint: string | null;
}

interface LeaseRow {
  readonly partition_id: string | null;
  readonly lease_owner: string | null;
  readonly lease_epoch: number;
  readonly generation: number | null;
  readonly scope_key: string | null;
}

export interface PgIntegrationGraphSchedulerDeps {
  readonly pool: pg.Pool;
  /** Production binds the shared credentialed CodeHost factory; unit tests supply a stub. */
  readonly buildCodeHost: (
    project: ProjectAuthorityRow,
    orgId: string,
  ) => Promise<{ readonly host: Pick<CodeHost, "fetchRef" | "readDiff">; readonly repo: CodeHostRepoRef }>;
}

/**
 * Reads the same project/queue coordinates under RLS, then confirms the live
 * CodeHost base/head/diff coordinates twice before persisting the canonical scope.
 */
export class PgIntegrationGraphSchedulerFacts implements IntegrationScheduleFactsResolver {
  private readonly partitions = new PgMergeQueuePartitionStore();

  public constructor(private readonly deps: PgIntegrationGraphSchedulerDeps) {}

  public async resolve(
    snapshot: MergeQueueSnapshot,
    candidates: ReadonlyArray<MergeQueueEntry>,
  ): Promise<ScheduleFactsResolution> {
    const project = await this.loadProject(snapshot.projectId);
    if (project === null) return { kind: "stale", reason: "project_or_org_unavailable" };
    const rows = await this.loadCandidateRows(project.org_id, snapshot, candidates);
    if (rows === null) return { kind: "stale", reason: "snapshot_changed_before_classification" };
    const leases = await this.loadActiveLeases(project.org_id, snapshot.projectId);
    if (leases === undefined) return { kind: "stale", reason: "ambiguous_partition_lease" };

    try {
      const { host, repo } = await this.deps.buildCodeHost(project, project.org_id);
      const baseSha = await host.fetchRef({ repo, remoteBranch: project.default_branch });
      if (!isFullSha(baseSha)) return { kind: "stale", reason: "base_head_unavailable" };
      const members: ScheduleMemberFacts[] = [];
      for (const entry of candidates) {
        const row = rows.get(entry.runId);
        if (row === undefined || !nonBlank(row.branch)) return { kind: "stale", reason: "run_branch_unavailable" };
        const headSha = await host.fetchRef({ repo, remoteBranch: row.branch });
        if (!isFullSha(headSha)) return { kind: "stale", reason: "member_head_unavailable" };
        const diff = await host.readDiff(repo, baseSha, headSha);
        members.push({
          queueId: entry.queueId,
          runId: entry.runId,
          specId: entry.specId,
          branch: row.branch,
          baseSha,
          headSha,
          diff,
          reusableProofNode: false,
        });
      }
      // The diff is meaningful only for exactly these current refs. A changed head/base
      // rejects the whole proposal before it can be checked or claim a lease.
      const confirmedBase = await host.fetchRef({ repo, remoteBranch: project.default_branch });
      if (confirmedBase !== baseSha) return { kind: "stale", reason: "base_head_changed" };
      for (const member of members) {
        const confirmedHead = await host.fetchRef({ repo, remoteBranch: member.branch });
        if (confirmedHead !== member.headSha) return { kind: "stale", reason: "member_head_changed" };
      }
      const reusable = await this.findExactProofNodes(project.org_id, snapshot.projectId, baseSha, members);
      const resolved = members.map((member) => ({ ...member, reusableProofNode: reusable.has(member.runId) }));
      // Persist only validated canonical semantic facts. The transaction locks every
      // source row before writing, so a stale queue snapshot rolls back without an
      // orphaned partition or a partial reclassification.
      if (
        !(await this.persistCanonicalPartitions(
          project.org_id,
          project.default_branch,
          snapshot,
          candidates,
          resolved,
          leases,
          async () => {
            const currentBase = await host.fetchRef({ repo, remoteBranch: project.default_branch });
            if (currentBase !== baseSha) return false;
            for (const member of resolved) {
              const currentHead = await host.fetchRef({ repo, remoteBranch: member.branch });
              if (currentHead !== member.headSha) return false;
            }
            return true;
          },
        ))
      ) {
        return { kind: "stale", reason: "snapshot_changed_before_partition_persist" };
      }
      return { kind: "resolved", baseSha, members: resolved, activeLeases: leases };
    } catch {
      // Credentials, host reads, malformed repo URL, and external transport failures
      // are all unconfirmable facts. A scheduler hold is safer than guessed scope.
      return { kind: "stale", reason: "codehost_facts_unavailable" };
    }
  }

  private async loadProject(projectId: string): Promise<ProjectRow | null> {
    const orgId = await runWithSystemScope(this.deps.pool, async (client) => {
      const result = await client.query<{ org_id: string | null }>(
        "SELECT org_id FROM projects WHERE project_id = $1",
        [projectId],
      );
      return result.rows[0]?.org_id ?? null;
    });
    if (orgId === null) return null;
    return runWithOrgScope(this.deps.pool, orgId, async (client) => {
      const result = await client.query<{
        org_id: string;
        repo_url: unknown;
        default_branch: unknown;
        project_config: unknown;
        org_config: unknown;
      }>(
        `SELECT p.org_id, p.repo_url, p.default_branch, p.config AS project_config, o.config AS org_config
           FROM projects p LEFT JOIN organizations o ON o.id = p.org_id
          WHERE p.project_id = $1`,
        [projectId],
      );
      const row = result.rows[0];
      if (row === undefined || !nonBlank(row.org_id) || !nonBlank(row.repo_url) || !nonBlank(row.default_branch)) {
        return null;
      }
      return {
        org_id: row.org_id,
        repo_url: row.repo_url,
        default_branch: row.default_branch,
        project_config: row.project_config,
        org_config: row.org_config,
      };
    });
  }

  private async loadCandidateRows(
    orgId: string,
    snapshot: MergeQueueSnapshot,
    candidates: ReadonlyArray<MergeQueueEntry>,
  ): Promise<Map<string, CandidateRow> | null> {
    return runWithOrgScope(this.deps.pool, orgId, async (client) => {
      const queueIds = candidates.map((entry) => entry.queueId);
      const result = await client.query<CandidateRow>(
        `SELECT mq.queue_id, mq.run_id, mq.spec_id, r.branch, mq.partition_id, mq.scope_fingerprint
           FROM merge_queue mq
           JOIN runs r ON r.org_id = mq.org_id AND r.run_id = mq.run_id
                     AND r.project_id = mq.project_id AND r.spec_id = mq.spec_id
          WHERE mq.project_id = $1 AND mq.status = 'queued' AND mq.queue_id = ANY($2::text[])`,
        [snapshot.projectId, queueIds],
      );
      if (result.rows.length !== candidates.length) return null;
      const byRun = new Map(result.rows.map((row) => [row.run_id, row] as const));
      if (byRun.size !== candidates.length) return null;
      for (const entry of candidates) {
        const row = byRun.get(entry.runId);
        if (
          row === undefined ||
          row.queue_id !== entry.queueId ||
          row.spec_id !== entry.specId ||
          row.partition_id !== (entry.partitionId ?? null) ||
          row.scope_fingerprint !== (entry.scopeFingerprint ?? null)
        ) {
          return null;
        }
      }
      return byRun;
    });
  }

  private async loadActiveLeases(orgId: string, projectId: string): Promise<ActivePartitionLeaseFacts[] | undefined> {
    return runWithOrgScope(this.deps.pool, orgId, (client) => this.loadActiveLeasesOnClient(client, projectId, false));
  }

  private async loadActiveLeasesOnClient(
    client: pg.PoolClient,
    projectId: string,
    lockRows: boolean,
  ): Promise<ActivePartitionLeaseFacts[] | undefined> {
    const result = await client.query<LeaseRow>(
      `SELECT mq.partition_id, mq.lease_owner, mq.lease_epoch, p.generation, p.scope_key
         FROM merge_queue mq LEFT JOIN merge_queue_partitions p ON p.org_id = mq.org_id AND p.id = mq.partition_id
        WHERE mq.project_id = $1 AND mq.status = 'merging' AND mq.lease_owner IS NOT NULL${lockRows ? " FOR UPDATE OF mq" : ""}`,
      [projectId],
    );
    const leases: ActivePartitionLeaseFacts[] = [];
    for (const row of result.rows) {
      if (
        !nonBlank(row.partition_id) ||
        !nonBlank(row.lease_owner) ||
        !Number.isInteger(row.lease_epoch) ||
        row.lease_epoch < 1 ||
        typeof row.generation !== "number" ||
        !Number.isInteger(row.generation) ||
        row.generation < 0 ||
        !nonBlank(row.scope_key)
      ) {
        return undefined;
      }
      leases.push({
        partitionId: row.partition_id,
        leaseOwner: row.lease_owner,
        leaseEpoch: row.lease_epoch,
        generation: row.generation,
        fingerprint: row.scope_key,
      });
    }
    return leases.sort((left, right) => left.partitionId.localeCompare(right.partitionId));
  }

  private async findExactProofNodes(
    orgId: string,
    projectId: string,
    baseSha: string,
    members: ReadonlyArray<ScheduleMemberFacts>,
  ): Promise<Set<string>> {
    const keyToRun = new Map(members.map((member) => [memberKey(baseSha, [member.headSha]), member.runId] as const));
    return runWithOrgScope(this.deps.pool, orgId, async (client) => {
      const result = await client.query<{ member_key: string }>(
        `SELECT n.member_key
           FROM integration_nodes n
          WHERE n.org_id = $1 AND n.project_id = $2 AND n.base_sha = $3 AND n.status = 'ready'
            AND n.member_key = ANY($4::text[])
            AND EXISTS (
              SELECT 1 FROM integration_proofs p
               WHERE p.org_id = n.org_id AND p.project_id = n.project_id AND p.node_id = n.node_id
                 AND p.verdict = 'passed'
            )`,
        [orgId, projectId, baseSha, [...keyToRun.keys()]],
      );
      return new Set(result.rows.flatMap((row) => keyToRun.get(row.member_key) ?? []));
    });
  }

  private async persistCanonicalPartitions(
    orgId: string,
    targetBranch: string,
    snapshot: MergeQueueSnapshot,
    candidates: ReadonlyArray<MergeQueueEntry>,
    members: ReadonlyArray<ScheduleMemberFacts>,
    expectedLeases: ReadonlyArray<ActivePartitionLeaseFacts>,
    confirmCoordinates: () => Promise<boolean>,
  ): Promise<boolean> {
    const memberByRun = new Map(members.map((member) => [member.runId, member] as const));
    return runWithOrgScope(this.deps.pool, orgId, async (client) => {
      // Validate every source row before writing anything. The row locks are the
      // snapshot fence for this read→classify→persist sequence.
      for (const entry of candidates) {
        const member = memberByRun.get(entry.runId);
        const locked = await client.query<CandidateRow>(
          `SELECT mq.queue_id, mq.run_id, mq.spec_id, r.branch, mq.partition_id, mq.scope_fingerprint
             FROM merge_queue mq
             JOIN runs r ON r.org_id = mq.org_id AND r.run_id = mq.run_id
                       AND r.project_id = mq.project_id AND r.spec_id = mq.spec_id
            WHERE mq.queue_id = $1 AND mq.project_id = $2 AND mq.status = 'queued' FOR UPDATE OF mq`,
          [entry.queueId, snapshot.projectId],
        );
        const row = locked.rows[0];
        if (
          row === undefined ||
          row.run_id !== entry.runId ||
          row.spec_id !== entry.specId ||
          member === undefined ||
          row.branch !== member.branch ||
          row.partition_id !== (entry.partitionId ?? null) ||
          row.scope_fingerprint !== (entry.scopeFingerprint ?? null) ||
          !nonBlank(row.branch)
        ) {
          return false;
        }
      }
      if (!(await confirmCoordinates())) return false;
      const currentLeases = await this.loadActiveLeasesOnClient(client, snapshot.projectId, true);
      if (currentLeases === undefined || !sameLeaseSet(expectedLeases, currentLeases)) return false;
      for (const entry of candidates) {
        const member = memberByRun.get(entry.runId);
        if (member === undefined) return false;
        const semantic = classifySemanticPartition(member.diff);
        const partition = await this.partitions.ensureOnClient(client, {
          orgId,
          projectId: snapshot.projectId,
          specId: entry.specId,
          targetBranch,
          scopeFingerprint: semantic.fingerprint,
        });
        const updated = await client.query(
          `UPDATE merge_queue
              SET partition_id = $4, scope_fingerprint = $5
            WHERE queue_id = $1 AND run_id = $2 AND spec_id = $3 AND status = 'queued'
              AND partition_id IS NOT DISTINCT FROM $6
              AND scope_fingerprint IS NOT DISTINCT FROM $7`,
          [
            entry.queueId,
            entry.runId,
            entry.specId,
            partition.id,
            semantic.fingerprint,
            entry.partitionId ?? null,
            entry.scopeFingerprint ?? null,
          ],
        );
        if (updated.rowCount !== 1) throw new Error("semantic partition fence lost");
      }
      return true;
    });
  }
}

function isFullSha(value: string | undefined): value is string {
  return value !== undefined && FULL_SHA.test(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function sameLeaseSet(
  left: ReadonlyArray<ActivePartitionLeaseFacts>,
  right: ReadonlyArray<ActivePartitionLeaseFacts>,
): boolean {
  if (left.length !== right.length) return false;
  return left.every((lease, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      other.partitionId === lease.partitionId &&
      other.leaseOwner === lease.leaseOwner &&
      other.leaseEpoch === lease.leaseEpoch &&
      other.generation === lease.generation &&
      other.fingerprint === lease.fingerprint
    );
  });
}
