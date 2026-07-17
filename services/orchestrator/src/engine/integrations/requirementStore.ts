// in-5: persistence for compiled integration requirements.
//
// Writes the immutable `integration_requirements` rows (keyed by source + content
// digest) and the `behavior_integration_requirements` link rows created by 0043,
// carrying the direct `org_id` + composite tenant FKs that migration enforces.
// Every write assumes the caller has already opened an org-scoped transaction
// (`runWithOrgScope`), so this module issues no BEGIN/COMMIT of its own — it
// composes into the derive's single atomic graph transaction.
//
// IDENTITY + SUPERSEDE. A requirement's identity is its content digest
// (`desiredStateHash` = the in-2 `integrationRequirementDigest`). Re-persisting an
// identical document for the same source is an idempotent no-op (returns the
// existing row, no duplicate, no second `derived` event) — this is what makes the
// "recompile → same hash → exactly one row" property hold. Persisting a DIFFERENT
// document for the same source supersedes the prior active row(s) (status flips to
// `superseded`, `superseded_by` points at the new row) and emits
// `integration.requirement.superseded`. A newly inserted document emits
// `integration.requirement.derived`. Both names are the frozen 0046 vocabulary.

import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Digest } from "../contracts/cas.js";
import type { IntegrationRequirementV1 } from "../contracts/integrationRequirement.js";
import { integrationRequirementDigest } from "../contracts/integrationRequirement.js";
import { PgEventStore, type EventStore } from "../eventStore.js";
import { behaviorKey } from "../forge/interview/deriveDesignContract.js";
import {
  AmbiguousIntegrationRequirementError,
  compileIntegrationRequirement,
  INTEGRATION_REQUIREMENT_POLICY_VERSION,
} from "../forge/interview/compileIntegrationRequirement.js";
import type { CaptureBehavior, CaptureDesignContract } from "../forge/interview/types.js";

type RequirementStoreClient = Pick<pg.Pool | pg.PoolClient, "query">;

export type RequirementSourceKind = "behavior_revision" | "design_contract";
export type BehaviorRequirementRelation = "requires" | "triggers" | "observes";

export interface BehaviorRequirementLink {
  readonly behaviorRevisionId: string;
  readonly relationRole?: BehaviorRequirementRelation;
}

export interface PersistDerivedRequirementInput {
  readonly orgId: string;
  readonly projectId: string;
  /** The compiled in-2 document (already schema+semantics valid). */
  readonly requirement: IntegrationRequirementV1;
  /** Content identity; defaults to `integrationRequirementDigest(requirement)`. */
  readonly desiredStateHash?: Digest;
  readonly sourceKind: RequirementSourceKind;
  readonly sourceRevisionId: string;
  readonly policyVersion?: string;
  readonly behaviorLinks?: readonly BehaviorRequirementLink[];
  /** Injected for tests; production uses `PgEventStore(client)` on the txn client. */
  readonly eventStore?: EventStore;
}

export interface PersistDerivedRequirementResult {
  readonly requirementId: string;
  readonly desiredStateHash: string;
  /** false ⇒ idempotent hit on an existing identical active row. */
  readonly created: boolean;
  readonly supersededRequirementIds: readonly string[];
}

export interface IntegrationRequirementRecord {
  readonly requirementId: string;
  readonly projectId: string;
  readonly capability: string;
  readonly plane: string;
  readonly direction: string;
  readonly desiredState: unknown;
  readonly sourceKind: string;
  readonly sourceRevisionId: string;
  readonly sourceDigest: string;
  readonly policyVersion: string;
  readonly criticality: string;
  readonly status: string;
  readonly supersededBy: string | undefined;
  readonly createdAt: string;
  readonly behaviors: ReadonlyArray<{ behaviorRevisionId: string; relationRole: string }>;
}

