// ds-7 — the multi-target DESIGN-SYSTEM COMPOSITION PRODUCER. This is the
// production entry point the onboarding derive callback invokes. It SUPERSEDES
// the closed `composeProjectWebDesignSystem` construction (clean-replace):
//
//   1. Read the project HEAD contract → derive the executable V2 (lossless
//      migration + desired surfaces + target profiles).
//   2. IDEMPOTENCY: a published release already tied to this contract lineage
//      short-circuits (re-verify only when the persisted design-render verdict
//      is missing or stale vs the current contract).
//   3. SELECT the missing design fragments for the required surfaces against
//      the org's present registry → AUTHOR them via ds-3 F2D (the writer seam).
//      Authoring is TARGET-AGNOSTIC — fragments are design intent each adapter
//      projects onto target-native code.
//   4. Create ONE design_system + ONE release (per project per contract).
//   5. For EACH required V2 target profile: resolve the adapter through the
//      `DesignTargetAdapterRegistry`, bootstrap plain + materialize the required
//      fragments (capability check), build the target's artifact, PERSIST
//      through CAS + the org-scoped artifact tables, RECORD a conformance
//      receipt over the EXACT artifact+matrix digest. The WEB-REACT artifact is
//      the canonical release artifact; non-web are additional artifacts keyed
//      to the same release.
//   6. Publish the release. Run the ds-4 design-render verify for the web
//      target (the gate-binding verdict).
//
// FAIL-CLOSED: an F2D authoring failure, a missing adapter, an unsupported
// capability, or a failed conformance receipt propagates — never a partial
// system. A non-web target whose adapter is unregistered is a LOUD typed error
// (`DesignAdapterNotRegisteredError`), not a silent skip.

import { randomUUID } from "node:crypto";
import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { EventStore } from "../../eventStore.js";
import type { AnswererAdapter } from "../../providers/types.js";
import { DesignContractStore } from "../../repositories/designContracts.js";
import { verifyAndRecordDesignRender } from "../render/composeDesignRenderVerification.js";
import { readLatestDesignRenderVerdict } from "../render/designRenderVerdictStore.js";
import type { ArtifactStore } from "./artifactStore.js";
import {
  type DesignContractV2,
  designRenderContractClauseRefs,
  designContractV2Digest,
  migrateDesignContractV1ToV2,
  withDerivedDesiredSurfaces,
} from "./designContractV2.js";
import { DesignSystemReleaseStore, resolveProjectWebDesignSystem } from "./designSystemStore.js";
import type { WebDesignWriterContext } from "./webWriterContext.js";
import { resolveDtcgTokens } from "./dtcgResolver.js";
import { WEB_DESIGN_TARGET, WebDesignTargetAdapter } from "./webAdapter.js";
import { buildDesignTargetAdapterSet } from "./designTargetRegistry.js";
import { type DesignAdapterConformanceRunRow, DesignAdapterConformanceStore } from "./adapterConformanceStore.js";
import {
  type DesignAdapterConformanceTarget,
  DESIGN_ADAPTER_CONFORMANCE_TARGETS,
} from "./adapterConformanceReceipt.js";
import type { DesignFragmentDraftV1 } from "./authoring/index.js";
import { requiredDesignFragmentsFromSurfaces } from "./authoring/index.js";
import type { TargetCompositionContext } from "./composeWebTarget.js";
import { composeTargetOutcome } from "./composeTargetOutcome.js";
import {
  authorMissingFragments,
  PLAIN_BASE_TOKENS,
  plainReleaseDigest,
  polishedReleaseDigest,
} from "./composeAuthoring.js";

const OPERATOR = { kind: "operator" } as const;

/** Production dependencies. The provider seam is the ONLY injectable boundary. */
export interface ComposeProjectTargetDesignSystemsDeps {
  readonly pool: pg.Pool;
  readonly artifactStore: ArtifactStore;
  readonly fragmentAnswerer: AnswererAdapter<DesignFragmentDraftV1>;
  readonly eventStore: EventStore;
  readonly createdBy: string;
}

export interface ComposeProjectTargetDesignSystemsInput {
  readonly orgId: string;
  readonly projectId: string;
}

