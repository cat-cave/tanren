// cspell:ignore premerge
// ds-6 — the DesignAwareDeliveryCoordinator: the SINGLE coordinator invoked at the TWO
// existing lifecycle seams to make an accepted design system compound through the queue
// and the live proof-backed demo.
//
//   • pre_merge  — invoked from the batch-drive path (PgBatchChecker, right after a passing
//     `driveBatchThroughNode`). It resolves the composed design system's render verdict +
//     eager scenario matrix, derives the FROZEN six-input `deriveDesignProofKey` per cell,
//     and records each cell as an immutable integration proof-unit bound to the integration
//     node. It REUSES the graph's repository + `deriveDesignProofKey` — it does NOT call
//     `IntegrationProofUnitGraph.evaluate` (which would re-stamp the node's proof root and
//     clobber the mq-6 gate binding). Exact-key reuse emits the frozen `designSystem.proof.reused`.
//
//   • production — a `RunMergeWatcher` driven AFTER the in-17 delivery DAG driver in
//     `PostMergeSubscriber.runChain` (the mq-15 merge-train watcher's seam). It GATHERS the
//     already-authoritative evidence (the pre-merge binding, the LIVE production release
//     bound to the SAME node, the terminal `deploy.verified` + full-pass `demo.completed`),
//     derives the fail-closed equivalence, and — ONLY when the live artifact + scenario set
//     EQUAL the pre-merge binding — records the production-environment design proof-units
//     that link A4 ≡ demo. A blocked/mismatched/partial join records NOTHING and stays silent.
//
// This coordinator EXTENDS the existing verifiers/graph/demo; it never forks them. It writes
// NO new table — the canonical evidence remains in `integration_proof_units`,
// `design_render_land_verdicts`, `release_instances`, and the terminal deploy/demo events.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { createLogger } from "../../observability/logger.js";
import type { EventStore } from "../../eventStore.js";
import type { RunMergeWatcher } from "../../postMerge/subscriber.js";
import { deriveDesignProofKey, DesignProofKeyInputError, type DesignProofKeyInput } from "../system/designProofKey.js";
import {
  PgIntegrationProofUnitRepository,
  proofUnitReuseInputHash,
  type IntegrationProofUnitRepository,
  type ProofUnitVerdict,
} from "../../repositories/integrationProofUnits.js";
import { readLatestDesignRenderVerdict } from "../render/designRenderVerdictStore.js";
import { DESIGN_DELIVERY_PROOF_UNIT_KIND } from "./designDeliveryProofReads.js";
import {
  gatherDesignDeliveryEvidence,
  resolveIntegrationNodeForRun,
  resolveRunCoordinates,
} from "./designDeliveryProofReads.js";
import { buildDesignDeliveryProof } from "./designDeliveryProofGates.js";

const log = createLogger("design-delivery");

/** The adapter/target every web design system projects onto (the sole live adapter). */
const WEB_ADAPTER_TARGET = "web-react";

type QueryClient = Pick<pg.PoolClient, "query">;

export interface DesignAwareDeliveryCoordinatorDeps {
  readonly pool: pg.Pool;
  readonly eventStore: EventStore;
  readonly proofUnits: IntegrationProofUnitRepository;
}

/** The pre-merge invocation: bind the eager design matrix to a just-integrated node. */
export interface PreMergeRunInput {
  readonly phase: "pre_merge";
  readonly orgId: string;
  readonly projectId: string;
  readonly integrationNodeId: string;
  readonly runId: string;
}

/** The production invocation: link the live delivery to the pre-merge matrix for a run. */
export interface ProductionRunInput {
  readonly phase: "production";
  readonly runId: string;
}

export type DesignAwareDeliveryRunInput = PreMergeRunInput | ProductionRunInput;

/** The minimal render-verdict facts a cell recording needs (a subset of the verdict row). */
interface DesignBinding {
  readonly releaseId: string;
  readonly designSystemId: string;
  readonly contractDigest: string;
  readonly designContractVersion: string;
  readonly artifactDigest: string;
  readonly fragmentDigests: readonly string[];
  readonly cells: ReadonlyArray<{ readonly scenarioKey: string; readonly passed: boolean }>;
}

/**
 * The coordinator. Implements {@link RunMergeWatcher} so the post-merge subscriber drives its
 * production phase on the same wake it drove the delivery DAG + merge-train watcher.
 */
export class DesignAwareDeliveryCoordinator implements RunMergeWatcher {
  constructor(private readonly deps: DesignAwareDeliveryCoordinatorDeps) {}

  /** The `RunMergeWatcher` entry — the production phase. */
  async check(runId: string): Promise<void> {
    await this.run({ phase: "production", runId });
  }