interface RawRequirementRow {
  id: string;
  project_id: string;
  capability: string;
  plane: string;
  direction: string;
  desired_state: unknown;
  source_kind: string;
  source_revision_id: string;
  source_digest: string;
  policy_version: string;
  criticality: string;
  status: string;
  superseded_by: string | null;
  created_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

async function insertBehaviorLinks(
  client: RequirementStoreClient,
  input: PersistDerivedRequirementInput,
  requirementId: string,
): Promise<void> {
  for (const link of input.behaviorLinks ?? []) {
    await client.query(
      `INSERT INTO behavior_integration_requirements
         (org_id, project_id, behavior_revision_id, requirement_id, relation_role)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, project_id, behavior_revision_id, requirement_id) DO NOTHING`,
      [input.orgId, input.projectId, link.behaviorRevisionId, requirementId, link.relationRole ?? "requires"],
    );
  }
}

export const RequirementStore = {
  /**
   * Persist a compiled requirement (idempotent on identical content; supersedes a
   * changed one). Assumes an already-open org-scoped transaction on `client`.
   */
  async persistDerived(
    client: RequirementStoreClient,
    input: PersistDerivedRequirementInput,
  ): Promise<PersistDerivedRequirementResult> {
    const digest = input.desiredStateHash ?? integrationRequirementDigest(input.requirement);
    const policyVersion = input.policyVersion ?? INTEGRATION_REQUIREMENT_POLICY_VERSION;
    const events = input.eventStore ?? new PgEventStore(client);
    const req = input.requirement;

    const existing = await client.query(
      `SELECT id, source_digest FROM integration_requirements
       WHERE org_id = $1 AND project_id = $2 AND source_kind = $3 AND source_revision_id = $4
         AND status = 'active'`,
      [input.orgId, input.projectId, input.sourceKind, input.sourceRevisionId],
    );
    const activeRows = existing.rows as ReadonlyArray<{ id: string; source_digest: string }>;

    const identical = activeRows.find((r) => r.source_digest === digest);
    if (identical !== undefined) {
      // Idempotent: same source + same content ⇒ the same requirement. Ensure any
      // newly supplied behavior links exist, but never a second row or event.
      await insertBehaviorLinks(client, input, identical.id);
      return { requirementId: identical.id, desiredStateHash: digest, created: false, supersededRequirementIds: [] };
    }

    const requirementId = `intreq_${randomUUID()}`;
    // Insert the new active row FIRST so the superseded rows' `superseded_by` FK
    // resolves to an existing requirement id.
    await client.query(
      `INSERT INTO integration_requirements
         (org_id, id, project_id, capability, plane, direction, desired_state,
          source_kind, source_revision_id, source_digest, policy_version, criticality, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, 'active')`,
      [
        input.orgId,
        requirementId,
        input.projectId,
        req.capability,
        req.plane,
        req.direction,
        JSON.stringify(req),
        input.sourceKind,
        input.sourceRevisionId,
        digest,
        policyVersion,
        req.criticality,
      ],
    );

    const supersededRequirementIds: string[] = [];
    for (const old of activeRows) {
      await client.query(
        `UPDATE integration_requirements
         SET status = 'superseded', superseded_by = $4
         WHERE org_id = $1 AND project_id = $2 AND id = $3 AND status = 'active'`,
        [input.orgId, input.projectId, old.id, requirementId],
      );
      supersededRequirementIds.push(old.id);
      await events.append({
        orgId: input.orgId,
        projectId: input.projectId,
        eventType: "integration.requirement.superseded",
        payload: { requirementId: old.id, supersededByRequirementId: requirementId },
      });
    }

    await events.append({
      orgId: input.orgId,
      projectId: input.projectId,
      eventType: "integration.requirement.derived",
      payload: {
        requirementId,
        capability: req.capability,
        plane: req.plane,
        direction: req.direction,
        criticality: req.criticality,
        sourceKind: input.sourceKind,
        sourceRevisionId: input.sourceRevisionId,
        desiredStateHash: digest,
      },
    });

    await insertBehaviorLinks(client, input, requirementId);
    return { requirementId, desiredStateHash: digest, created: true, supersededRequirementIds };
  },

  /** All requirements for a project (active + superseded), with behavior links. */
  async listForProject(
    client: RequirementStoreClient,
    orgId: string,
    projectId: string,
  ): Promise<IntegrationRequirementRecord[]> {
    const result = await client.query(
      `SELECT id, project_id, capability, plane, direction, desired_state, source_kind,
              source_revision_id, source_digest, policy_version, criticality, status,
              superseded_by, created_at
       FROM integration_requirements
       WHERE org_id = $1 AND project_id = $2
       ORDER BY created_at, id`,
      [orgId, projectId],
    );
    const links = await client.query(
      `SELECT requirement_id, behavior_revision_id, relation_role
       FROM behavior_integration_requirements
       WHERE org_id = $1 AND project_id = $2
       ORDER BY requirement_id, behavior_revision_id`,
      [orgId, projectId],
    );
    const linksByRequirement = new Map<string, Array<{ behaviorRevisionId: string; relationRole: string }>>();
    for (const raw of links.rows as ReadonlyArray<{
      requirement_id: string;
      behavior_revision_id: string;
      relation_role: string;
    }>) {
      const list = linksByRequirement.get(raw.requirement_id) ?? [];
      list.push({ behaviorRevisionId: raw.behavior_revision_id, relationRole: raw.relation_role });
      linksByRequirement.set(raw.requirement_id, list);
    }
    return (result.rows as RawRequirementRow[]).map((row) => ({
      requirementId: row.id,
      projectId: row.project_id,
      capability: row.capability,
      plane: row.plane,
      direction: row.direction,
      desiredState: row.desired_state,
      sourceKind: row.source_kind,
      sourceRevisionId: row.source_revision_id,
      sourceDigest: row.source_digest,
      policyVersion: row.policy_version,
      criticality: row.criticality,
      status: row.status,
      supersededBy: row.superseded_by ?? undefined,
      createdAt: toIso(row.created_at),
      behaviors: linksByRequirement.get(row.id) ?? [],
    }));
  },
} as const;

export interface MaybePersistRequirementInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly behavior: CaptureBehavior;
  readonly designContract: CaptureDesignContract | null;
  /**
   * The materialized behavior_revision id, when available. When present the
   * requirement is keyed to it and a behavior↔requirement link row is written;
   * when absent (the pre-materialization greenfield derive) the stable behavior
   * key keys the requirement and no link row is written (no dangling FK).
   */
  readonly behaviorRevisionId?: string;
  readonly eventStore?: EventStore;
}