/** One target's outcome — published + recorded, or the typed failure that blocked. */
export interface ComposeProjectTargetOutcome {
  readonly target: DesignAdapterConformanceTarget;
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly conformanceRunId: string;
  readonly conformanceOutcome: DesignAdapterConformanceRunRow["outcome"];
}

export interface ComposeProjectTargetDesignSystemsResult {
  readonly designSystemId: string;
  readonly releaseId: string;
  /** The canonical (web-react) artifact id the release resolves to. */
  readonly canonicalArtifactId: string;
  readonly authoredFragmentIds: readonly string[];
  readonly alreadyPublished: boolean;
  /** Per-target outcomes — empty for the idempotent short-circuit path. */
  readonly targets: readonly ComposeProjectTargetOutcome[];
}

/** A required target recorded a non-green conformance receipt; its draft release may not advance. */
export class RequiredDesignAdapterConformanceError extends Error {
  constructor(
    readonly target: DesignAdapterConformanceTarget,
    readonly outcome: DesignAdapterConformanceRunRow["outcome"],
  ) {
    super(`required design target '${target}' conformance is '${outcome}' — release publication is blocked`);
    this.name = "RequiredDesignAdapterConformanceError";
  }
}

/**
 * Compose (and publish) the project's design system across every required V2
 * target profile. Returns `undefined` when the project has no design contract
 * yet (the caller's derive guards `MissingDesignContractError` before reaching
 * here, so in production this is only the truly-contract-less case).
 */