  async run(input: DesignAwareDeliveryRunInput): Promise<void> {
    if (input.phase === "pre_merge") {
      await this.runPreMerge(input);
      return;
    }
    await this.runProduction(input);
  }

  /**
   * PRE-MERGE: resolve the composed design system binding and record the frozen six-input
   * proof key per eager cell as an immutable design proof-unit bound to the integration node.
   * Fail-closed: no render verdict, an unresolvable artifact/fragment digest, or a malformed
   * key records NOTHING (the native gate stays the sole merge authority — this never gates).
   */
  private async runPreMerge(input: PreMergeRunInput): Promise<void> {
    try {
      const binding = await runWithOrgScope(this.deps.pool, input.orgId, (client) =>
        resolveDesignBinding(client, input.orgId, input.projectId),
      );
      if (binding === undefined) return;
      await this.recordDesignCells({
        orgId: input.orgId,
        projectId: input.projectId,
        integrationNodeId: input.integrationNodeId,
        runId: input.runId,
        environment: "pre_merge",
        binding,
        releaseIdForReuseEvent: binding.releaseId,
      });
    } catch (error) {
      // The design binding is ADVISORY to merge authority; an unobservable state must never
      // block a merge. Log LOUD and leave no binding (the join stays blocked downstream).
      log.error(
        "pre_merge design binding failed",
        { projectId: input.projectId, nodeId: input.integrationNodeId },
        error,
      );
    }
  }

  /**
   * PRODUCTION: gather the join evidence, derive the fail-closed equivalence, and — only when
   * `equivalent` — record the production-environment design proof-units that link A4 ≡ demo.
   * A blocked/mismatched/partial/absent join records NOTHING (the trace stays blocked, never
   * A4 ≡ demo). Isolated: a failure is logged, never thrown.
   */
  private async runProduction(input: ProductionRunInput): Promise<void> {
    try {
      const coords = await resolveRunCoordinates(this.deps.pool, input.runId);
      if (coords === undefined) return;
      const integrationNodeId = await resolveIntegrationNodeForRun(this.deps.pool, coords);
      if (integrationNodeId === undefined) return;

      const evidence = await gatherDesignDeliveryEvidence(this.deps.pool, coords, integrationNodeId);
      const proof = buildDesignDeliveryProof(evidence);
      if (proof.equivalence !== "equivalent" || proof.production === null) {
        // Fail-closed: the deployed artifact/scenario does NOT match, or the demo did not pass.
        return;
      }

      const binding = await runWithOrgScope(this.deps.pool, coords.orgId, (client) =>
        resolveDesignBinding(client, coords.orgId, coords.projectId),
      );
      if (binding === undefined) return;
      await this.recordDesignCells({
        orgId: coords.orgId,
        projectId: coords.projectId,
        integrationNodeId,
        runId: coords.runId,
        environment: "production",
        binding,
        releaseIdForReuseEvent: proof.production.releaseInstanceId,
      });
    } catch (error) {
      log.error("production design delivery link failed", { runId: input.runId }, error);
    }
  }

  /**
   * Record one design proof-unit per eager scenario cell, keyed by the frozen
   * `deriveDesignProofKey`. Exact-key reuse (a prior unit with the identical six-field key)
   * is honored via `findReusable` and emits the frozen `designSystem.proof.reused`; otherwise
   * a fresh immutable unit is recorded. NEVER re-stamps the integration node's proof root.
   */
  private async recordDesignCells(input: {
    orgId: string;
    projectId: string;
    integrationNodeId: string;
    runId: string;
    environment: "pre_merge" | "production";
    binding: DesignBinding;
    releaseIdForReuseEvent: string;
  }): Promise<void> {
    const quarantineEpoch = 0;
    for (const cell of input.binding.cells) {
      let designProofKey: string;
      try {
        const keyInput: DesignProofKeyInput = {
          releaseDigest: input.binding.contractDigest,
          fragmentDigests: input.binding.fragmentDigests,
          adapterTarget: WEB_ADAPTER_TARGET,
          environment: input.environment,
          scenarioKey: cell.scenarioKey,
          artifactDigest: input.binding.artifactDigest,
        };
        designProofKey = deriveDesignProofKey(keyInput);
      } catch (error) {
        // A malformed six-input component → skip this cell (fail-closed; no fabricated key).
        if (error instanceof DesignProofKeyInputError) continue;
        throw error;
      }
      const subjectId = `${cell.scenarioKey}::${designProofKey}`;
      const verdict: ProofUnitVerdict = cell.passed ? "pass" : "fail";
      const reuseIdentity = {
        inputHash: designProofKey,
        quarantineEpoch,
        toolchainHash: WEB_ADAPTER_TARGET,
        designContractVersion: input.binding.designContractVersion,
        behaviorManifestHash: input.binding.artifactDigest,
      };
      const reusable = await this.deps.proofUnits.findReusable({
        orgId: input.orgId,
        projectId: input.projectId,
        kind: DESIGN_DELIVERY_PROOF_UNIT_KIND,
        subjectId,
        ...reuseIdentity,
      });
      if (reusable !== undefined && reusable.verdict === "pass") {
        await this.emitProofReused({
          orgId: input.orgId,
          projectId: input.projectId,
          runId: input.runId,
          reusedProofId: reusable.proofUnitId,
          proofReuseKey: designProofKey,
          releaseId: input.releaseIdForReuseEvent,
        });
        continue;
      }
      await this.deps.proofUnits.record({
        orgId: input.orgId,
        projectId: input.projectId,
        kind: DESIGN_DELIVERY_PROOF_UNIT_KIND,
        subjectId,
        inputHash: proofUnitReuseInputHash(reuseIdentity),
        verdict,
        artifactHash: input.binding.artifactDigest,
        sourceNodeId: input.integrationNodeId,
        quarantineEpoch,
      });
    }
  }