/**
 * The additive Forge hook: compile the behavior, and — only when it genuinely
 * invokes an integration — persist the requirement. `no_integration` is a silent
 * skip; `ambiguous` is a LOUD typed throw (never a vacuous row).
 */
export async function maybePersistIntegrationRequirement(
  client: RequirementStoreClient,
  input: MaybePersistRequirementInput,
): Promise<PersistDerivedRequirementResult | undefined> {
  const compiled = compileIntegrationRequirement(input.behavior, input.designContract);
  if (compiled.kind === "no_integration") return undefined;
  if (compiled.kind === "ambiguous") {
    throw new AmbiguousIntegrationRequirementError(
      behaviorKey(input.behavior.persona, input.behavior.title),
      compiled.issues,
    );
  }
  const sourceRevisionId = input.behaviorRevisionId ?? compiled.behaviorKey;
  const behaviorLinks: BehaviorRequirementLink[] =
    input.behaviorRevisionId !== undefined
      ? [{ behaviorRevisionId: input.behaviorRevisionId, relationRole: "requires" }]
      : [];
  return RequirementStore.persistDerived(client, {
    orgId: input.orgId,
    projectId: input.projectId,
    requirement: compiled.requirement,
    desiredStateHash: compiled.desiredStateHash,
    sourceKind: "behavior_revision",
    sourceRevisionId,
    behaviorLinks,
    ...(input.eventStore !== undefined ? { eventStore: input.eventStore } : {}),
  });
}
