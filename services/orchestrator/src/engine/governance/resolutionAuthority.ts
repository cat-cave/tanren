// cspell:ignore rdec
import { runWithOrgScope } from "@tanren/db";
import { createHash } from "node:crypto";
import type pg from "pg";
import type {
  ResolutionAuthorization,
  ResolutionAuthority as ResolutionAuthorityContract,
  ResolutionDecision,
  ResolutionEvidenceRun,
  ResolutionEvidenceSnapshot,
  ResolutionProofGrade,
} from "../contracts/resolutionAuthority.js";
import { RESOLUTION_AUTHORITY_VERSION } from "../contracts/resolutionAuthority.js";
import { PgEventStore } from "../eventStore.js";
import { SourceSyncOutboxStore } from "../repositories/sourceSyncOutbox.js";
import { sealResolutionProof } from "./resolutionProofSealer.js";

export interface ResolutionAuthorityEvidenceSource {
  snapshot(input: { readonly orgId: string; readonly resolutionJobId: string }): Promise<ResolutionEvidenceSnapshot>;
}

export interface ResolutionAuthorityDecisionStore {
  record(input: {
    readonly snapshot: ResolutionEvidenceSnapshot;
    readonly decision: ResolutionDecision;
    readonly decisionReasons: readonly string[];
    readonly authorityVersion: string;
    readonly inputSnapshotHash: string;
  }): Promise<{ readonly id: string; readonly created: boolean }>;
}

/** Deterministic JSON for the immutable decision-input digest. */
export function canonicalResolutionSnapshot(snapshot: ResolutionEvidenceSnapshot): string {
  return JSON.stringify(canonicalValue(snapshot));
}

