// cspell:ignore rproof
// bh-14a — the DB side of the resolution proof seal. `collectProofEvidence`
// reads the full issue-loop evidence from the durable/append-only spine tables;
// `sealResolutionProof` chains it (via `resolutionProof.ts`) and persists an
// append-only `resolution_proofs` row + emits the frozen `resolution.proof.sealed`
// event. Both run on a caller-owned, already-org-scoped transaction client so the
// seal is atomic with the terminal transition that drives it (a blocked authority
// decision, or a verified_closed source sync). `verifyPersistedProof` re-collects
// the CURRENT evidence and recomputes the chain, so a tampered linked row is
// detectable through the read surface.

import { createHash } from "node:crypto";
import type pg from "pg";
import { runWithOrgScope } from "@tanren/db";
import { PgEventStore } from "../eventStore.js";
import {
  buildResolutionProof,
  RESOLUTION_PROOF_VERSION,
  verifyResolutionProof,
  type EvidenceRunSection,
  type ProofVerification,
  type ResolutionDecisionSection,
  type ResolutionProofEvidence,
  type ResolutionProofTerminal,
  type SealedResolutionProof,
  type SpecOriginSection,
} from "./resolutionProof.js";

export type ResolutionProofSealInput = {
  readonly orgId: string;
  readonly projectId: string;
  readonly issueLoopId: string;
  readonly resolutionJobId: string;
  readonly resolutionDecisionId: string;
};

/**
 * Verify-time pins from a previously sealed proof: re-read exactly the rows the
 * seal chained so a legitimate later append (e.g. a bh-13 repair spec origin) is
 * ignored, while a tampered pinned row is still caught.
 */
export type ProofEvidencePins = {
  readonly specOriginIds: readonly string[];
  readonly sourceFindingId: string | null;
};

export type ResolutionProofSealResult = {
  readonly id: string;
  readonly sealed: boolean;
  readonly proofHash: string;
};

export type PersistedResolutionProof = {
  readonly id: string;
  readonly terminal: ResolutionProofTerminal;
  readonly sealedAt: string;
  readonly proof: SealedResolutionProof;
  readonly verification: ProofVerification;
};

