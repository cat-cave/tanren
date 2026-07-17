// bh-13 — deterministic P0 repair routing after a fail-closed blocked decision.
// The router deliberately has no caller-provided verdict or evidence fields: it
// reads the immutable ResolutionAuthority decision and its locked evidence itself.

import { runWithOrgScope } from "@tanren/db";
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { PgEventStore } from "../eventStore.js";
import { SpecOriginStore } from "../repositories/specOrigins.js";
import { createSpecOnClient } from "./projectSpec.js";

type QueryClient = Pick<pg.PoolClient, "query">;

export type RepairRouteInput = {
  readonly orgId: string;
  readonly resolutionDecisionId: string;
  /** Present on a caller-addressed route so the immutable decision must match its URL scope. */
  readonly projectId?: string;
  readonly issueLoopId?: string;
};

export type RepairRouteResult =
  | {
      readonly kind: "routed";
      readonly created: boolean;
      readonly projectId: string;
      readonly issueLoopId: string;
      readonly remediationAttemptId: string;
      readonly specId: string;
      readonly failureSignatureHash: string;
    }
  | {
      readonly kind: "needs_attention";
      readonly projectId: string;
      readonly issueLoopId: string;
      readonly failureSignatureHash: string;
      readonly reason: "fixed_point" | "missing_lineage";
    };

export interface RepairRouter {
  route(input: RepairRouteInput): Promise<RepairRouteResult>;
}

/** The shared predicate used by the Pg router and the conformance fake. */
export function decideRepairRoute(input: {
  readonly sameDecisionAlreadyRouted: boolean;
  readonly failureSignatureAlreadyRouted: boolean;
  readonly mergedLineageAvailable: boolean;
}): "idempotent" | "fixed_point" | "missing_lineage" | "route" {
  if (input.sameDecisionAlreadyRouted) return "idempotent";
  if (input.failureSignatureAlreadyRouted) return "fixed_point";
  if (!input.mergedLineageAvailable) return "missing_lineage";
  return "route";
}

export class RepairRoutingDecisionNotFoundError extends Error {
  public override readonly name = "RepairRoutingDecisionNotFoundError";

  public constructor(resolutionDecisionId: string) {
    super(`resolution decision ${resolutionDecisionId} is not visible to repair routing`);
  }
}

export class RepairRoutingDecisionNotBlockedError extends Error {
  public override readonly name = "RepairRoutingDecisionNotBlockedError";

  public constructor(resolutionDecisionId: string) {
    super(`resolution decision ${resolutionDecisionId} is not blocked; repair routing is forbidden`);
  }
}

type DecisionRow = {
  readonly id: unknown;
  readonly project_id: unknown;
  readonly issue_loop_id: unknown;
  readonly resolution_job_id: unknown;
  readonly decision: unknown;
  readonly decision_reasons: unknown;
  readonly input_snapshot_hash: unknown;
  readonly contract_id: unknown;
  readonly contract_hash: unknown;
  readonly source_revision: unknown;
  readonly verification_run_id: unknown;
};

type AssertionRow = {
  readonly expected_hash: unknown;
  readonly observed_hash: unknown;
  readonly outcome: unknown;
};

type LoopRow = { readonly current_attempt_id: unknown };

type ParentOriginRow = {
  readonly spec_id: unknown;
  readonly title: unknown;
  readonly triage_task_id: unknown;
  readonly origin_run_id: unknown;
  readonly source_finding_ids: unknown;
};

type AttemptRow = { readonly id: unknown; readonly spec_id: unknown };
type IterationRow = { readonly iteration: unknown };

type FailureAssertion = {
  readonly expectedHash: string;
  readonly observedHash: string;
  readonly outcome: string;
};

type FailureSignatureInput = {
  readonly contractId: string;
  readonly contractHash: string | null;
  readonly sourceRevision: string | null;
  readonly decisionReasons: readonly string[];
  readonly assertions: readonly FailureAssertion[];
};

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`repair routing has no ${name}`);
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`repair routing has malformed ${name}`);
  }
  return [...new Set(value)].sort((left, right) => left.localeCompare(right));
}

function decisionReasons(value: unknown): string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return [...value].sort((left, right) => left.localeCompare(right));
  }
  if (typeof value !== "string") throw new Error("repair routing has malformed decision_reasons");
  try {
    return stringArray(JSON.parse(value), "decision_reasons");
  } catch {
    throw new Error("repair routing has malformed decision_reasons");
  }
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

/**
 * A recurrence signature excludes job, decision, and assertion ids on purpose.
 * Those ids change for a replay even when the locked contract observes precisely
 * the same failure. It retains contract revision, decision reasons, and the
 * expected/observed assertion hashes so source/evidence changes can route anew.
 */
