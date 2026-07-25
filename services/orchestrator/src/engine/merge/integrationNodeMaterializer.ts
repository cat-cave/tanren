// MQ-11: materialize an already-authorized integration subset through the one jj
// workspace seam, then durably record its exact local product identity. This does
// not land anything and does not create a second merge path.

import { createHash } from "node:crypto";
import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { memberKey, type IntegrationNodeMember, type IntegrationNodePurpose } from "../contracts/integrationNodes.js";
import type { WorkspaceIntegrationAssembly, WorkspaceVcsCore } from "../contracts/workspaceVcsCore.js";
import type { IntegrationNodeUpsert } from "../dag/integrationNodesPg.js";
import { upsertIntegrationNodeOnClient } from "../dag/integrationNodesPg.js";
import { PgEventStore } from "../eventStore.js";

export interface AuthorizedSubsetMaterializationInput {
  readonly orgId: string;
  readonly projectId: string;
  /** The real clone source whose PR-head refs jj assembles. */
  readonly repoUrl: string;
  readonly baseBranch: string;
  /** The base SHA bound by the authority/land group; a clone race fails closed. */
  readonly baseSha: string;
  /** Only members admitted by the authority decision, in its dependency order. */
  readonly members: ReadonlyArray<IntegrationNodeMember>;
  /** Stable jj-local operation identity, never a host integration branch. */
  readonly localRef: string;
  /** Runner-local path the bound WorkspaceVcsCore owns for this assembly. */
  readonly workspacePath: string;
  readonly purpose?: IntegrationNodePurpose;
  readonly gateConfigHash?: string;
  readonly policyVersion?: string;
  /**
   * Resolve facts that are only knowable on the exact integrated workspace before
   * persistence. A rejection aborts the materialization; callers use it to refuse
   * a half-known speculative proof identity rather than writing a reusable node.
   */
  readonly beforePersist?: (input: {
    readonly localRef: string;
    readonly baseSha: string;
    readonly headSha: string;
    readonly treeHash: string;
    readonly members: ReadonlyArray<IntegrationNodeMember>;
  }) => Promise<{ readonly gateConfigHash?: string; readonly policyVersion?: string }>;
}

export interface MaterializedIntegrationNodeRecord extends IntegrationNodeUpsert {
  readonly runId?: string;
  readonly specId?: string;
  readonly memberKey: string;
  readonly headSha: string;
  readonly treeHash: string;
  readonly status: "building";
}

export interface MaterializationFailureRecord {
  readonly orgId: string;
  readonly projectId: string;
  readonly runId?: string;
  readonly specId?: string;
  readonly memberKey: string;
  readonly baseSha: string;
  readonly failureCode: string;
  readonly diagnosticsDigest: string;
}

/** Persistence owns org-scoped node/event writes; fakes use the same observable boundary. */
export interface IntegrationNodeMaterializationPersistence {
  persistMaterialized(input: MaterializedIntegrationNodeRecord): Promise<string>;
  recordMaterializationFailure(input: MaterializationFailureRecord): Promise<void>;
}

export type IntegrationNodeMaterializationResult =
  | {
      readonly kind: "materialized";
      readonly nodeId: string;
      readonly memberKey: string;
      readonly baseSha: string;
      readonly headSha: string;
      readonly treeHash: string;
    }
  | { readonly kind: "failed"; readonly failureCode: string; readonly diagnosticsDigest: string };

/** Materializes one exact authorized subset through the single WorkspaceVcsCore path. */
export class IntegrationNodeMaterializer {
  constructor(
    private readonly workspace: WorkspaceVcsCore,
    private readonly persistence: IntegrationNodeMaterializationPersistence,
  ) {}

