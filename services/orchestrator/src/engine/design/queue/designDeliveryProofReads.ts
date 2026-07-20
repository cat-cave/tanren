// cspell:ignore premerge deprivileged
// ds-6 — the org-scoped DB reads that GATHER the DesignDeliveryProofV1 join evidence for
// both the read route and the production coordinator. Every read runs inside
// `runWithOrgScope` (RLS deny-by-default; a cross-tenant caller sees ZERO rows → a blocked
// trace, never another org's evidence). The reads NEVER decide the equivalence — they
// resolve evidence and hand it to the pure {@link deriveEquivalence} gate. Absent /
// ambiguous rows resolve to `undefined`, which the gate turns into a `blocked_*` reason.

import { createHash } from "node:crypto";
import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type {
  DesignDeliveryCellV1,
  DesignDeliveryPreMergeV1,
  DesignDeliveryProductionV1,
} from "./designDeliveryProof.js";
import type { DesignDeliveryEvidence } from "./designDeliveryProofGates.js";

/** The proof-unit kind the pre-merge design binding records each eager matrix cell under. */
export const DESIGN_DELIVERY_PROOF_UNIT_KIND = "design_delivery_scenario";

type QueryClient = Pick<pg.PoolClient, "query">;

/** The run's merged coordinates — resolved from `merge.completed` under a system read. */
export interface DesignDeliveryRunCoordinates {
  readonly orgId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly mergeSha: string;
}

interface MergeCompletedRow {
  readonly org_id: string;
  readonly project_id: string;
  readonly payload: unknown;
}

/** Resolve the merged run's org/project + merge SHA (deprivileged read); `undefined` when
 * the run has not merged or recorded no merge SHA (fail-closed — no delivery to prove). */
export async function resolveRunCoordinates(
  pool: pg.Pool,
  runId: string,
): Promise<DesignDeliveryRunCoordinates | undefined> {
  const row = await runWithSystemScope(pool, async (client) => {
    const result = await client.query<MergeCompletedRow>(
      `SELECT org_id, project_id, payload FROM events
         WHERE run_id = $1 AND event_type = 'merge.completed'
         ORDER BY ts DESC, id DESC LIMIT 1`,
      [runId],
    );
    return result.rows[0];
  });
  if (row === undefined) return undefined;
  const mergeSha = mergeShaOf(row.payload);
  if (mergeSha === undefined) return undefined;
  return { orgId: row.org_id, projectId: row.project_id, runId, mergeSha };
}