export async function composeProjectTargetDesignSystems(
  deps: ComposeProjectTargetDesignSystemsDeps,
  input: ComposeProjectTargetDesignSystemsInput,
): Promise<ComposeProjectTargetDesignSystemsResult | undefined> {
  const { orgId, projectId } = input;

  // 1) HEAD contract + IDEMPOTENCY (a published release already tied to this
  // contract lineage short-circuits, exactly like the prior web-only path).
  const head = await runWithOrgScope(deps.pool, orgId, (client) =>
    DesignContractStore.getLatest(client, projectId, OPERATOR),
  );
  if (head === undefined) return undefined;

  // Read V2 from the RAW jsonb (forward-compatible: a full-V2 capture persists
  // targetProfiles natively; a V1 capture migrates with default web-react).
  // The raw blob preserves V2 fields the V1 strict parser strips.
  const contractV2 = withDerivedDesiredSurfaces(migrateDesignContractV1ToV2(head.rawContract));
  const contractDigest = designContractV2Digest(contractV2);
  const existing = await runWithOrgScope(deps.pool, orgId, (client) =>
    resolveProjectWebDesignSystem(client, { orgId, projectId }),
  );
  if (existing !== undefined) {
    await reverifyPublishedDesignRenderIfStale(deps, {
      orgId,
      projectId,
      existing,
      contractVersion: head.version,
      contractV2,
      contractDigest,
    });
    return {
      designSystemId: existing.designSystemId,
      releaseId: existing.releaseId,
      canonicalArtifactId: existing.artifactId,
      authoredFragmentIds: [],
      alreadyPublished: true,
      targets: [],
    };
  }

  // 2) F2D authoring (target-agnostic). The web adapter validates the authored
  // fragments through the SAME kernel every target shares — the fragments are
  // design intent each adapter projects, not target-specific code.
  const { authoredIds, authoredFragmentDigests } = await authorMissingFragments(deps, {
    orgId,
    projectId,
    contractV2,
  });

  // 3) One design_system + one release per project per contract.
  const designSystemId = `design_system_${randomUUID()}`;
  const releaseId = `design_release_${randomUUID()}`;
  const releaseStore = new DesignSystemReleaseStore(deps.pool);
  await releaseStore.createSystem({
    orgId,
    id: designSystemId,
    slug: `design-${projectId}`.slice(0, 80),
    name: `Design system for ${projectId}`.slice(0, 200),
  });
  await releaseStore.createRelease({
    orgId,
    id: releaseId,
    designSystemId,
    version: 1,
    contractId: head.id,
    contractVersion: head.version,
    contractDigest,
    manifestSchemaVersion: 1,
    createdBy: deps.createdBy,
  });

  // 4) Build + persist the artifact for EACH required V2 target profile.
  const adapterSet = buildDesignTargetAdapterSet(
    { designSystemId, releaseId, tokens: resolveDtcgTokens(PLAIN_BASE_TOKENS) },
    PLAIN_BASE_TOKENS,
  );
  const requiredTargetProfiles = contractV2.targetProfiles.filter((profile) => profile.required);
  // Vacuous-truth defense (trap #4): a contract with ZERO required targets
  // cannot pass — every published system MUST cover at least one target. The
  // V2 deriver seeds web-react by default; reaching zero here is a wiring bug.
  if (requiredTargetProfiles.length === 0) {
    throw new Error("composeProjectTargetDesignSystems requires at least one required target profile");
  }
  const plainDigest = plainReleaseDigest();
  const polishedDigest = polishedReleaseDigest(contractDigest, authoredFragmentDigests);

  const compositionContext: TargetCompositionContext = {
    orgId,
    projectId,
    designSystemId,
    releaseId,
    contractDigest,
    plainReleaseDigest: plainDigest,
    polishedReleaseDigest: polishedDigest,
    fragmentLineage: [...authoredIds].sort(),
  };

  const conformanceStore = new DesignAdapterConformanceStore(deps.pool);
  const outcomes: ComposeProjectTargetOutcome[] = [];
  let canonicalArtifactId: string | undefined;

  for (const profile of requiredTargetProfiles) {
    if (!DESIGN_ADAPTER_CONFORMANCE_TARGETS.includes(profile.target as DesignAdapterConformanceTarget)) {
      throw new Error(
        `composeProjectTargetDesignSystems: target '${profile.target}' is not in the frozen adapter union`,
      );
    }
    if (profile.capabilities.length === 0) {
      throw new Error(
        `composeProjectTargetDesignSystems: required target '${profile.target}' must declare a non-empty capability set`,
      );
    }
    const target = profile.target as DesignAdapterConformanceTarget;
    const outcome = await composeTargetOutcome(deps, adapterSet, {
      target,
      requiredCapabilities: profile.capabilities,
      context: compositionContext,
      conformanceStore,
    });
    if (outcome.canonicalForRelease) canonicalArtifactId = outcome.artifactId;
    outcomes.push({
      target: outcome.target,
      artifactId: outcome.artifactId,
      artifactDigest: outcome.artifactDigest,
      conformanceRunId: outcome.conformanceRunId,
      conformanceOutcome: outcome.conformanceOutcome,
    });
  }

  // A receipt row is durable evidence, not an advisory log. Every required
  // target must be decisively green before a draft release may advance. This
  // deliberately happens AFTER recording all outcomes so an operator can see
  // the exact failed/inconclusive target, and BEFORE canonical selection or
  // release publication so no non-green target can leak into a release.
  const nonPassingTarget = outcomes.find((outcome) => outcome.conformanceOutcome !== "passed");
  if (nonPassingTarget !== undefined) {
    throw new RequiredDesignAdapterConformanceError(nonPassingTarget.target, nonPassingTarget.conformanceOutcome);
  }

  if (canonicalArtifactId === undefined) {
    // The contract did not declare web-react as required. The release nonetheless
    // needs a canonical artifact — pick the first composed target. (A real
    // contract will declare web-react; this is the defensive default.)
    canonicalArtifactId = outcomes[0]?.artifactId;
    if (canonicalArtifactId === undefined) {
      throw new Error("composeProjectTargetDesignSystems: no target artifact was published");
    }
  }

  // 5) Publish the release (canonical artifact = web-react when present).
  await releaseStore.publishRelease({
    orgId,
    releaseId,
    canonicalArtifactId,
    publishedBy: deps.createdBy,
  });

  // 6) ds-4 design-render VERIFY runs ONLY for the required web-react target,
  // and always against that target's own artifact/matrix coordinate. A non-web
  // canonical fallback is never fed through the web adapter (proof≠effect).
  const webOutcome = outcomes.find((outcome) => outcome.target === WEB_DESIGN_TARGET);
  if (webOutcome !== undefined) {
    const profile = { target: WEB_DESIGN_TARGET, capabilities: [] };
    const plain = await adapterSet.web.bootstrapPlainSystem(profile);
    const materialized = await adapterSet.web.materialize(requiredDesignFragmentsFromSurfaces(contractV2), plain);
    await verifyAndRecordDesignRender({
      pool: deps.pool,
      orgId,
      projectId,
      designSystemId,
      releaseId,
      artifactId: webOutcome.artifactId,
      artifactDigest: webOutcome.artifactDigest,
      contractDigest,
      contractClauseRefs: designRenderContractClauseRefs(contractV2),
      plainReleaseDigest: plainDigest,
      polishedReleaseDigest: polishedDigest,
      fragmentLineage: compositionContext.fragmentLineage,
      designContractVersion: String(head.version),
      accessibilityPosture: contractV2.accessibilityPosture,
      visualVerification: contractV2.visualVerification,
      adapter: adapterSet.web,
      materialized,
      profile,
    });
  }

  return {
    designSystemId,
    releaseId,
    canonicalArtifactId,
    authoredFragmentIds: authoredIds,
    alreadyPublished: false,
    targets: outcomes,
  };
}