  private async emitProofReused(input: {
    orgId: string;
    projectId: string;
    runId: string;
    reusedProofId: string;
    proofReuseKey: string;
    releaseId: string;
  }): Promise<void> {
    await this.deps.eventStore.append({
      orgId: input.orgId,
      projectId: input.projectId,
      runId: input.runId,
      eventType: "designSystem.proof.reused",
      payload: {
        validationRunId: input.runId,
        reusedProofId: input.reusedProofId,
        proofReuseKey: input.proofReuseKey,
        releaseId: input.releaseId,
      },
    });
  }
}

/**
 * Build the production coordinator over the shared pool + event store, constructing its own
 * `PgIntegrationProofUnitRepository`. A single factory so composition roots wire ds-6 through
 * ONE symbol (the runtime-import cap) without importing the proof-unit repository themselves.
 */
export function buildDesignAwareDeliveryCoordinator(
  pool: pg.Pool,
  eventStore: EventStore,
): DesignAwareDeliveryCoordinator {
  return new DesignAwareDeliveryCoordinator({
    pool,
    eventStore,
    proofUnits: new PgIntegrationProofUnitRepository(pool),
  });
}

/**
 * Resolve the composed design system binding (render verdict + artifact + fragment digests +
 * eager scenario cells) for a project. `undefined` when no render verdict / no contract
 * digest / no resolvable artifact exists — the fail-closed "no design binding" state.
 */
async function resolveDesignBinding(
  client: QueryClient,
  orgId: string,
  projectId: string,
): Promise<DesignBinding | undefined> {
  const verdict = await readLatestDesignRenderVerdict(client, orgId, projectId);
  if (verdict === undefined || verdict.contractDigest === null) return undefined;
  const release = await resolveReleaseInfo(client, orgId, verdict.releaseId);
  if (release === undefined) return undefined;
  const fragmentDigests = await resolveFragmentDigests(client, orgId, release.designSystemId);
  const cells = verdict.checkpoints.map((checkpoint) => ({
    scenarioKey: checkpoint.checkpointId,
    passed: checkpoint.verdict === "passed",
  }));
  if (cells.length === 0) return undefined;
  return {
    releaseId: verdict.releaseId,
    designSystemId: release.designSystemId,
    contractDigest: verdict.contractDigest,
    designContractVersion: verdict.designContractVersion,
    artifactDigest: release.artifactDigest,
    fragmentDigests,
    cells,
  };
}

/** Resolve the canonical artifact digest + design system id for a release (org-scoped). */
async function resolveReleaseInfo(
  client: QueryClient,
  orgId: string,
  releaseId: string,
): Promise<{ artifactDigest: string; designSystemId: string } | undefined> {
  const row = (
    await client.query<{ digest: string; design_system_id: string }>(
      `SELECT a.digest, r.design_system_id FROM design_system_releases r
         JOIN design_artifacts a ON a.org_id = r.org_id AND a.id = r.canonical_artifact_id
        WHERE r.org_id = $1 AND r.id = $2`,
      [orgId, releaseId],
    )
  ).rows[0];
  return row === undefined ? undefined : { artifactDigest: row.digest, designSystemId: row.design_system_id };
}

/** Resolve the SORTED set of validated fragment digests for the design system (deterministic,
 * consistent across pre_merge/production so the derived proof keys match on reuse). */
async function resolveFragmentDigests(client: QueryClient, orgId: string, designSystemId: string): Promise<string[]> {
  const rows = (
    await client.query<{ digest: string }>(
      `SELECT digest FROM design_fragments
        WHERE org_id = $1 AND design_system_id = $2 AND status = 'validated'
        ORDER BY digest ASC`,
      [orgId, designSystemId],
    )
  ).rows;
  return rows.map((row) => row.digest);
}