export function resolutionSnapshotHash(snapshot: ResolutionEvidenceSnapshot): string {
  return `sha256:${createHash("sha256").update(canonicalResolutionSnapshot(snapshot)).digest("hex")}`;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

/** The pure, fail-closed truth table. `waived` is unreachable without waive(). */
export function decideResolution(snapshot: ResolutionEvidenceSnapshot): {
  decision: ResolutionDecision;
  reasons: string[];
} {
  if (snapshot.waiver !== undefined) return { decision: "waived", reasons: ["operator waiver recorded"] };
  const { production } = snapshot;
  if (
    production.outcome === "inconclusive" ||
    production.classification === "infra_failure" ||
    production.classification === "inconclusive"
  ) {
    return {
      decision: "needs_attention",
      reasons: ["production verification is inconclusive or infrastructure-failed"],
    };
  }
  if (production.outcome !== "passed" || production.classification !== "product_resolved") {
    return { decision: "blocked", reasons: ["production symptom verification did not pass"] };
  }

  const reasons: string[] = [];
  if (snapshot.contract.hash === null || snapshot.contract.sourceRevision === null)
    reasons.push("locked contract evidence is incomplete");
  if (snapshot.baseline === null) reasons.push("successful baseline reproduction is missing");
  if (snapshot.counterfactual === null) reasons.push("successful counterfactual evidence is missing");
  if (snapshot.merge.authorityAuditId === null || snapshot.merge.sha === null)
    reasons.push("MergeAuthority receipt is missing");
  if (snapshot.merge.sha !== production.mergeSha)
    reasons.push("production evidence is not bound to the MergeAuthority SHA");
  if (snapshot.deployment.artifactDigest === null || snapshot.deployment.mergeSha === null) {
    reasons.push("exact deployed release binding is missing");
  }
  if (snapshot.deployment.artifactDigest !== production.artifactDigest) {
    reasons.push("production evidence is not bound to the deployed artifact digest");
  }
  if (snapshot.deployment.mergeSha !== production.mergeSha) {
    reasons.push("production evidence is not bound to the deployed merge SHA");
  }
  if (snapshot.production.assertionOutcomes.length === 0) reasons.push("fresh production assertions are missing");
  if (snapshot.production.assertionOutcomes.some((assertion) => assertion.outcome !== "passed")) {
    reasons.push("a fresh production assertion did not pass");
  }
  if (!proofSatisfiesPolicy(snapshot)) reasons.push("proof grade does not satisfy the project resolution policy");
  return { decision: reasons.length === 0 ? "authorized" : "blocked", reasons };
}

function proofSatisfiesPolicy(snapshot: ResolutionEvidenceSnapshot): boolean {
  if (snapshot.resolutionPolicy === "active_causal") {
    return snapshot.proofGrade === "active_causal" || snapshot.proofGrade === "active_plus_soak";
  }
  if (snapshot.resolutionPolicy === "active_plus_soak") {
    return snapshot.proofGrade === "active_plus_soak" && snapshot.soak !== null;
  }
  // Observational and attested policies need an operator's judgment; never turn
  // their weaker evidence into autonomous source closure.
  return false;
}

/**
 * The sole resolution decider. It owns the only transition from verified evidence
 * to an internal resolution declaration; future source-outbox work consumes its
 * authorized/waived result rather than recreating this truth table.
 */
export class ResolutionAuthority implements ResolutionAuthorityContract {
  public constructor(
    private readonly evidence: ResolutionAuthorityEvidenceSource,
    private readonly decisions: ResolutionAuthorityDecisionStore,
  ) {}

  public async authorize(input: { orgId: string; resolutionJobId: string }): Promise<ResolutionAuthorization> {
    return this.decide(await this.evidence.snapshot(input));
  }

  public async waive(input: {
    orgId: string;
    resolutionJobId: string;
    operatorId: string;
    reason: string;
  }): Promise<ResolutionAuthorization> {
    const snapshot = await this.evidence.snapshot(input);
    return this.decide({
      ...snapshot,
      waiver: {
        operatorId: input.operatorId,
        reasonHash: `sha256:${createHash("sha256").update(input.reason).digest("hex")}`,
      },
    });
  }

  private async decide(snapshot: ResolutionEvidenceSnapshot): Promise<ResolutionAuthorization> {
    const { decision, reasons } = decideResolution(snapshot);
    const inputSnapshotHash = resolutionSnapshotHash(snapshot);
    const recorded = await this.decisions.record({
      snapshot,
      decision,
      decisionReasons: reasons,
      authorityVersion: RESOLUTION_AUTHORITY_VERSION,
      inputSnapshotHash,
    });
    return { ...recorded, decision, inputSnapshotHash, reasons };
  }
}

type EvidenceRow = Record<string, unknown>;

/** Real DB reader: every field comes from immutable/append-only evidence tables. */
export class PgResolutionAuthorityEvidenceSource implements ResolutionAuthorityEvidenceSource {
  public constructor(private readonly pool: pg.Pool) {}

  public async snapshot(input: { orgId: string; resolutionJobId: string }): Promise<ResolutionEvidenceSnapshot> {
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      const result = await client.query<EvidenceRow>(EVIDENCE_SQL, [input.orgId, input.resolutionJobId]);
      const row = result.rows[0];
      if (row === undefined) throw new Error(`resolution job ${input.resolutionJobId} is not visible to its authority`);
      const productionRunId = textOrNull(row["production_run_id"]);
      const assertionResult =
        productionRunId === null
          ? { rows: [] as Array<{ id: unknown; outcome: unknown }> }
          : await client.query<{ id: unknown; outcome: unknown }>(
              `SELECT id, outcome
                 FROM verification_assertions
                WHERE org_id = $1 AND verification_run_id = $2
                ORDER BY id`,
              [input.orgId, productionRunId],
            );
      return {
        version: "tanren-resolution-evidence.v1",
        orgId: input.orgId,
        projectId: requiredText(row["project_id"], "project_id"),
        resolutionJobId: input.resolutionJobId,
        issueLoopId: requiredText(row["issue_loop_id"], "issue_loop_id"),
        contract: {
          id: requiredText(row["contract_id"], "contract_id"),
          hash: textOrNull(row["contract_hash"]),
          sourceRevision: textOrNull(row["source_revision"]),
        },
        baseline: evidenceRun(row, "baseline"),
        counterfactual: evidenceRun(row, "counterfactual"),
        soak: evidenceRun(row, "soak"),
        merge: { authorityAuditId: textOrNull(row["authority_audit_id"]), sha: textOrNull(row["authority_merge_sha"]) },
        deployment: {
          releaseInstanceId: textOrNull(row["release_instance_id"]),
          artifactDigest: textOrNull(row["release_artifact_digest"]),
          mergeSha: textOrNull(row["release_merge_sha"]),
        },
        production: {
          verificationRunId: productionRunId,
          artifactDigest: textOrNull(row["production_artifact_digest"]) ?? "missing-artifact-digest",
          mergeSha: textOrNull(row["production_merge_sha"]) ?? "missing-merge-sha",
          outcome: productionOutcome(textOrNull(row["production_classification"])),
          classification: productionClassification(textOrNull(row["production_classification"])),
          assertionOutcomes: assertionResult.rows.map((assertion) => ({
            id: requiredText(assertion.id, "verification_assertions.id"),
            outcome: assertionOutcome(assertion.outcome),
          })),
        },
        proofGrade: proofGrade(textOrNull(row["production_proof_grade"])),
        resolutionPolicy: proofGrade(textOrNull(row["resolution_policy"])),
      };
    });
  }
}