/** The idempotent short-circuit's stale-verdict re-check. Mirrors the prior web-only guard. */
async function reverifyPublishedDesignRenderIfStale(
  deps: ComposeProjectTargetDesignSystemsDeps,
  input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly existing: WebDesignWriterContext;
    readonly contractVersion: number;
    readonly contractV2: DesignContractV2;
    readonly contractDigest: string;
  },
): Promise<void> {
  const { existing, contractV2, contractDigest } = input;
  const priorVerdict = await runWithOrgScope(deps.pool, input.orgId, (client) =>
    readLatestDesignRenderVerdict(client, input.orgId, input.projectId),
  );
  const verdictMatchesCurrentContract =
    priorVerdict !== undefined &&
    priorVerdict.releaseId === existing.releaseId &&
    priorVerdict.designContractVersion === String(input.contractVersion) &&
    priorVerdict.contractDigest === contractDigest;
  if (verdictMatchesCurrentContract) return;
  const requiredFragments = requiredDesignFragmentsFromSurfaces(contractV2);
  const adapter = new WebDesignTargetAdapter({
    designSystemId: existing.designSystemId,
    releaseId: existing.releaseId,
    tokens: resolveDtcgTokens(PLAIN_BASE_TOKENS),
  });
  const profile = { target: WEB_DESIGN_TARGET, capabilities: [] };
  const plain = await adapter.bootstrapPlainSystem(profile);
  const materialized = await adapter.materialize(requiredFragments, plain);
  await verifyAndRecordDesignRender({
    pool: deps.pool,
    orgId: input.orgId,
    projectId: input.projectId,
    designSystemId: existing.designSystemId,
    releaseId: existing.releaseId,
    artifactId: existing.artifactId,
    artifactDigest: await readArtifactDigest(deps.pool, input.orgId, existing.artifactId),
    contractDigest,
    contractClauseRefs: designRenderContractClauseRefs(contractV2),
    plainReleaseDigest: plainReleaseDigest(),
    polishedReleaseDigest: polishedReleaseDigest(contractDigest, []),
    fragmentLineage: [],
    designContractVersion: String(input.contractVersion),
    accessibilityPosture: contractV2.accessibilityPosture,
    visualVerification: contractV2.visualVerification,
    adapter,
    materialized,
    profile,
  });
}

async function readArtifactDigest(pool: pg.Pool, orgId: string, artifactId: string): Promise<string> {
  return runWithOrgScope(pool, orgId, async (client) => {
    const row = (
      await client.query<{ digest: string }>(`SELECT digest FROM design_artifacts WHERE org_id = $1 AND id = $2`, [
        orgId,
        artifactId,
      ])
    ).rows[0];
    if (row === undefined) throw new Error(`published web artifact '${artifactId}' has no immutable digest`);
    return row.digest;
  });
}
