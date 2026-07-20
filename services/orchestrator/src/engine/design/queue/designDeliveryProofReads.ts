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

// The proof-unit `kind`s the design binding records cells under — DISTINCT per phase so the
// pre-merge load (below) reads ONLY pre-merge cells in SQL and the production-phase re-insert
// can never contaminate the pre-merge matrix (Finding 5). The phase is separated at the
// column level, not merely inside the derived `subject_id`.
export const DESIGN_DELIVERY_PRE_MERGE_KIND = "design_delivery_scenario";
export const DESIGN_DELIVERY_PRODUCTION_KIND = "design_delivery_production";

/** The proof-unit verdict → cell render-verdict mapping. The `integration_proof_units.verdict`
 * column vocabulary is `pass|fail|skipped`; the cell render vocabulary is `passed|failed|unknown`.
 * Recorder and loader MUST agree — this is the single translation point (Finding 1). */
function cellVerdictFromProofUnit(verdict: string): "passed" | "failed" | "unknown" | undefined {
  if (verdict === "pass") return "passed";
  if (verdict === "fail") return "failed";
  if (verdict === "skipped") return "unknown";
  return undefined;
}

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

/** The snapshot design-release metadata matched to the pre-merge cells by artifact digest. */
interface SnapshotVerdictRow {
  readonly design_system_id: string;
  readonly release_id: string;
  readonly design_contract_version: string;
  readonly contract_digest: string | null;
  readonly checkpoints: unknown;
}

/**
 * Gather the pre-merge design binding for an integration node — the immutable SNAPSHOT the
 * eager matrix recorded: the design proof-unit cells (kind = pre-merge, `source_node_id =
 * node`) whose per-cell verdict is the SNAPSHOT render result, the design artifact digest they
 * were keyed against (`artifact_hash`), and the metadata of the render verdict matched to THAT
 * exact artifact (so the binding reflects the design release the cells were bound to, not
 * whatever is latest). `undefined` when no cells, a divergent/absent cell artifact, an
 * unmatched verdict, or a malformed cell exists (→ blocked). Caller owns the org-scoped client.
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
      [input.projectId, DESIGN_DELIVERY_PRE_MERGE_KIND, input.integrationNodeId],
    )
  ).rows;
  if (cellRows.length === 0) return undefined;

  // The SNAPSHOT design artifact digest = the common `artifact_hash` of the recorded cells.
  // A null or divergent artifact across cells is a corrupt binding → fail-closed.
  const artifactDigest = cellRows[0]?.artifact_hash ?? undefined;
  if (artifactDigest === undefined) return undefined;

  const cells: DesignDeliveryCellV1[] = [];
  for (const row of cellRows) {
    if (row.input_hash === null || row.artifact_hash !== artifactDigest) return undefined;
    const renderVerdict = cellVerdictFromProofUnit(row.verdict);
    if (renderVerdict === undefined) return undefined;
    const scenarioKey = scenarioKeyOfSubject(row.subject_id);
    if (scenarioKey === undefined) return undefined;
    cells.push({
      scenarioKey,
      renderVerdict,
      designProofKey: proofKeyOfSubject(row.subject_id),
      proofUnitId: row.proof_unit_id,
      reused: false,
    });
  }

  // Match the render verdict to the SNAPSHOT artifact (the design release whose canonical
  // artifact digest the cells recorded) — the honest metadata source, not "latest".
  const snapshot = await resolveVerdictByArtifactDigest(client, input.orgId, input.projectId, artifactDigest);
  if (snapshot === undefined || snapshot.contract_digest === null) return undefined;

  const fragmentDigests = await resolveFragmentDigests(client, input.orgId, snapshot.design_system_id);
  const scenarioKeys = [...new Set(cells.map((cell) => cell.scenarioKey))].sort();
  const checkpointDigests = screenshotDigestsByScenario(snapshot.checkpoints);
  const cellsWithShots = cells.map((cell) => {
    const shot = checkpointDigests.get(cell.scenarioKey);
    return shot === undefined ? cell : { ...cell, screenshotDigest: shot };
  });
  // The render outcome is DERIVED from the recorded cells (the authoritative snapshot), not a
  // possibly-newer verdict row: every cell passed ⇒ the matrix passed.
  const renderOutcome = cellsWithShots.every((cell) => cell.renderVerdict === "passed") ? "passed" : "failed_visual";

  return {
    integrationNodeId: input.integrationNodeId,
    proofRoot: composeCellsRoot(cellsWithShots),
    releaseId: snapshot.release_id,
    designSystemId: snapshot.design_system_id,
    contractDigest: snapshot.contract_digest,
    designContractVersion: snapshot.design_contract_version,
    renderOutcome,
    adapterTarget: "web-react",
    artifactDigest,
    fragmentDigests,
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
 * the integration node, the newest terminal deploy/demo events, and — INDEPENDENTLY resolved
 * (never copied from pre-merge) — the DEPLOYED design state: the current design render
 * verdict's design-artifact digest + scenario set (the live design the deployed release
 * serves). The scenario/artifact are therefore real equality inputs the gate can catch a
 * divergence on. `undefined` production ⇒ no live release (→ blocked). Caller owns the client.
 */