const EVIDENCE_SQL = `
  SELECT job.project_id,
         job.contract_id,
         job.release_instance_id,
         job.issue_loop_id,
         contract.canonical_hash AS contract_hash,
         contract.source_revision,
         loop.resolution_policy,
         production.id AS production_run_id,
         production.classification AS production_classification,
         production.artifact_digest AS production_artifact_digest,
         production.prepared_head_sha AS production_merge_sha,
         production.policy->>'proofPolicy' AS production_proof_grade,
         release.artifact_digest AS release_artifact_digest,
         release.source_ref AS release_merge_sha,
         baseline.id AS baseline_run_id,
         baseline.artifact_digest AS baseline_artifact_digest,
         baseline.prepared_head_sha AS baseline_merge_sha,
         counterfactual.id AS counterfactual_run_id,
         counterfactual.artifact_digest AS counterfactual_artifact_digest,
         counterfactual.prepared_head_sha AS counterfactual_merge_sha,
         soak.id AS soak_run_id,
         soak.artifact_digest AS soak_artifact_digest,
         soak.prepared_head_sha AS soak_merge_sha,
         merged.audit_id AS authority_audit_id,
         merged.main_sha AS authority_merge_sha
    FROM resolution_jobs AS job
    JOIN symptom_contracts AS contract
      ON contract.org_id = job.org_id AND contract.id = job.contract_id
    JOIN issue_loops AS loop
      ON loop.org_id = job.org_id AND loop.id = job.issue_loop_id
    LEFT JOIN release_instances AS release
      ON release.org_id = job.org_id AND release.id = job.release_instance_id
    LEFT JOIN behavior_verification_runs AS production
      ON production.org_id = job.org_id
     AND production.resolution_job_id = job.id
     AND production.stage = 'production'
    LEFT JOIN LATERAL (
      SELECT run.id, run.artifact_digest, run.prepared_head_sha
        FROM resolution_jobs AS prior_job
        JOIN behavior_verification_runs AS run
          ON run.org_id = prior_job.org_id AND run.resolution_job_id = prior_job.id
       WHERE prior_job.org_id = job.org_id AND prior_job.contract_id = job.contract_id
         AND prior_job.issue_loop_id = job.issue_loop_id AND prior_job.stage = 'baseline'
         AND run.stage = 'baseline' AND run.status = 'completed' AND run.classification = 'product_failure'
       ORDER BY run.created_at DESC, run.id DESC LIMIT 1
    ) AS baseline ON TRUE
    LEFT JOIN LATERAL (
      SELECT run.id, run.artifact_digest, run.prepared_head_sha
        FROM resolution_jobs AS prior_job
        JOIN behavior_verification_runs AS run
          ON run.org_id = prior_job.org_id AND run.resolution_job_id = prior_job.id
       WHERE prior_job.org_id = job.org_id AND prior_job.contract_id = job.contract_id
         AND prior_job.issue_loop_id = job.issue_loop_id AND prior_job.stage = 'counterfactual'
         AND run.stage = 'counterfactual' AND run.status = 'completed' AND run.classification = 'product_resolved'
       ORDER BY run.created_at DESC, run.id DESC LIMIT 1
    ) AS counterfactual ON TRUE
    LEFT JOIN LATERAL (
      SELECT run.id, run.artifact_digest, run.prepared_head_sha
        FROM resolution_jobs AS prior_job
        JOIN behavior_verification_runs AS run
          ON run.org_id = prior_job.org_id AND run.resolution_job_id = prior_job.id
       WHERE prior_job.org_id = job.org_id AND prior_job.contract_id = job.contract_id
         AND prior_job.issue_loop_id = job.issue_loop_id AND prior_job.stage = 'soak'
         AND run.stage = 'soak' AND run.status = 'completed' AND run.classification = 'product_resolved'
       ORDER BY run.created_at DESC, run.id DESC LIMIT 1
    ) AS soak ON TRUE
    LEFT JOIN LATERAL (
      SELECT receipt.audit_id, receipt.main_sha
        FROM authority_land_receipts AS receipt
        JOIN authority_effect_intents AS intent
          ON intent.org_id = receipt.org_id AND intent.id = receipt.effect_intent_id
        JOIN authority_decisions AS decision
          ON decision.org_id = intent.org_id AND decision.id = intent.decision_id
       WHERE receipt.org_id = job.org_id AND receipt.project_id = job.project_id
         AND receipt.main_sha = production.prepared_head_sha
       ORDER BY receipt.created_at DESC, receipt.id DESC LIMIT 1
    ) AS merged ON TRUE
   WHERE job.org_id = $1 AND job.id = $2`;

