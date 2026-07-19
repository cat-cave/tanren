// ds-4 sub-node #3 — the compose-time seam that RUNS the render verification over a just-
// published web design system and persists ONE run-level verdict. Split out of
// `composeProjectWebDesignSystem` so that producer stays within the module-dependency cap
// and the render-verification wiring lives beside the harness/oracle it drives.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { PgCasByteStore } from "../../cas/pgCasByteStore.js";
import type { CasArtifactRef, CasByteStore, Digest } from "../../contracts/cas.js";
import type { VisualComparisonRules } from "../../contracts/runtimeVerificationAdapters.js";
import type { DesignAccessibilityPosture, DesignVisualVerification } from "../system/designContractV2.js";
import type { DesignTargetProfile, DesignVfsView } from "../system/designTargetAdapter.js";
import type { WebDesignTargetAdapter } from "../system/webAdapter.js";
import { verifyComposedDesignSystemRender } from "./designSystemRenderVerification.js";
import type { DesignRenderVerification } from "./designRenderVerdict.js";
import { readLatestDesignRenderVerdict, recordDesignRenderVerdict } from "./designRenderVerdictStore.js";
import { scenarioKeyFromPixelCheckpointId } from "./pixelRenderCheckpoint.js";
import type { PixelVerificationWiring } from "./pixelRenderScenarioPass.js";
import { buildPodmanScreenshotRunner, probeRenderWorkerAvailable } from "./podmanScreenshotRunner.js";

export interface VerifyAndRecordDesignRenderInput {
  readonly pool: pg.Pool;
  readonly orgId: string;
  readonly projectId: string;
  readonly designSystemId: string;
  readonly releaseId: string;
  readonly artifactId: string;
  readonly contractDigest: string;
  readonly plainReleaseDigest: string;
  readonly polishedReleaseDigest: string;
  readonly fragmentLineage: readonly string[];
  readonly designContractVersion: string;
  readonly accessibilityPosture: DesignAccessibilityPosture;
  /** The project's opt-in pixel visual-verification knob (default off → a11y-only). */
  readonly visualVerification: DesignVisualVerification;
  readonly adapter: WebDesignTargetAdapter;
  readonly materialized: DesignVfsView;
  readonly profile: DesignTargetProfile;
}

/**
 * Render + judge the just-published system and persist ONE run-level design-render verdict.
 * The build (catalog + component sources) + the scenario matrix come from the SAME adapter
 * that published the artifact, so the verification renders the REAL composed catalog. A
 * fault in the render pass (never an a11y failure — those are recorded as a verdict) persists
 * a fail-closed `inconclusive_infrastructure` verdict so the published system is never left
 * unverified.
 */
export async function verifyAndRecordDesignRender(input: VerifyAndRecordDesignRenderInput): Promise<void> {
  const standard = input.accessibilityPosture.standard;
  let verification: DesignRenderVerification;
  try {
    const cas = new PgCasByteStore(input.pool);
    const build = input.adapter.buildArtifact({
      artifactId: input.artifactId,
      contractDigest: input.contractDigest,
      plainReleaseDigest: input.plainReleaseDigest,
      polishedReleaseDigest: input.polishedReleaseDigest,
      fragmentLineage: [...input.fragmentLineage],
    });
    const scenarios = await input.adapter.renderScenarioMatrix(input.materialized, input.profile);
    // Build the pixel wiring ONLY when the opt-in knob is enabled (default off → undefined →
    // a11y-only, no podman). The regression baseline is the PRIOR release's persisted pixel
    // screenshot (read BEFORE this compose records its own verdict), so the first compose has
    // no baseline → inconclusive (fail-closed), and a later drift → failed_visual.
    const pixel = input.visualVerification.enabled
      ? await buildPixelWiring(input.pool, cas, input.orgId, input.projectId, input.visualVerification)
      : undefined;
    verification = await verifyComposedDesignSystemRender({
      orgId: input.orgId,
      cas,
      build,
      scenarios,
      accessibilityPosture: input.accessibilityPosture,
      designContractVersion: input.designContractVersion,
      ...(pixel === undefined ? {} : { pixel }),
    });
  } catch {
    // FAIL-CLOSED: the render pass itself faulted — persist an inconclusive verdict (blocks
    // at land time), never leave the published system with no verdict (which the gate would
    // otherwise have to treat as required-but-absent).
    verification = {
      outcome: "inconclusive_infrastructure",
      accessibilityStandard: standard,
      checkpoints: [],
      passedCount: 0,
      failedCount: 0,
      inconclusiveCount: 0,
      excludedCount: 0,
      failingScenarioKey: null,
      failingRuleIds: [],
    };
  }
  await recordDesignRenderVerdict(input.pool, {
    orgId: input.orgId,
    projectId: input.projectId,
    designSystemId: input.designSystemId,
    releaseId: input.releaseId,
    designContractVersion: input.designContractVersion,
    contractDigest: input.contractDigest,
    verification,
  });
}

/**
 * Assemble the injected pixel verification wiring: the real podman screenshot runner, the
 * fail-closed infra probe, the contract-configured visual rules, and a regression baseline
 * resolver backed by the PRIOR release's persisted pixel screenshots. Read the prior verdict
 * ONCE here (before this compose records its own), so "prior" is never this run's own row.
 */
async function buildPixelWiring(
  pool: pg.Pool,
  cas: CasByteStore,
  orgId: string,
  projectId: string,
  knob: DesignVisualVerification,
): Promise<PixelVerificationWiring> {
  const baselines = await loadPriorPixelBaselines(pool, cas, orgId, projectId);
  const rules: VisualComparisonRules = {
    imageDiffThreshold: knob.imageDiffThreshold,
    layoutTolerance: 0,
    tokenRules: [],
    contrastMinimum: 0,
    semanticRules: [],
  };
  return {
    runner: buildPodmanScreenshotRunner(),
    available: () => probeRenderWorkerAvailable(),
    rules,
    baselineResolver: { resolve: async (scenarioKey) => baselines.get(scenarioKey) ?? null },
  };
}

/**
 * Map each scenario → its PRIOR release's captured screenshot CAS ref (the regression
 * baseline). Reads the latest persisted design_render verdict's pixel checkpoints and, for
 * each whose screenshot bytes are still resolvable in CAS, records a real ref. A scenario
 * with no prior screenshot (or whose bytes are gone) is simply absent → the oracle sees a
 * null baseline → inconclusive (fail-closed, never a pass).
 */
async function loadPriorPixelBaselines(
  pool: pg.Pool,
  cas: CasByteStore,
  orgId: string,
  projectId: string,
): Promise<Map<string, CasArtifactRef>> {
  const baselines = new Map<string, CasArtifactRef>();
  const prior = await runWithOrgScope(pool, orgId, (client) => readLatestDesignRenderVerdict(client, orgId, projectId));
  if (prior === undefined) return baselines;
  for (const checkpoint of prior.checkpoints) {
    const scenarioKey = scenarioKeyFromPixelCheckpointId(checkpoint.checkpointId);
    if (scenarioKey === null || checkpoint.screenshotDigest === undefined) continue;
    const digest = checkpoint.screenshotDigest as Digest;
    try {
      const bytes = await cas.get(orgId, digest);
      baselines.set(scenarioKey, { digest, byteSize: bytes.bytes.byteLength, mediaType: bytes.mediaType });
    } catch {
      // The prior screenshot bytes are gone → no baseline for this scenario (fail-closed).
    }
  }
  return baselines;
}
