// ds-4 sub-node #3 — the org-scoped persistence seam for the run-level design-render
// verdict. The producer writes ONE row per composed release; the land-time gate reads
// the latest row for the run's project. Every op runs inside `runWithOrgScope` so the
// deny-by-default RLS policy applies (a foreign org sees ZERO rows).

import { randomUUID } from "node:crypto";
import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type {
  DesignRenderCheckpoint,
  DesignRenderRunOutcome,
  DesignRenderVerification,
} from "./designRenderVerdict.js";

type QueryClient = Pick<pg.PoolClient, "query">;

const RUN_OUTCOMES: ReadonlySet<DesignRenderRunOutcome> = new Set<DesignRenderRunOutcome>([
  "passed",
  "failed_visual",
  "inconclusive_infrastructure",
  "not_applicable",
]);

/** The persisted verdict row shape the gate reader evaluates (decoded fail-closed). */
export interface DesignRenderVerdictRow {
  readonly outcome: DesignRenderRunOutcome;
  readonly accessibilityStandard: string;
  readonly designContractVersion: string;
  /** The published release this verdict was recorded for (compose-time reuse-guard key). */
  readonly releaseId: string;
  /** The contract V2 digest this verdict was rendered against; `null` on a legacy row whose
   * provenance predates the column (treated as a mismatch → re-verify, fail-closed). */
  readonly contractDigest: string | null;
  readonly failingScenarioKey: string | null;
  readonly failingRuleIds: readonly string[];
  readonly checkpointCount: number;
  readonly checkpoints: readonly DesignRenderCheckpoint[];
}

export interface RecordDesignRenderVerdictInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly designSystemId: string;
  readonly releaseId: string;
  readonly designContractVersion: string;
  /** The contract V2 digest the verification ran against (provenance for the reuse guard). */
  readonly contractDigest: string;
  readonly verification: DesignRenderVerification;
}

/** Persist one run-level design-render verdict (org-scoped). Returns the row id. */
export async function recordDesignRenderVerdict(pool: pg.Pool, input: RecordDesignRenderVerdictInput): Promise<string> {
  const { verification } = input;
  const id = `design_render_verdict_${randomUUID()}`;
  await runWithOrgScope(pool, input.orgId, (client) =>
    client.query(
      `INSERT INTO design_render_land_verdicts
         (org_id, project_id, id, design_system_id, release_id, design_contract_version,
          contract_digest, accessibility_standard, outcome, checkpoint_count, passed_count,
          failed_count, inconclusive_count, excluded_count, failing_scenario_key,
          failing_rule_ids, checkpoints)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb)`,
      [
        input.orgId,
        input.projectId,
        id,
        input.designSystemId,
        input.releaseId,
        input.designContractVersion,
        input.contractDigest,
        verification.accessibilityStandard,
        verification.outcome,
        verification.checkpoints.length,
        verification.passedCount,
        verification.failedCount,
        verification.inconclusiveCount,
        verification.excludedCount,
        verification.failingScenarioKey,
        JSON.stringify([...verification.failingRuleIds]),
        JSON.stringify(
          verification.checkpoints.map((checkpoint) => ({
            checkpointId: checkpoint.checkpointId,
            verdict: checkpoint.verdict,
            failingRuleIds: [...checkpoint.failingRuleIds],
          })),
        ),
      ],
    ),
  );
  return id;
}

interface RawDesignRenderVerdictRow {
  outcome: string;
  accessibility_standard: string;
  design_contract_version: string;
  release_id: string;
  contract_digest: string | null;
  failing_scenario_key: string | null;
  failing_rule_ids: unknown;
  checkpoint_count: number;
  checkpoints: unknown;
}

/**
 * Read the LATEST design-render verdict for a project (newest first), or `undefined`
 * when the project never composed a verified design system. The caller owns the
 * RLS-scoped client (so this composes into the gate's org-scoped read).
 */
export async function readLatestDesignRenderVerdict(
  client: QueryClient,
  orgId: string,
  projectId: string,
): Promise<DesignRenderVerdictRow | undefined> {
  const row = (
    await client.query<RawDesignRenderVerdictRow>(
      `SELECT outcome, accessibility_standard, design_contract_version, release_id, contract_digest,
              failing_scenario_key, failing_rule_ids, checkpoint_count, checkpoints
         FROM design_render_land_verdicts
        WHERE org_id = $1 AND project_id = $2
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [orgId, projectId],
    )
  ).rows[0];
  return row === undefined ? undefined : decodeRow(row);
}

function decodeRow(row: RawDesignRenderVerdictRow): DesignRenderVerdictRow {
  if (!RUN_OUTCOMES.has(row.outcome as DesignRenderRunOutcome)) {
    throw new TypeError(`design_render_land_verdicts row has an unknown outcome: ${row.outcome}`);
  }
  return {
    outcome: row.outcome as DesignRenderRunOutcome,
    accessibilityStandard: row.accessibility_standard,
    designContractVersion: row.design_contract_version,
    releaseId: row.release_id,
    contractDigest: row.contract_digest,
    failingScenarioKey: row.failing_scenario_key,
    failingRuleIds: decodeStringArray(row.failing_rule_ids),
    checkpointCount: row.checkpoint_count,
    checkpoints: decodeCheckpoints(row.checkpoints),
  };
}

function decodeStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function decodeCheckpoints(value: unknown): readonly DesignRenderCheckpoint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): DesignRenderCheckpoint[] => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    const checkpointId = record["checkpointId"];
    const verdict = record["verdict"];
    if (typeof checkpointId !== "string") return [];
    if (verdict !== "passed" && verdict !== "failed" && verdict !== "unknown") return [];
    return [{ checkpointId, verdict, failingRuleIds: decodeStringArray(record["failingRuleIds"]) }];
  });
}