function evidenceRun(row: EvidenceRow, prefix: "baseline" | "counterfactual" | "soak"): ResolutionEvidenceRun | null {
  const verificationRunId = textOrNull(row[`${prefix}_run_id`]);
  const artifactDigest = textOrNull(row[`${prefix}_artifact_digest`]);
  const mergeSha = textOrNull(row[`${prefix}_merge_sha`]);
  return verificationRunId === null || artifactDigest === null || mergeSha === null
    ? null
    : { verificationRunId, artifactDigest, mergeSha };
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredText(value: unknown, field: string): string {
  const text = textOrNull(value);
  if (text === null) throw new Error(`resolution authority evidence has no ${field}`);
  return text;
}

function productionOutcome(classification: string | null): "passed" | "failed" | "inconclusive" {
  if (classification === "product_resolved") return "passed";
  if (classification === "product_failure") return "failed";
  return "inconclusive";
}

function productionClassification(
  value: string | null,
): "product_resolved" | "product_failure" | "infra_failure" | "inconclusive" | "unknown" {
  if (
    value === "product_resolved" ||
    value === "product_failure" ||
    value === "infra_failure" ||
    value === "inconclusive"
  )
    return value;
  return "unknown";
}

function assertionOutcome(value: unknown): "passed" | "failed" | "inconclusive" {
  if (value === "passed" || value === "failed" || value === "inconclusive") return value;
  return "inconclusive";
}

function proofGrade(value: string | null): ResolutionProofGrade | "unknown" {
  if (value === "active_causal" || value === "active_plus_soak" || value === "observational" || value === "attested")
    return value;
  return "unknown";
}

/** Append-only decision writer and the only internal-resolution state transition. */
export class PgResolutionAuthorityDecisionStore implements ResolutionAuthorityDecisionStore {
  public constructor(private readonly pool: pg.Pool) {}

  public async record(input: {
    snapshot: ResolutionEvidenceSnapshot;
    decision: ResolutionDecision;
    decisionReasons: readonly string[];
    authorityVersion: string;
    inputSnapshotHash: string;
  }): Promise<{ id: string; created: boolean }> {
    const id = `rdec_${input.inputSnapshotHash.slice("sha256:".length)}`;
    return runWithOrgScope(this.pool, input.snapshot.orgId, async (client) => {
      const inserted = await client.query<{ id: unknown }>(
        `INSERT INTO resolution_decisions
           (org_id, project_id, id, resolution_job_id, issue_loop_id, decision, decision_reasons,
            authority_version, contract_id, release_instance_id, verification_run_id, input_snapshot_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
         ON CONFLICT (org_id, id) DO NOTHING
         RETURNING id`,
        [
          input.snapshot.orgId,
          input.snapshot.projectId,
          id,
          input.snapshot.resolutionJobId,
          input.snapshot.issueLoopId,
          input.decision,
          JSON.stringify(input.decisionReasons),
          input.authorityVersion,
          input.snapshot.contract.id,
          input.snapshot.deployment.releaseInstanceId,
          input.snapshot.production.verificationRunId,
          input.inputSnapshotHash,
        ],
      );
      if (inserted.rowCount === 0) return { id, created: false };
      const state =
        input.decision === "authorized" || input.decision === "waived"
          ? "verified_source_sync_pending"
          : input.decision === "needs_attention"
            ? "needs_attention"
            : "remediating";
      const updated = await client.query<{ source_id: string }>(
        `UPDATE issue_loops
            SET state = $3, row_version = row_version + 1, updated_at = now()
          WHERE org_id = $1 AND id = $2
        RETURNING source_id`,
        [input.snapshot.orgId, input.snapshot.issueLoopId, state],
      );
      if (updated.rowCount !== 1)
        throw new Error(`resolution authority could not transition issue loop ${input.snapshot.issueLoopId}`);
      const events = new PgEventStore(client);
      if (input.decision === "authorized" || input.decision === "waived") {
        const sourceId = updated.rows[0]?.source_id;
        if (sourceId === undefined)
          throw new Error(`resolution authority could not identify source for ${input.snapshot.issueLoopId}`);
        const queued = await SourceSyncOutboxStore.enqueueWithOutcome(client, {
          orgId: input.snapshot.orgId,
          issueLoopId: input.snapshot.issueLoopId,
          sourceId,
          operation: "close",
          payload: { desiredState: "closed" },
          resolutionDecisionId: id,
        });
        if (queued.inserted) {
          await events.append({
            orgId: input.snapshot.orgId,
            projectId: input.snapshot.projectId,
            eventType: "source_issue.sync.enqueued",
            payload: {
              projectId: input.snapshot.projectId,
              issueLoopId: input.snapshot.issueLoopId,
              sourceSyncOutboxId: queued.row.id,
              attempt: 0,
            },
          });
        }
      }
      await events.append({
        orgId: input.snapshot.orgId,
        projectId: input.snapshot.projectId,
        eventType: `resolution.${input.decision}`,
        payload: {
          projectId: input.snapshot.projectId,
          issueLoopId: input.snapshot.issueLoopId,
          resolutionJobId: input.snapshot.resolutionJobId,
          resolutionDecisionId: id,
          inputSnapshotHash: input.inputSnapshotHash,
        },
      });
      // A blocked decision is a terminal outcome for this attempt: seal a
      // tamper-evident proof over its evidence in the SAME transaction so the
      // blocked verdict (symptom failed while gate/merge/deploy stayed green) is
      // durably recorded. The authorized/waived terminal is sealed later, when
      // the source sync reaches verified_closed. `needs_attention` is a hold, not
      // a terminal, so it seals nothing here.
      if (input.decision === "blocked") {
        await sealResolutionProof(
          client,
          {
            orgId: input.snapshot.orgId,
            projectId: input.snapshot.projectId,
            issueLoopId: input.snapshot.issueLoopId,
            resolutionJobId: input.snapshot.resolutionJobId,
            resolutionDecisionId: id,
          },
          "blocked",
        );
      }
      return { id, created: true };
    });
  }
}

/** Production composition: resolution evidence reader + immutable decision writer. */
export function buildResolutionAuthority(pool: pg.Pool): ResolutionAuthority {
  return new ResolutionAuthority(
    new PgResolutionAuthorityEvidenceSource(pool),
    new PgResolutionAuthorityDecisionStore(pool),
  );
}
