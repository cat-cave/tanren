// ds-4 sub-node #3 — the compose-time seam that RUNS the render verification over a just-
// published web design system and persists ONE run-level verdict. Split out of
// `composeProjectWebDesignSystem` so that producer stays within the module-dependency cap
// and the render-verification wiring lives beside the harness/oracle it drives.

import type pg from "pg";
import { PgCasByteStore } from "../../cas/pgCasByteStore.js";
import type { DesignAccessibilityPosture } from "../system/designContractV2.js";
import type { DesignTargetProfile, DesignVfsView } from "../system/designTargetAdapter.js";
import type { WebDesignTargetAdapter } from "../system/webAdapter.js";
import { verifyComposedDesignSystemRender } from "./designSystemRenderVerification.js";
import type { DesignRenderVerification } from "./designRenderVerdict.js";
import { recordDesignRenderVerdict } from "./designRenderVerdictStore.js";

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
    const build = input.adapter.buildArtifact({
      artifactId: input.artifactId,
      contractDigest: input.contractDigest,
      plainReleaseDigest: input.plainReleaseDigest,
      polishedReleaseDigest: input.polishedReleaseDigest,
      fragmentLineage: [...input.fragmentLineage],
    });
    const scenarios = await input.adapter.renderScenarioMatrix(input.materialized, input.profile);
    verification = await verifyComposedDesignSystemRender({
      orgId: input.orgId,
      cas: new PgCasByteStore(input.pool),
      build,
      scenarios,
      accessibilityPosture: input.accessibilityPosture,
      designContractVersion: input.designContractVersion,
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
    verification,
  });
}