  async materialize(input: AuthorizedSubsetMaterializationInput): Promise<IntegrationNodeMaterializationResult> {
    const expectedMemberKey = memberKey(
      input.baseSha,
      input.members.map((member) => member.headSha),
    );
    let assembled: WorkspaceIntegrationAssembly;
    try {
      assembled = await this.workspace.assembleIntegration({
        repoUrl: input.repoUrl,
        baseBranch: input.baseBranch,
        path: input.workspacePath,
        localRef: input.localRef,
        members: input.members.map((member) => ({
          specId: member.specId,
          branch: member.branch,
          knownHeadSha: member.headSha,
        })),
      });
    } catch (error) {
      return this.failed(input, expectedMemberKey, "jj_assembly_failed", error);
    }

    if (assembled.outcome === "conflict") {
      return this.failed(input, expectedMemberKey, "jj_conflict", new Error(assembled.message));
    }
    const verified = this.verifyAssembly(input, assembled);
    if (verified !== undefined) return this.failed(input, expectedMemberKey, verified, new Error(verified));

    const resolved =
      input.beforePersist === undefined
        ? undefined
        : await input.beforePersist({
            localRef: assembled.localRef,
            baseSha: assembled.baseSha,
            headSha: assembled.headSha,
            treeHash: assembled.treeHash,
            members: input.members,
          });
    const tail = input.members.at(-1);
    const gateConfigHash = resolved?.gateConfigHash ?? input.gateConfigHash;
    const policyVersion = resolved?.policyVersion ?? input.policyVersion;
    const record: MaterializedIntegrationNodeRecord = {
      orgId: input.orgId,
      projectId: input.projectId,
      baseBranch: input.baseBranch,
      baseSha: assembled.baseSha,
      ref: assembled.localRef,
      purpose: input.purpose ?? "merge_batch",
      members: input.members,
      memberKey: expectedMemberKey,
      ...(gateConfigHash === undefined ? {} : { gateConfigHash }),
      ...(policyVersion === undefined ? {} : { policyVersion }),
      headSha: assembled.headSha,
      treeHash: assembled.treeHash,
      status: "building",
      ...(tail !== undefined && { runId: tail.runId, specId: tail.specId }),
    };
    const nodeId = await this.persistence.persistMaterialized(record);
    return {
      kind: "materialized",
      nodeId,
      memberKey: expectedMemberKey,
      baseSha: assembled.baseSha,
      headSha: assembled.headSha,
      treeHash: assembled.treeHash,
    };
  }

  private verifyAssembly(
    input: AuthorizedSubsetMaterializationInput,
    assembled: Extract<WorkspaceIntegrationAssembly, { outcome: "integrated" }>,
  ): string | undefined {
    if (assembled.baseSha !== input.baseSha) return "base_sha_moved";
    for (const member of input.members) {
      if (assembled.memberHeadShas[member.specId] !== member.headSha) return "member_head_moved";
    }
    return undefined;
  }

  private async failed(
    input: AuthorizedSubsetMaterializationInput,
    expectedMemberKey: string,
    failureCode: string,
    error: unknown,
  ): Promise<IntegrationNodeMaterializationResult> {
    const tail = input.members.at(-1);
    const diagnosticsDigest = digest(error instanceof Error ? error.message : String(error));
    await this.persistence.recordMaterializationFailure({
      orgId: input.orgId,
      projectId: input.projectId,
      memberKey: expectedMemberKey,
      baseSha: input.baseSha,
      failureCode,
      diagnosticsDigest,
      ...(tail !== undefined && { runId: tail.runId, specId: tail.specId }),
    });
    return { kind: "failed", failureCode, diagnosticsDigest };
  }
}

/** The org-scoped PG persistence adapter; node and frozen event append in one transaction. */
export class PgIntegrationNodeMaterializationPersistence implements IntegrationNodeMaterializationPersistence {
  constructor(private readonly pool: pg.Pool) {}

  async persistMaterialized(input: MaterializedIntegrationNodeRecord): Promise<string> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const { memberKey: _memberKey, runId, specId, ...node } = input;
      const nodeId = await upsertIntegrationNodeOnClient(client, node);
      await new PgEventStore(client).append({
        orgId: input.orgId,
        projectId: input.projectId,
        ...(runId !== undefined && { runId }),
        ...(specId !== undefined && { specId }),
        eventType: "integration.node.materialized",
        payload: {
          projectId: input.projectId,
          integrationNodeId: nodeId,
          memberKey: input.memberKey,
          baseSha: input.baseSha,
          headSha: input.headSha,
          treeHash: digest(input.treeHash),
        },
      });
      return nodeId;
    });
  }

  async recordMaterializationFailure(input: MaterializationFailureRecord): Promise<void> {
    await runWithOrgScope(this.pool, input.orgId, async (client) => {
      await new PgEventStore(client).append({
        orgId: input.orgId,
        projectId: input.projectId,
        ...(input.runId !== undefined && { runId: input.runId }),
        ...(input.specId !== undefined && { specId: input.specId }),
        eventType: "integration.node.materialization_failed",
        payload: {
          projectId: input.projectId,
          memberKey: input.memberKey,
          baseSha: input.baseSha,
          failureCode: input.failureCode,
          diagnosticsDigest: input.diagnosticsDigest,
        },
      });
    });
  }
}

/** Construct the production materializer without widening callers to PG internals. */
export function buildPgIntegrationNodeMaterializer(
  pool: pg.Pool,
  workspace: WorkspaceVcsCore,
): IntegrationNodeMaterializer {
  return new IntegrationNodeMaterializer(workspace, new PgIntegrationNodeMaterializationPersistence(pool));
}

export function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
