import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { ProofSubstrate, ProofUnitDraft } from "../contracts/cas.js";
import { contentDigestOf, parseDigest } from "../contracts/cas.js";
import type {
  GateSectionVerdict,
  NativeCiBody,
  RuntimeBehaviorBinding,
  RuntimeBehaviorBody,
} from "../contracts/gateProof.js";
import { NativeCiBodySchema, RuntimeBehaviorBodySchema } from "../contracts/gateProof.js";
import type { BehaviorVerdictOutcome, FlakeState } from "../contracts/runtimeVerificationAdapters.js";
import { mapVerdictOutcomeToProofVerdict } from "../contracts/runtimeVerificationAdapters.js";
import { designRenderGateSection, designRenderProofBody } from "../design/render/designRenderGateProof.js";
import { readLatestDesignRenderVerdict } from "../design/render/designRenderVerdictStore.js";
import { migrateProjectConfig } from "../config/projectConfig.js";
import { evaluateBehaviorLandGate, type BehaviorRunStatus, type BehaviorVerdictRow } from "./behaviorLandGate.js";
import { resolveDesignRenderGate } from "./designRenderLandGate.js";
import type {
  GateProofBundleInput,
  GateProofRequirements,
  NativeCiGateObservation,
  RequiredGateSection,
} from "./gateProofBundleTypes.js";

type QueryClient = Pick<pg.PoolClient, "query">;

export interface GateSectionDraft extends RequiredGateSection {
  readonly draft: ProofUnitDraft;
  readonly verdict: GateSectionVerdict["verdict"];
  readonly runtimeBehaviorBinding?: RuntimeBehaviorBinding;
}

/** Resolve only actual member requirements; no absent behavior/design proof is assumed green. */
export async function loadGateProofRequirements(
  pool: pg.Pool,
  input: Pick<GateProofBundleInput, "orgId" | "projectId" | "members">,
): Promise<GateProofRequirements> {
  const runtimeBehaviorRunIds = await runWithOrgScope(pool, input.orgId, async (client) => {
    const config = await loadProjectConfig(client, input.orgId, input.projectId);
    if (!config.preMergeBehaviorGate) return [];
    const specIds = input.members.map((member) => member.specId);
    if (specIds.length === 0) return [];
    const rows = await client.query<{ spec_id: string }>(
      `SELECT DISTINCT sb.spec_id
         FROM spec_behaviors sb
         JOIN specs s ON s.spec_id = sb.spec_id
        WHERE s.org_id = $1 AND s.project_id = $2 AND sb.spec_id = ANY($3::text[])`,
      [input.orgId, input.projectId, specIds],
    );
    const requiringSpecs = new Set(rows.rows.map((row) => row.spec_id));
    return input.members.flatMap((member) => (requiringSpecs.has(member.specId) ? [member.runId] : []));
  });
  const designRequired = (
    await Promise.all(input.members.map((member) => resolveDesignRenderGate(pool, input.orgId, member.runId)))
  ).some((gate) => gate.kind !== "not_applicable");
  return {
    plan: {
      required: {
        native_ci: true,
        runtime_behavior: runtimeBehaviorRunIds.length > 0,
        design_render: designRequired,
        artifact_provenance: false,
      },
    },
    runtimeBehaviorRunIds,
  };
}

/** The exact required unit subjects are used again by the land-time verifier. */
export function requiredGateSections(
  input: Pick<GateProofBundleInput, "nodeId" | "projectId">,
  requirements: GateProofRequirements,
): readonly RequiredGateSection[] {
  return [
    { kind: "native_ci", subjectId: nativeSubject(input.nodeId) },
    ...requirements.runtimeBehaviorRunIds.map((runId) => ({
      kind: "runtime_behavior" as const,
      subjectId: runtimeSubject(runId),
    })),
    ...(requirements.plan.required.design_render
      ? [{ kind: "design_render" as const, subjectId: designSubject(input.projectId) }]
      : []),
  ];
}

/** Build section drafts only from persisted/observed evidence; incomplete requirements remain absent. */
export async function loadGateSectionDrafts(
  pool: pg.Pool,
  proofSubstrate: ProofSubstrate,
  input: GateProofBundleInput,
  requirements: GateProofRequirements,
): Promise<readonly GateSectionDraft[]> {
  const native = nativeCiDraft(input.nativeCi, input.headSha, input.nodeId);
  const runtime = await Promise.all(
    requirements.runtimeBehaviorRunIds.map((runId) => runtimeBehaviorDraft(pool, proofSubstrate, input, runId)),
  );
  const design = requirements.plan.required.design_render ? await designRenderDraft(pool, input) : null;
  return [
    native,
    ...runtime.flatMap((section) => (section === null ? [] : [section])),
    ...(design === null ? [] : [design]),
  ];
}