export async function loadProductionActivation(
  client: QueryClient,
  input: { orgId: string; projectId: string; runId: string },
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

  // INDEPENDENTLY resolve the deployed design state — the current design render verdict's
  // design-artifact digest + scenario set (same content domain as the pre-merge binding). A
  // recompose that changed the design artifact or the scenario matrix after the pre-merge
  // snapshot surfaces as a real artifact/scenario mismatch in the gate (never tautological).
  const design = await resolveCurrentDesignState(client, input.orgId, input.projectId);
  if (design === undefined) return { production: undefined, deployVerified };

  const production: DesignDeliveryProductionV1 = {
    releaseInstanceId: release.id,
    integrationNodeId: release.integration_node_id,
    provider: release.provider,
    environment: "production",
    deploymentId: release.deployment_id,
    // The deployed DESIGN artifact digest (equality anchor) — NOT the product deploy blob.
    artifactDigest: design.artifactDigest,
    // The product deploy blob digest (trace only; different domain, never compared).
    deployedProductDigest: release.artifact_digest,
    sourceRef: release.source_ref,
    behaviorCount: demo?.behaviorCount ?? 0,
    behaviorsPassed: demo?.passed ?? 0,
    behaviorsFailed: demo?.failed ?? 0,
    scenarioKeys: design.scenarioKeys,
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

/** Match the render verdict whose design release's CANONICAL artifact digest equals the given
 * (snapshot) digest — the honest metadata source for the pre-merge binding (not "latest"). */
async function resolveVerdictByArtifactDigest(
  client: QueryClient,
  orgId: string,
  projectId: string,
  artifactDigest: string,
): Promise<SnapshotVerdictRow | undefined> {
  return (
    await client.query<SnapshotVerdictRow>(
      `SELECT v.design_system_id, v.release_id, v.design_contract_version, v.contract_digest, v.checkpoints
         FROM design_render_land_verdicts v
         JOIN design_system_releases r ON r.org_id = v.org_id AND r.id = v.release_id
         JOIN design_artifacts a ON a.org_id = r.org_id AND a.id = r.canonical_artifact_id
        WHERE v.org_id = $1 AND v.project_id = $2 AND a.digest = $3
        ORDER BY v.created_at DESC, v.id DESC LIMIT 1`,
      [orgId, projectId, artifactDigest],
    )
  ).rows[0];
}

/** The current (deployed) design state: the LATEST render verdict's design-artifact digest +
 * scenario set — the production-side design evidence, resolved INDEPENDENTLY of pre-merge. */
async function resolveCurrentDesignState(
  client: QueryClient,
  orgId: string,
  projectId: string,
): Promise<{ artifactDigest: string; scenarioKeys: string[] } | undefined> {
  const row = (
    await client.query<{ digest: string; checkpoints: unknown }>(
      `SELECT a.digest, v.checkpoints
         FROM design_render_land_verdicts v
         JOIN design_system_releases r ON r.org_id = v.org_id AND r.id = v.release_id
         JOIN design_artifacts a ON a.org_id = r.org_id AND a.id = r.canonical_artifact_id
        WHERE v.org_id = $1 AND v.project_id = $2
        ORDER BY v.created_at DESC, v.id DESC LIMIT 1`,
      [orgId, projectId],
    )
  ).rows[0];
  if (row === undefined) return undefined;
  return { artifactDigest: row.digest, scenarioKeys: scenarioKeysOfCheckpoints(row.checkpoints) };
}

/** The sorted validated fragment-digest SET for a design system — the real sixth key input. */
async function resolveFragmentDigests(client: QueryClient, orgId: string, designSystemId: string): Promise<string[]> {
  const rows = (
    await client.query<ArtifactDigestRow>(
      `SELECT digest FROM design_fragments
        WHERE org_id = $1 AND design_system_id = $2 AND status = 'validated'
        ORDER BY digest ASC`,
      [orgId, designSystemId],
    )
  ).rows;
  return rows.map((row) => row.digest).filter((digest) => /^sha256:[0-9a-f]{64}$/u.test(digest));
}

/** Extract the sorted, de-duplicated scenario keys from a render verdict's checkpoints. */
function scenarioKeysOfCheckpoints(checkpoints: unknown): string[] {
  if (!Array.isArray(checkpoints)) return [];
  const keys = new Set<string>();
  for (const item of checkpoints) {
    if (typeof item !== "object" || item === null) continue;
    const id = (item as Record<string, unknown>)["checkpointId"];
    if (typeof id === "string" && id.length > 0) keys.add(id);
  }
  return [...keys].sort();
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