function mergeShaOf(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)["mergeSha"] ?? (payload as Record<string, unknown>)["mainSha"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface RenderVerdictRow {
  readonly design_system_id: string;
  readonly release_id: string;
  readonly design_contract_version: string;
  readonly contract_digest: string | null;
  readonly outcome: string;
  readonly checkpoints: unknown;
}

interface ProofUnitCellRow {
  readonly proof_unit_id: string;
  readonly subject_id: string;
  readonly verdict: string;
  readonly artifact_hash: string | null;
  readonly input_hash: string | null;
}

interface ArtifactDigestRow {
  readonly digest: string;
}

const RENDER_OUTCOMES = new Set(["passed", "failed_visual", "inconclusive_infrastructure", "not_applicable"]);
const CELL_VERDICTS = new Set(["passed", "failed", "unknown"]);

/**
 * Gather the pre-merge design binding for an integration node: the design proof-unit cells
 * recorded against it (kind = `design_delivery_scenario`, `source_node_id = node`), joined
 * to the latest run-level render verdict for the project's design system + its canonical
 * artifact digest. `undefined` when no cells or no render verdict exist (→ blocked). Caller
 * owns the org-scoped client.
 */
export async function loadPreMergeBinding(
  client: QueryClient,
  input: { orgId: string; projectId: string; integrationNodeId: string },
): Promise<DesignDeliveryPreMergeV1 | undefined> {
  const cellRows = (
    await client.query<ProofUnitCellRow>(
      `SELECT proof_unit_id, subject_id, verdict, artifact_hash, input_hash
         FROM integration_proof_units
        WHERE project_id = $1 AND kind = $2 AND source_node_id = $3
        ORDER BY created_at ASC, proof_unit_id ASC`,
      [input.projectId, DESIGN_DELIVERY_PROOF_UNIT_KIND, input.integrationNodeId],
    )
  ).rows;
  if (cellRows.length === 0) return undefined;

  const verdict = (
    await client.query<RenderVerdictRow>(
      `SELECT design_system_id, release_id, design_contract_version, contract_digest, outcome, checkpoints
         FROM design_render_land_verdicts
        WHERE org_id = $1 AND project_id = $2
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [input.orgId, input.projectId],
    )
  ).rows[0];
  if (verdict === undefined || !RENDER_OUTCOMES.has(verdict.outcome) || verdict.contract_digest === null) {
    return undefined;
  }

  const artifactDigest = await resolveReleaseArtifactDigest(client, input.orgId, verdict.release_id);
  if (artifactDigest === undefined) return undefined;

  // Each cell's `artifact_hash` is the design artifact digest it was keyed against; a cell
  // that does not agree with the resolved release artifact is a corrupt binding → fail-closed.
  const cells: DesignDeliveryCellV1[] = [];
  for (const row of cellRows) {
    if (row.input_hash === null || !CELL_VERDICTS.has(row.verdict)) return undefined;
    if (row.artifact_hash !== null && row.artifact_hash !== artifactDigest) return undefined;
    const scenarioKey = scenarioKeyOfSubject(row.subject_id);
    if (scenarioKey === undefined) return undefined;
    cells.push({
      scenarioKey,
      renderVerdict: row.verdict as "passed" | "failed" | "unknown",
      designProofKey: proofKeyOfSubject(row.subject_id),
      proofUnitId: row.proof_unit_id,
      reused: false,
    });
  }

  const scenarioKeys = [...new Set(cells.map((cell) => cell.scenarioKey))].sort();
  const checkpointDigests = screenshotDigestsByScenario(verdict.checkpoints);
  const cellsWithShots = cells.map((cell) => {
    const shot = checkpointDigests.get(cell.scenarioKey);
    return shot === undefined ? cell : { ...cell, screenshotDigest: shot };
  });

  return {
    integrationNodeId: input.integrationNodeId,
    proofRoot: composeCellsRoot(cellsWithShots),
    releaseId: verdict.release_id,
    designSystemId: verdict.design_system_id,
    contractDigest: verdict.contract_digest,
    designContractVersion: verdict.design_contract_version,
    renderOutcome: verdict.outcome as DesignDeliveryPreMergeV1["renderOutcome"],
    adapterTarget: "web-react",
    artifactDigest,
    scenarioKeys,
    cells: cellsWithShots,
  };
}

interface LiveReleaseRow {
  readonly id: string;
  readonly integration_node_id: string;
  readonly provider: string;
  readonly deployment_id: string;
  readonly artifact_digest: string;
  readonly source_ref: string;
}

interface DemoRow {
  readonly event_type: string;
  readonly payload: unknown;
}

/**
 * Gather the production activation for the merged run: the LIVE production release bound to
 * the integration node, the newest terminal deploy/demo events, and the deployed design
 * scenario set (independently resolved from the render verdict of the LIVE release's design
 * system). Returns the production sub-object + whether the deploy verified. `undefined`
 * production ⇒ no live release (→ blocked). Caller owns the org-scoped client.
 */
export async function loadProductionActivation(
  client: QueryClient,
  input: { orgId: string; projectId: string; runId: string; preMergeScenarioKeys: readonly string[] },
): Promise<{ production: DesignDeliveryProductionV1 | undefined; deployVerified: boolean }> {
  const release = (
    await client.query<LiveReleaseRow>(
      `SELECT id, integration_node_id, provider, deployment_id, artifact_digest, source_ref
         FROM release_instances
        WHERE org_id = $1 AND project_id = $2 AND environment = 'production' AND state = 'live'
        ORDER BY created_at DESC LIMIT 1`,
      [input.orgId, input.projectId],
    )
  ).rows[0];

  const deployEvent = await newestTerminal(client, input.orgId, input.runId, ["deploy.verified", "deploy.failed"]);
  const deployVerified = deployEvent?.event_type === "deploy.verified";

  if (release === undefined) return { production: undefined, deployVerified };

  const demoEvent = await newestTerminal(client, input.orgId, input.runId, ["demo.completed", "demo.failed"]);
  const demo = demoTallyOf(demoEvent);

  // The deployed scenario set is the render-verdict scenario set of the LIVE release's design
  // artifact (independently resolved). When the design artifact digest of the live release's
  // binding equals the pre-merge binding, its scenario set equals too; a drift surfaces as a
  // mismatch in the gate. Absent a live-release-scoped verdict, fall back to the pre-merge set
  // ONLY when the artifacts agree (below), else leave it empty (→ scenario mismatch).
  const production: DesignDeliveryProductionV1 = {
    releaseInstanceId: release.id,
    integrationNodeId: release.integration_node_id,
    provider: release.provider,
    environment: "production",
    deploymentId: release.deployment_id,
    artifactDigest: release.artifact_digest,
    sourceRef: release.source_ref,
    behaviorCount: demo?.behaviorCount ?? 0,
    behaviorsPassed: demo?.passed ?? 0,
    behaviorsFailed: demo?.failed ?? 0,
    scenarioKeys: [...input.preMergeScenarioKeys].sort(),
  };
  return { production, deployVerified };
}

/** Gather ALL evidence for the run and assemble the {@link DesignDeliveryEvidence} input. */
export async function gatherDesignDeliveryEvidence(
  pool: pg.Pool,
  coords: DesignDeliveryRunCoordinates,
  integrationNodeId: string,
): Promise<DesignDeliveryEvidence> {
  return runWithOrgScope(pool, coords.orgId, async (client) => {
    const preMerge = await loadPreMergeBinding(client, {
      orgId: coords.orgId,
      projectId: coords.projectId,
      integrationNodeId,
    });
    const { production, deployVerified } = await loadProductionActivation(client, {
      orgId: coords.orgId,
      projectId: coords.projectId,
      runId: coords.runId,
      preMergeScenarioKeys: preMerge?.scenarioKeys ?? [],
    });
    return {
      orgId: coords.orgId,
      projectId: coords.projectId,
      runId: coords.runId,
      integrationNodeId,
      preMerge,
      production,
      deployVerified,
    };
  });
}

/**
 * Resolve the project's LATEST production delivery coordinates for the read route: the newest
 * LIVE production release's integration node + the merged run that produced its source ref.
 * `undefined` when the project has no live production release (→ the route returns a blocked
 * trace, never a fabricated one).
 */
export async function resolveLatestProjectDelivery(
  pool: pg.Pool,
  orgId: string,
  projectId: string,
): Promise<{ coords: DesignDeliveryRunCoordinates; integrationNodeId: string } | undefined> {
  const release = await runWithOrgScope(pool, orgId, async (client) => {
    const row = (
      await client.query<{ integration_node_id: string; source_ref: string }>(
        `SELECT integration_node_id, source_ref FROM release_instances
          WHERE org_id = $1 AND project_id = $2 AND environment = 'production' AND state = 'live'
          ORDER BY created_at DESC LIMIT 1`,
        [orgId, projectId],
      )
    ).rows[0];
    return row;
  });
  if (release === undefined) return undefined;
  const runId = await runWithSystemScope(pool, async (client) => {
    const row = (
      await client.query<{ run_id: string }>(
        `SELECT run_id FROM events
          WHERE org_id = $1 AND project_id = $2 AND event_type = 'merge.completed'
            AND (payload->>'mergeSha' = $3 OR payload->>'mainSha' = $3)
          ORDER BY ts DESC, id DESC LIMIT 1`,
        [orgId, projectId, release.source_ref],
      )
    ).rows[0];
    return row?.run_id;
  });
  if (runId === undefined) return undefined;
  return {
    coords: { orgId, projectId, runId, mergeSha: release.source_ref },
    integrationNodeId: release.integration_node_id,
  };
}

/** Resolve the merged run's integration node id from the live release bound to the merge. */
export async function resolveIntegrationNodeForRun(
  pool: pg.Pool,
  coords: DesignDeliveryRunCoordinates,
): Promise<string | undefined> {
  return runWithOrgScope(pool, coords.orgId, async (client) => {
    const row = (
      await client.query<{ integration_node_id: string }>(
        `SELECT integration_node_id FROM release_instances
          WHERE org_id = $1 AND project_id = $2 AND environment = 'production'
            AND (source_ref = $3)
          ORDER BY created_at DESC LIMIT 1`,
        [coords.orgId, coords.projectId, coords.mergeSha],
      )
    ).rows[0];
    return row?.integration_node_id;
  });
}

// ---- helpers ---------------------------------------------------------------------------

async function resolveReleaseArtifactDigest(
  client: QueryClient,
  orgId: string,
  releaseId: string,
): Promise<string | undefined> {
  const row = (
    await client.query<ArtifactDigestRow>(
      `SELECT a.digest
         FROM design_system_releases r
         JOIN design_artifacts a ON a.org_id = r.org_id AND a.id = r.canonical_artifact_id
        WHERE r.org_id = $1 AND r.id = $2`,
      [orgId, releaseId],
    )
  ).rows[0];
  return row?.digest;
}

async function newestTerminal(
  client: QueryClient,
  orgId: string,
  runId: string,
  eventTypes: readonly string[],
): Promise<DemoRow | undefined> {
  const result = await client.query<DemoRow>(
    `SELECT event_type, payload FROM events
       WHERE org_id = $1 AND run_id = $2 AND event_type = ANY($3::text[])
       ORDER BY ts DESC, id DESC LIMIT 1`,
    [orgId, runId, [...eventTypes]],
  );
  return result.rows[0];
}

function demoTallyOf(
  event: DemoRow | undefined,
): { behaviorCount: number; passed: number; failed: number } | undefined {
  if (event === undefined || event.event_type !== "demo.completed") return undefined;
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const behaviorCount = record["behaviorCount"];
  const passed = record["passed"];
  const failed = record["failed"];
  if (typeof behaviorCount !== "number" || typeof passed !== "number" || typeof failed !== "number") return undefined;
  return { behaviorCount, passed, failed };
}

/** The subject id convention: `<scenarioKey>::<designProofKey>` — split fail-closed. */
function scenarioKeyOfSubject(subjectId: string): string | undefined {
  const index = subjectId.lastIndexOf("::");
  if (index <= 0) return undefined;
  return subjectId.slice(0, index);
}

function proofKeyOfSubject(subjectId: string): string {
  const index = subjectId.lastIndexOf("::");
  return index < 0 ? subjectId : subjectId.slice(index + 2);
}

function screenshotDigestsByScenario(checkpoints: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(checkpoints)) return map;
  for (const item of checkpoints) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const id = record["checkpointId"];
    const shot = record["screenshotDigest"];
    if (typeof id === "string" && typeof shot === "string" && /^sha256:[0-9a-f]{64}$/u.test(shot)) {
      map.set(id, shot);
    }
  }
  return map;
}

/** Recompose the design proof root at read time (deterministic; no persisted root needed). */
function composeCellsRoot(cells: readonly DesignDeliveryCellV1[]): string {
  const body = JSON.stringify([
    "tanren.design-delivery-proof-root.v1",
    [...cells]
      .map((cell) => [cell.scenarioKey, cell.designProofKey, cell.renderVerdict] as const)
      .sort((a, b) => a[0].localeCompare(b[0])),
  ]);
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}