function nativeCiDraft(observation: NativeCiGateObservation, headSha: string, nodeId: string): GateSectionDraft {
  const body: NativeCiBody = NativeCiBodySchema.parse({
    gateConfigHash: observation.gateConfigHash,
    when: "pre_merge",
    headSha,
    tiers: [...observation.tiers],
    steps: observation.steps.map((step) => ({ ...step })),
    junit: observation.junit,
  });
  const verdict = observation.steps.length === 0 ? "unknown" : observation.verdict;
  return {
    kind: "native_ci",
    subjectId: nativeSubject(nodeId),
    verdict,
    draft: { kind: "native_ci_tier", verdict, subjectId: nativeSubject(nodeId), body },
  };
}

async function runtimeBehaviorDraft(
  pool: pg.Pool,
  proofSubstrate: ProofSubstrate,
  input: GateProofBundleInput,
  memberRunId: string,
): Promise<GateSectionDraft | null> {
  return runWithOrgScope(pool, input.orgId, async (client) => {
    const member = input.members.find((candidate) => candidate.runId === memberRunId);
    if (member === undefined) throw new Error(`required behavior run ${memberRunId} is not an integration member`);
    const run = await latestBehaviorRun(client, input.orgId, memberRunId);
    if (run === undefined || run.prepared_head_sha !== member.headSha) return null;
    const status = behaviorRunStatus(run.status);
    const verdicts = await behaviorVerdicts(client, input.orgId, run.id);
    const gate = evaluateBehaviorLandGate(status, verdicts);
    const body = runtimeBehaviorBody(proofSubstrate, run.runtime_behavior_context_hash, verdicts);
    const verdict = gate.kind === "passed" ? "passed" : gate.kind === "failed" ? "failed" : "unknown";
    return {
      kind: "runtime_behavior",
      subjectId: runtimeSubject(memberRunId),
      verdict,
      draft: { kind: "runtime_behavior", verdict, subjectId: runtimeSubject(memberRunId), body },
      runtimeBehaviorBinding: {
        planSetHash: parseDigest(body.runtimeBehaviorContextHash),
        requiredBehaviorRevisionCount: body.requiredBehaviorRevisionCount,
      },
    };
  });
}

async function designRenderDraft(pool: pg.Pool, input: GateProofBundleInput): Promise<GateSectionDraft | null> {
  return runWithOrgScope(pool, input.orgId, async (client) => {
    const verdict = await readLatestDesignRenderVerdict(client, input.orgId, input.projectId);
    if (verdict === undefined) return null;
    const section = designRenderGateSection(verdict, true);
    return {
      kind: section.kind,
      subjectId: designSubject(input.projectId),
      verdict: section.verdict,
      draft: {
        kind: "design_render",
        verdict: section.verdict,
        subjectId: designSubject(input.projectId),
        body: designRenderProofBody(verdict),
      },
    };
  });
}

async function loadProjectConfig(client: QueryClient, orgId: string, projectId: string) {
  const row = (
    await client.query<{ config: unknown }>(`SELECT config FROM projects WHERE org_id = $1 AND project_id = $2`, [
      orgId,
      projectId,
    ])
  ).rows[0];
  if (row === undefined) throw new Error(`gate proof requirements cannot resolve project ${projectId} in org ${orgId}`);
  return migrateProjectConfig(row.config);
}