export function repairFailureSignature(input: FailureSignatureInput): string {
  const canonical = JSON.stringify(
    canonicalValue({
      version: "tanren-repair-failure-signature.v1",
      contractId: input.contractId,
      contractHash: input.contractHash,
      sourceRevision: input.sourceRevision,
      decisionReasons: [...input.decisionReasons].sort((left, right) => left.localeCompare(right)),
      assertions: [...input.assertions].sort((left, right) =>
        `${left.expectedHash}:${left.observedHash}:${left.outcome}`.localeCompare(
          `${right.expectedHash}:${right.observedHash}:${right.outcome}`,
        ),
      ),
    }),
  );
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function routeHypothesis(resolutionDecisionId: string, failureSignatureHash: string): string {
  return `Deterministic repair for blocked resolution ${resolutionDecisionId} at evidence signature ${failureSignatureHash}`;
}

/**
 * The production repair router. The issue-loop row is locked before checking
 * attempts, making the existing append-only tables sufficient for exactly-one
 * routing without a new migration or an arbitrary attempt cap.
 */
export class PgRepairRouter implements RepairRouter {
  public constructor(private readonly pool: pg.Pool) {}

  public async route(input: RepairRouteInput): Promise<RepairRouteResult> {
    return runWithOrgScope(this.pool, input.orgId, (client) => this.routeOnClient(client, input));
  }

  private async routeOnClient(client: QueryClient, input: RepairRouteInput): Promise<RepairRouteResult> {
    const decision = await this.loadBlockedDecision(client, input);
    const projectId = requiredText(decision.project_id, "resolution_decisions.project_id");
    const issueLoopId = requiredText(decision.issue_loop_id, "resolution_decisions.issue_loop_id");
    if (input.projectId !== undefined && input.projectId !== projectId) {
      throw new RepairRoutingDecisionNotFoundError(input.resolutionDecisionId);
    }
    if (input.issueLoopId !== undefined && input.issueLoopId !== issueLoopId) {
      throw new RepairRoutingDecisionNotFoundError(input.resolutionDecisionId);
    }

    const loop = await client.query<LoopRow>(
      `SELECT current_attempt_id
         FROM issue_loops
        WHERE org_id = $1 AND project_id = $2 AND id = $3
        FOR UPDATE`,
      [input.orgId, projectId, issueLoopId],
    );
    const loopRow = loop.rows[0];
    if (loopRow === undefined) throw new RepairRoutingDecisionNotFoundError(input.resolutionDecisionId);

    const assertions = await this.loadAssertions(client, input.orgId, optionalText(decision.verification_run_id));
    const failureSignatureHash = repairFailureSignature({
      contractId: requiredText(decision.contract_id, "resolution_decisions.contract_id"),
      contractHash: optionalText(decision.contract_hash),
      sourceRevision: optionalText(decision.source_revision),
      decisionReasons: decisionReasons(decision.decision_reasons),
      assertions,
    });
    const hypothesis = routeHypothesis(input.resolutionDecisionId, failureSignatureHash);

    // Replaying the same authority decision is idempotent. This must precede
    // the signature fixed-point check: a retry after a crash is not a recurrence.
    const alreadyRouted = await client.query<AttemptRow>(
      `SELECT id, spec_id
         FROM remediation_attempts
        WHERE org_id = $1 AND project_id = $2 AND issue_loop_id = $3
          AND hypothesis = $4 AND failure_signature = $5
        LIMIT 1`,
      [input.orgId, projectId, issueLoopId, hypothesis, failureSignatureHash],
    );
    const existing = alreadyRouted.rows[0];
    const idempotent = decideRepairRoute({
      sameDecisionAlreadyRouted: existing !== undefined,
      failureSignatureAlreadyRouted: false,
      mergedLineageAvailable: true,
    });
    if (idempotent === "idempotent" && existing !== undefined) {
      return {
        kind: "routed",
        created: false,
        projectId,
        issueLoopId,
        remediationAttemptId: requiredText(existing.id, "remediation_attempts.id"),
        specId: requiredText(existing.spec_id, "remediation_attempts.spec_id"),
        failureSignatureHash,
      };
    }

    // No count is involved. A second, different decision with the same stable
    // evidence signature is the fixed point and is parked for a human decision.
    const repeated = await client.query<AttemptRow>(
      `SELECT id, spec_id
         FROM remediation_attempts
        WHERE org_id = $1 AND project_id = $2 AND issue_loop_id = $3
          AND failure_signature = $4
        LIMIT 1`,
      [input.orgId, projectId, issueLoopId, failureSignatureHash],
    );
    const fixedPoint = decideRepairRoute({
      sameDecisionAlreadyRouted: false,
      failureSignatureAlreadyRouted: repeated.rows[0] !== undefined,
      mergedLineageAvailable: true,
    });
    if (fixedPoint === "fixed_point") {
      await this.parkAtNeedsAttention(client, input.orgId, issueLoopId);
      return { kind: "needs_attention", projectId, issueLoopId, failureSignatureHash, reason: "fixed_point" };
    }

    const parent = await this.loadMergedParentOrigin(client, input.orgId, projectId, issueLoopId);
    const lineage = decideRepairRoute({
      sameDecisionAlreadyRouted: false,
      failureSignatureAlreadyRouted: false,
      mergedLineageAvailable: parent !== undefined && parent.sourceFindingIds.length > 0,
    });
    if (lineage === "missing_lineage" || parent === undefined) {
      await this.parkAtNeedsAttention(client, input.orgId, issueLoopId);
      return { kind: "needs_attention", projectId, issueLoopId, failureSignatureHash, reason: "missing_lineage" };
    }

    const iteration = await this.nextIteration(client, input.orgId, projectId, issueLoopId);
    const remediationAttemptId = `remediation_${randomUUID()}`;
    const spec = await createSpecOnClient(client, {
      projectId,
      title: `P0 repair for ${parent.title}`,
      description: [
        `Deterministic repair successor for issue loop ${issueLoopId}.`,
        `ResolutionAuthority blocked the prior merged fix at evidence signature ${failureSignatureHash}.`,
        `Do not reopen or rewrite ${parent.specId}; resolve the locked symptom contract in this successor.`,
      ].join("\n\n"),
      acceptanceCriteria: [
        "Repair the unresolved behavior captured by the locked symptom contract.",
        "Pass a fresh production symptom verification for this issue loop.",
        "Keep the original merged spec immutable and make the repair only in this successor.",
      ],
      priority: "P0",
      triageProvenance: {
        parentSpecId: parent.specId,
        sourceFindingIds: parent.sourceFindingIds,
        originTriageTaskId: parent.triageTaskId,
        // Normal issue-loop origins have this run id. The decision job is a
        // durable exact-evidence fallback for legacy provenance rows.
        originRunId: parent.originRunId ?? requiredText(decision.resolution_job_id, "resolution_job_id"),
        originIssueLoopId: issueLoopId,
      },
    });
    await SpecOriginStore.record(client, {
      orgId: input.orgId,
      projectId,
      specId: spec.specId,
      issueLoopId,
      triageTaskId: parent.triageTaskId,
      attemptNumber: iteration,
      role: "repair",
      ordinal: 0,
      sourceFindingIds: parent.sourceFindingIds,
    });
    await client.query(
      `INSERT INTO remediation_attempts
         (org_id, project_id, id, issue_loop_id, iteration, hypothesis, spec_id,
          prior_attempt_id, failure_signature)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.orgId,
        projectId,
        remediationAttemptId,
        issueLoopId,
        iteration,
        hypothesis,
        spec.specId,
        optionalText(loopRow.current_attempt_id),
        failureSignatureHash,
      ],
    );
    await client.query(
      `UPDATE issue_loops
          SET state = 'remediating', current_attempt_id = $4, row_version = row_version + 1, updated_at = now()
        WHERE org_id = $1 AND project_id = $2 AND id = $3`,
      [input.orgId, projectId, issueLoopId, remediationAttemptId],
    );

    const events = new PgEventStore(client);
    await events.append({
      orgId: input.orgId,
      projectId,
      eventType: "remediation.attempt.started",
      payload: { projectId, issueLoopId, remediationAttemptId, iteration },
    });
    for (const sourceFindingId of parent.sourceFindingIds) {
      await events.append({
        orgId: input.orgId,
        projectId,
        eventType: "spec.origin.linked",
        payload: { projectId, issueLoopId, specId: spec.specId, sourceFindingId },
      });
    }
    await events.append({
      orgId: input.orgId,
      projectId,
      eventType: "remediation.repair_routed",
      payload: { projectId, issueLoopId, remediationAttemptId, specId: spec.specId, failureSignatureHash },
    });
    return {
      kind: "routed",
      created: true,
      projectId,
      issueLoopId,
      remediationAttemptId,
      specId: spec.specId,
      failureSignatureHash,
    };
  }

  private async loadBlockedDecision(client: QueryClient, input: RepairRouteInput): Promise<DecisionRow> {
    const result = await client.query<DecisionRow>(
      `SELECT decision.id, decision.project_id, decision.issue_loop_id, decision.resolution_job_id,
              decision.decision, decision.decision_reasons, decision.input_snapshot_hash,
              decision.contract_id, contract.canonical_hash AS contract_hash, contract.source_revision,
              decision.verification_run_id
         FROM resolution_decisions AS decision
         JOIN resolution_jobs AS job
           ON job.org_id = decision.org_id AND job.id = decision.resolution_job_id
         JOIN symptom_contracts AS contract
           ON contract.org_id = decision.org_id AND contract.id = decision.contract_id
        WHERE decision.org_id = $1 AND decision.id = $2
        FOR UPDATE OF decision`,
      [input.orgId, input.resolutionDecisionId],
    );
    const decision = result.rows[0];
    if (decision === undefined) throw new RepairRoutingDecisionNotFoundError(input.resolutionDecisionId);
    if (decision.decision !== "blocked") throw new RepairRoutingDecisionNotBlockedError(input.resolutionDecisionId);
    return decision;
  }

  private async loadAssertions(
    client: QueryClient,
    orgId: string,
    verificationRunId: string | null,
  ): Promise<FailureAssertion[]> {
    if (verificationRunId === null) return [];
    const result = await client.query<AssertionRow>(
      `SELECT expected_hash, observed_hash, outcome
         FROM verification_assertions
        WHERE org_id = $1 AND verification_run_id = $2
        ORDER BY expected_hash, observed_hash, outcome`,
      [orgId, verificationRunId],
    );
    return result.rows.map((row) => ({
      expectedHash: requiredText(row.expected_hash, "verification_assertions.expected_hash"),
      observedHash: requiredText(row.observed_hash, "verification_assertions.observed_hash"),
      outcome: requiredText(row.outcome, "verification_assertions.outcome"),
    }));
  }

  private async loadMergedParentOrigin(
    client: QueryClient,
    orgId: string,
    projectId: string,
    issueLoopId: string,
  ): Promise<
    | {
        readonly specId: string;
        readonly title: string;
        readonly triageTaskId: string;
        readonly originRunId: string | null;
        readonly sourceFindingIds: string[];
      }
    | undefined
  > {
    const result = await client.query<ParentOriginRow>(
      `SELECT origin.spec_id, spec.title, origin.triage_task_id, spec.origin_run_id,
              COALESCE(array_agg(finding.source_finding_id ORDER BY finding.source_finding_id)
                FILTER (WHERE finding.source_finding_id IS NOT NULL), '{}'::text[]) AS source_finding_ids
         FROM spec_origins AS origin
         JOIN specs AS spec
           ON spec.org_id = origin.org_id AND spec.project_id = origin.project_id AND spec.spec_id = origin.spec_id
         LEFT JOIN spec_origin_findings AS finding
           ON finding.org_id = origin.org_id AND finding.spec_id = origin.spec_id
        WHERE origin.org_id = $1 AND origin.project_id = $2 AND origin.issue_loop_id = $3
          AND origin.role IN ('primary_fix', 'repair') AND spec.status = 'merged'
        GROUP BY origin.spec_id, spec.title, origin.triage_task_id, spec.origin_run_id,
                 origin.attempt_number, origin.ordinal, origin.id
        ORDER BY origin.attempt_number DESC, origin.ordinal DESC, origin.id DESC
        LIMIT 1`,
      [orgId, projectId, issueLoopId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      specId: requiredText(row.spec_id, "spec_origins.spec_id"),
      title: requiredText(row.title, "specs.title"),
      triageTaskId: requiredText(row.triage_task_id, "spec_origins.triage_task_id"),
      originRunId: optionalText(row.origin_run_id),
      sourceFindingIds: stringArray(row.source_finding_ids, "spec_origin_findings.source_finding_ids"),
    };
  }

  private async nextIteration(
    client: QueryClient,
    orgId: string,
    projectId: string,
    issueLoopId: string,
  ): Promise<number> {
    const result = await client.query<IterationRow>(
      `SELECT COALESCE(MAX(iteration), 0) + 1 AS iteration
         FROM remediation_attempts
        WHERE org_id = $1 AND project_id = $2 AND issue_loop_id = $3`,
      [orgId, projectId, issueLoopId],
    );
    const value = Number(result.rows[0]?.iteration);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("repair routing could not allocate an iteration");
    return value;
  }

  private async parkAtNeedsAttention(client: QueryClient, orgId: string, issueLoopId: string): Promise<void> {
    const updated = await client.query(
      `UPDATE issue_loops
          SET state = 'needs_attention', row_version = row_version + 1, updated_at = now()
        WHERE org_id = $1 AND id = $2`,
      [orgId, issueLoopId],
    );
    if (updated.rowCount !== 1) throw new Error(`repair routing could not park issue loop ${issueLoopId}`);
  }
}