type Row = Record<string, unknown>;

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function intOrNull(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function requireText(value: unknown, field: string): string {
  const text = textOrNull(value);
  if (text === null) throw new Error(`resolution proof evidence has no ${field}`);
  return text;
}

function symptomOutcome(classification: string | null): "passed" | "failed" | "inconclusive" {
  if (classification === "product_resolved") return "passed";
  if (classification === "product_failure") return "failed";
  return "inconclusive";
}

function evidenceRunSection(row: Row | undefined): EvidenceRunSection | null {
  if (row === undefined) return null;
  const verificationRunId = textOrNull(row["id"]);
  if (verificationRunId === null) return null;
  return {
    verificationRunId,
    artifactDigest: textOrNull(row["artifact_digest"]),
    classification: textOrNull(row["classification"]),
    runtimeBehaviorContextHash: textOrNull(row["runtime_behavior_context_hash"]),
  };
}

const LOOP_SQL = `
  SELECT loop.id,
         loop.fingerprint,
         finding.id AS source_finding_id,
         finding.provider_object_id,
         finding.provider_revision,
         contract.source_revision AS contract_source_revision
    FROM issue_loops AS loop
    LEFT JOIN resolution_decisions AS decision
      ON decision.org_id = loop.org_id AND decision.id = $3
    LEFT JOIN symptom_contracts AS contract
      ON contract.org_id = loop.org_id AND contract.id = decision.contract_id
    LEFT JOIN LATERAL (
      SELECT sf.id, sf.provider_object_id, sf.provider_revision
        FROM source_findings AS sf
       WHERE sf.org_id = loop.org_id AND sf.issue_loop_id = loop.id
         AND ($4::text IS NULL OR sf.id = $4)
       ORDER BY sf.observed_at DESC, sf.id DESC LIMIT 1
    ) AS finding ON TRUE
   WHERE loop.org_id = $1 AND loop.id = $2`;

const PRIOR_RUN_SQL = `
  SELECT run.id, run.artifact_digest, run.classification, run.runtime_behavior_context_hash
    FROM resolution_jobs AS prior_job
    JOIN behavior_verification_runs AS run
      ON run.org_id = prior_job.org_id AND run.resolution_job_id = prior_job.id
   WHERE prior_job.org_id = $1 AND prior_job.issue_loop_id = $2 AND prior_job.contract_id = $3
     AND prior_job.stage = $4 AND run.stage = $4 AND run.status = 'completed' AND run.classification = $5
   ORDER BY run.created_at DESC, run.id DESC LIMIT 1`;

/**
 * Gather every evidence section for one issue loop's terminal resolution. Returns
 * undefined only when the loop or its decision is not visible (fail-closed: a
 * caller never seals a proof over evidence it cannot read).
 */
export async function collectProofEvidence(
  client: pg.PoolClient,
  input: ResolutionProofSealInput,
  pins?: ProofEvidencePins,
): Promise<ResolutionProofEvidence | undefined> {
  const { orgId, projectId, issueLoopId, resolutionJobId, resolutionDecisionId } = input;
  const decisionRow = (
    await client.query<Row>(
      `SELECT id, decision, input_snapshot_hash, authority_version, contract_id, release_instance_id
         FROM resolution_decisions
        WHERE org_id = $1 AND id = $2`,
      [orgId, resolutionDecisionId],
    )
  ).rows[0];
  const loopRow = (
    await client.query<Row>(LOOP_SQL, [orgId, issueLoopId, resolutionDecisionId, pins?.sourceFindingId ?? null])
  ).rows[0];
  if (decisionRow === undefined || loopRow === undefined) return undefined;
  const contractId = requireText(decisionRow["contract_id"], "contract_id");
  const releaseInstanceId = textOrNull(decisionRow["release_instance_id"]);

  const productionRow = (
    await client.query<Row>(
      `SELECT id, classification, artifact_digest, prepared_head_sha, status, runtime_behavior_context_hash
         FROM behavior_verification_runs
        WHERE org_id = $1 AND resolution_job_id = $2 AND stage = 'production'
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [orgId, resolutionJobId],
    )
  ).rows[0];
  const productionRunId = textOrNull(productionRow?.["id"]);
  const preparedHeadSha = textOrNull(productionRow?.["prepared_head_sha"]);

  // The evidence rows are read SEQUENTIALLY: this collection always runs on a
  // single caller-owned transaction/scoped client, and one pg client cannot run
  // concurrent queries. A null id yields zero rows, so the release/production
  // reads need no useless-undefined branch — an absent row reads absent.
  const triageRow = (
    await client.query<Row>(
      `SELECT task_id, status, agent_kind FROM tasks
        WHERE org_id = $1 AND issue_loop_id = $2 AND kind = 'triage' ORDER BY task_id LIMIT 1`,
      [orgId, issueLoopId],
    )
  ).rows[0];
  const specOriginRows = (
    await client.query<Row>(
      `SELECT id, spec_id, role, attempt_number, ordinal FROM spec_origins
        WHERE org_id = $1 AND issue_loop_id = $2 AND ($3::text[] IS NULL OR id = ANY($3))
        ORDER BY ordinal, id`,
      [orgId, issueLoopId, pins?.specOriginIds ?? null],
    )
  ).rows;
  const baselineRow = (
    await client.query<Row>(PRIOR_RUN_SQL, [orgId, issueLoopId, contractId, "baseline", "product_failure"])
  ).rows[0];
  const counterfactualRow = (
    await client.query<Row>(PRIOR_RUN_SQL, [orgId, issueLoopId, contractId, "counterfactual", "product_resolved"])
  ).rows[0];
  const releaseRow = (
    await client.query<Row>(
      `SELECT id, artifact_digest, url, state, source_ref FROM release_instances
        WHERE org_id = $1 AND id = $2`,
      [orgId, releaseInstanceId],
    )
  ).rows[0];
  const sourceSyncRow = (
    await client.query<Row>(
      `SELECT id, operation, state, provider_receipt, readback FROM source_sync_outbox
        WHERE org_id = $1 AND issue_loop_id = $2 AND resolution_decision_id = $3 AND operation = 'close'
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [orgId, issueLoopId, resolutionDecisionId],
    )
  ).rows[0];
  const assertionRows = (
    await client.query<Row>(
      `SELECT id, outcome FROM verification_assertions
        WHERE org_id = $1 AND verification_run_id = $2 ORDER BY id`,
      [orgId, productionRunId],
    )
  ).rows;

  const mergeSha = preparedHeadSha ?? textOrNull(releaseRow?.["source_ref"]);
  const auditRow =
    mergeSha === null
      ? undefined
      : (
          await client.query<Row>(
            `SELECT audit_id, main_sha FROM authority_land_receipts
              WHERE org_id = $1 AND project_id = $2 AND main_sha = $3
              ORDER BY created_at DESC, id DESC LIMIT 1`,
            [orgId, projectId, mergeSha],
          )
        ).rows[0];

  const decisionSection: ResolutionDecisionSection = {
    decisionId: requireText(decisionRow["id"], "resolution_decisions.id"),
    decision: requireText(decisionRow["decision"], "decision") as ResolutionDecisionSection["decision"],
    inputSnapshotHash: requireText(decisionRow["input_snapshot_hash"], "input_snapshot_hash"),
    authorityVersion: requireText(decisionRow["authority_version"], "authority_version"),
  };

  return {
    orgId,
    projectId,
    issueLoopId,
    resolutionJobId,
    resolutionDecisionId,
    sections: {
      issue_loop: {
        issueLoopId: requireText(loopRow["id"], "issue_loops.id"),
        fingerprint: textOrNull(loopRow["fingerprint"]),
        sourceRevision: textOrNull(loopRow["contract_source_revision"]) ?? textOrNull(loopRow["provider_revision"]),
        sourceFindingId: textOrNull(loopRow["source_finding_id"]),
        providerObjectId: textOrNull(loopRow["provider_object_id"]),
      },
      triage:
        triageRow === undefined
          ? null
          : {
              taskId: requireText(triageRow["task_id"], "tasks.task_id"),
              status: textOrNull(triageRow["status"]),
              agentKind: textOrNull(triageRow["agent_kind"]),
            },
      spec_origins: specOriginRows.map(
        (row): SpecOriginSection => ({
          id: requireText(row["id"], "spec_origins.id"),
          specId: requireText(row["spec_id"], "spec_origins.spec_id"),
          role: requireText(row["role"], "spec_origins.role"),
          attemptNumber: intOrNull(row["attempt_number"]),
          ordinal: intOrNull(row["ordinal"]),
        }),
      ),
      merge: mergeSha === null ? null : { mergeSha, authorityAuditId: textOrNull(auditRow?.["audit_id"]) },
      deployment:
        releaseRow === undefined
          ? null
          : {
              releaseInstanceId: requireText(releaseRow["id"], "release_instances.id"),
              artifactDigest: textOrNull(releaseRow["artifact_digest"]),
              url: textOrNull(releaseRow["url"]),
              state: textOrNull(releaseRow["state"]),
              sourceRef: textOrNull(releaseRow["source_ref"]),
            },
      baseline: evidenceRunSection(baselineRow),
      counterfactual: evidenceRunSection(counterfactualRow),
      production_symptom:
        productionRow === undefined || productionRunId === null
          ? null
          : {
              verificationRunId: productionRunId,
              classification: textOrNull(productionRow["classification"]),
              outcome: symptomOutcome(textOrNull(productionRow["classification"])),
              artifactDigest: textOrNull(productionRow["artifact_digest"]),
              runtimeBehaviorContextHash: textOrNull(productionRow["runtime_behavior_context_hash"]),
              preparedHeadSha,
              probedUrl: textOrNull(releaseRow?.["url"]),
              assertions: assertionRows.map((row) => ({
                id: requireText(row["id"], "verification_assertions.id"),
                outcome: requireText(row["outcome"], "verification_assertions.outcome"),
              })),
            },
      resolution_decision: decisionSection,
      source_sync:
        sourceSyncRow === undefined
          ? null
          : {
              outboxId: requireText(sourceSyncRow["id"], "source_sync_outbox.id"),
              operation: requireText(sourceSyncRow["operation"], "source_sync_outbox.operation"),
              state: requireText(sourceSyncRow["state"], "source_sync_outbox.state"),
              providerReceipt: sourceSyncRow["provider_receipt"] ?? null,
              readback: sourceSyncRow["readback"] ?? null,
            },
    },
  };
}

function proofId(terminal: ResolutionProofTerminal, resolutionDecisionId: string): string {
  const digest = createHash("sha256").update(`${terminal}:${resolutionDecisionId}`).digest("hex").slice(0, 48);
  return `rproof_${terminal === "blocked" ? "blocked" : "closed"}_${digest}`;
}

/**
 * Seal a proof over the loop's current terminal evidence and emit
 * `resolution.proof.sealed`. Idempotent per (terminal, decision): a replay finds
 * the existing append-only row and neither re-inserts nor re-emits.
 */
export async function sealResolutionProof(
  client: pg.PoolClient,
  input: ResolutionProofSealInput,
  terminal: ResolutionProofTerminal,
): Promise<ResolutionProofSealResult | undefined> {
  const evidence = await collectProofEvidence(client, input);
  if (evidence === undefined) return undefined;
  const proof = buildResolutionProof(evidence, terminal);
  const id = proofId(terminal, input.resolutionDecisionId);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO resolution_proofs
       (org_id, project_id, id, issue_loop_id, resolution_job_id, resolution_decision_id, terminal, proof_hash, proof_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (org_id, id) DO NOTHING
     RETURNING id`,
    [
      input.orgId,
      input.projectId,
      id,
      input.issueLoopId,
      input.resolutionJobId,
      input.resolutionDecisionId,
      terminal,
      proof.proofHash,
      JSON.stringify(proof),
    ],
  );
  const sealed = inserted.rowCount === 1;
  if (sealed) {
    await new PgEventStore(client).append({
      orgId: input.orgId,
      projectId: input.projectId,
      eventType: "resolution.proof.sealed",
      payload: {
        projectId: input.projectId,
        issueLoopId: input.issueLoopId,
        resolutionJobId: input.resolutionJobId,
        proofHash: proof.proofHash,
      },
    });
  }
  return { id, sealed, proofHash: proof.proofHash };
}

/** Read one persisted proof and re-verify it against the current evidence. */
async function hydrate(client: pg.PoolClient, row: Row): Promise<PersistedResolutionProof> {
  const proof = row["proof_json"] as SealedResolutionProof;
  const currentEvidence = await collectProofEvidence(
    client,
    {
      orgId: requireText(row["org_id"], "org_id"),
      projectId: requireText(row["project_id"], "project_id"),
      issueLoopId: requireText(row["issue_loop_id"], "issue_loop_id"),
      resolutionJobId: requireText(row["resolution_job_id"], "resolution_job_id"),
      resolutionDecisionId: requireText(row["resolution_decision_id"], "resolution_decision_id"),
    },
    {
      specOriginIds: proof.evidence.sections.spec_origins.map((origin) => origin.id),
      sourceFindingId: proof.evidence.sections.issue_loop.sourceFindingId,
    },
  );
  const verification: ProofVerification =
    currentEvidence === undefined
      ? { valid: false, divergedAt: proof.entries[0]?.kind ?? null, recomputedProofHash: "" }
      : verifyResolutionProof(currentEvidence, proof);
  return {
    id: requireText(row["id"], "id"),
    terminal: requireText(row["terminal"], "terminal") as ResolutionProofTerminal,
    sealedAt: String(row["created_at"] instanceof Date ? row["created_at"].toISOString() : row["created_at"]),
    proof,
    verification,
  };
}

/** Read-only proof surface for the GET route. Reads run on the org-scoping pool. */
export class ResolutionProofStore {
  public constructor(private readonly pool: pg.Pool) {}

  public async listForLoop(orgId: string, projectId: string, issueLoopId: string): Promise<PersistedResolutionProof[]> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const rows = await client.query<Row>(
        `SELECT org_id, project_id, id, issue_loop_id, resolution_job_id, resolution_decision_id,
                terminal, proof_hash, proof_json, created_at
           FROM resolution_proofs
          WHERE org_id = $1 AND project_id = $2 AND issue_loop_id = $3
          ORDER BY created_at, id`,
        [orgId, projectId, issueLoopId],
      );
      const proofs: PersistedResolutionProof[] = [];
      for (const row of rows.rows) proofs.push(await hydrate(client, row));
      return proofs;
    });
  }
}

export { RESOLUTION_PROOF_VERSION };