async function latestBehaviorRun(client: QueryClient, orgId: string, memberRunId: string) {
  return (
    await client.query<{
      id: string;
      status: string;
      prepared_head_sha: string;
      runtime_behavior_context_hash: string;
    }>(
      `SELECT id, status, prepared_head_sha, runtime_behavior_context_hash
         FROM behavior_verification_runs
        WHERE org_id = $1 AND run_id = $2 AND purpose = 'pre_merge'
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [orgId, memberRunId],
    )
  ).rows[0];
}

interface PersistedBehaviorVerdict extends BehaviorVerdictRow {
  readonly executedAssertionCount: number;
}

async function behaviorVerdicts(
  client: QueryClient,
  orgId: string,
  verificationRunId: string,
): Promise<PersistedBehaviorVerdict[]> {
  const rows = await client.query<{
    behavior_revision_id: string;
    outcome: string;
    flake_state: string;
    gate_effect: string;
    executed_assertion_count: number;
    count_inconsistent: boolean;
  }>(
    `SELECT v.behavior_revision_id, v.outcome, v.flake_state, v.gate_effect, v.executed_assertion_count,
            (v.required_assertion_count <> (SELECT COUNT(*)::int FROM behavior_verdict_assertions a WHERE a.org_id = v.org_id AND a.verdict_id = v.id)
             OR v.executed_assertion_count <> (SELECT COUNT(*) FILTER (WHERE a.executed)::int FROM behavior_verdict_assertions a WHERE a.org_id = v.org_id AND a.verdict_id = v.id)
             OR v.attempt_count <> (SELECT COUNT(*)::int FROM behavior_verdict_attempts a WHERE a.org_id = v.org_id AND a.verdict_id = v.id)) AS count_inconsistent
       FROM behavior_verdicts v
      WHERE v.org_id = $1 AND v.run_id = $2
      ORDER BY v.behavior_revision_id ASC, v.id ASC`,
    [orgId, verificationRunId],
  );
  return rows.rows.map((row) => ({
    behaviorRevisionId: requiredText(row.behavior_revision_id, "behavior_revision_id"),
    outcome: behaviorOutcome(row.outcome),
    flakeState: flakeState(row.flake_state),
    gateEffect: gateEffect(row.gate_effect),
    countInconsistent: typeof row.count_inconsistent === "boolean" ? row.count_inconsistent : true,
    executedAssertionCount: nonnegativeInt(row.executed_assertion_count, "executed_assertion_count"),
  }));
}

function runtimeBehaviorBody(
  proofSubstrate: ProofSubstrate,
  rawContextHash: string,
  verdicts: readonly PersistedBehaviorVerdict[],
): RuntimeBehaviorBody {
  const runtimeBehaviorContextHash = parseDigest(requiredText(rawContextHash, "runtime_behavior_context_hash"));
  const leaves = verdicts.map((verdict) => ({
    digest: contentDigestOf(
      new TextEncoder().encode(
        JSON.stringify([
          verdict.behaviorRevisionId,
          verdict.outcome,
          verdict.executedAssertionCount,
          verdict.flakeState,
        ]),
      ),
    ),
    kind: "runtime_behavior" as const,
    verdict: mapVerdictOutcomeToProofVerdict(verdict.outcome),
  }));
  const verdictMerkleRoot = proofSubstrate.computeRoot(leaves);
  return RuntimeBehaviorBodySchema.parse({
    runtimeBehaviorContextHash,
    requiredBehaviorRevisionCount: verdicts.filter(
      (verdict) => verdict.gateEffect === "blocking" && verdict.flakeState !== "quarantined_fragment",
    ).length,
    verdictMerkleRoot,
    executedAssertionTotal: verdicts.reduce((total, verdict) => total + verdict.executedAssertionCount, 0),
    behaviorVerdicts: verdicts.map((verdict) => ({
      behaviorRevisionId: verdict.behaviorRevisionId,
      verdict: mapVerdictOutcomeToProofVerdict(verdict.outcome),
      executedAssertionCount: verdict.executedAssertionCount,
    })),
  });
}

function behaviorRunStatus(value: string): BehaviorRunStatus {
  if (
    value === "planned" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  )
    return value;
  throw new TypeError(`behavior verification run has unknown status '${value}'`);
}

function behaviorOutcome(value: string): BehaviorVerdictOutcome {
  if (
    value === "passed" ||
    value === "failed_product" ||
    value === "failed_verification_contract" ||
    value === "failed_visual" ||
    value === "inconclusive_infrastructure" ||
    value === "inconclusive_external" ||
    value === "cancelled_superseded"
  ) {
    return value;
  }
  throw new TypeError(`behavior verdict has unknown outcome '${value}'`);
}

function flakeState(value: string): FlakeState {
  if (value === "stable" || value === "suspected" || value === "confirmed" || value === "quarantined_fragment")
    return value;
  throw new TypeError(`behavior verdict has unknown flake state '${value}'`);
}

function gateEffect(value: string): "blocking" | "advisory" {
  if (value === "blocking" || value === "advisory") return value;
  throw new TypeError(`behavior verdict has unknown gate effect '${value}'`);
}

function requiredText(value: string, field: string): string {
  if (value.trim() === "") throw new TypeError(`${field} must be a non-blank string`);
  return value;
}

function nonnegativeInt(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${field} must be a nonnegative integer`);
  return value;
}

export function nativeSubject(nodeId: string): string {
  return `native_ci:${nodeId}`;
}

export function runtimeSubject(runId: string): string {
  return `runtime_behavior:${runId}`;
}

export function designSubject(projectId: string): string {
  return `design_render:${projectId}`;
}
