// ds-composer — the design-system COMPOSITION PRODUCER (the code-F2 analog for the
// DESIGN subsystem). This is the production node that makes ds-3's F2D loop genuinely
// callable: nothing else in the run path writes a PUBLISHED `design_system_releases`
// row, so the reader (`resolveProjectWebDesignSystem`, worker/runExecutionContext.ts)
// never fired and `runDesignFragmentAuthoring` was a DEAD path. This producer closes
// that gap end-to-end — read the project HEAD contract → derive the composition-need
// surfaces → select the missing design fragments → AUTHOR them via ds-3 F2D (the real
// writer seam) → materialize + build + publish the ds-2 web artifact → create the
// system/release (draft) → PUBLISH the release. After it runs, the reader lights up.
//
// FAIL-CLOSED: an F2D authoring failure propagates `DesignFragmentAuthoringFailedError`
// (never a silent skip or a fabricated fragment). IDEMPOTENT: if a published release
// already matches the project's HEAD contract lineage, the producer short-circuits
// (no double-publish). The web adapter is TOKEN-DRIVEN (ds-2): the authored fragments
// are validated + persisted (F2D's contract) and their lineage is recorded on the
// manifest; the deterministic token/component projection is the artifact body.

import { createHash, randomUUID } from "node:crypto";
import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { EventStore } from "../../eventStore.js";
import type { AnswererAdapter } from "../../providers/types.js";
import { DesignContractStore } from "../../repositories/designContracts.js";
import type { ArtifactStore } from "./artifactStore.js";
import { designContractV2Digest, migrateDesignContractV1ToV2, withDerivedDesiredSurfaces } from "./designContractV2.js";
import { DesignSystemReleaseStore, resolveProjectWebDesignSystem } from "./designSystemStore.js";
import { resolveDtcgTokens } from "./dtcgResolver.js";
import { WEB_DESIGN_TARGET, WebDesignTargetAdapter } from "./webAdapter.js";
import type { DesignFragmentDraftV1 } from "./authoring/designFragmentDraft.js";
import { wrapProviderDesignFragmentAuthorer } from "./authoring/designFragmentAuthorer.js";
import { DesignFragmentAuthoringFailedError, runDesignFragmentAuthoring } from "./authoring/designFragmentAuthoring.js";
import { createDesignFragmentAuthoringEvents } from "./authoring/designFragmentEvents.js";
import {
  requiredDesignFragmentsFromSurfaces,
  selectMissingDesignFragments,
} from "./authoring/designFragmentSelector.js";
import { DesignFragmentStore } from "./authoring/designFragmentStore.js";

// The deliberately-PLAIN base token set the web system bootstraps from (design bucket
// §1 "plain base"). A neutral, resolvable DTCG document — the honest starting substrate
// the ds-2 adapter projects tokens/components/exports from; F2D fragments compose on top.
const PLAIN_BASE_TOKENS = {
  color: {
    background: { $type: "color", $value: "#ffffff" },
    foreground: { $type: "color", $value: "#101828" },
    border: { $type: "color", $value: "#d0d5dd" },
    primary: { $type: "color", $value: "#155eef" },
  },
  radius: { md: { $type: "dimension", $value: "0.375rem" } },
  space: { md: { $type: "dimension", $value: "0.5rem" } },
} as const;

/** The production dependencies the composer is constructed with. The provider seam
 * (`fragmentAnswerer`) is the ONLY injectable boundary — production wires the real
 * allocating Forge answerer; a deterministic test injects a fixture through the SAME
 * seam. Every store/adapter/event sink below is constructed HERE (not injected), so
 * the wiring itself is production code. */
export interface ComposeProjectWebDesignSystemDeps {
  readonly pool: pg.Pool;
  /** Content-addressed artifact byte store (ds-1 CAS) the built web artifact persists to. */
  readonly artifactStore: ArtifactStore;
  /** The F2D writer boundary: a structured-output answerer producing a design-fragment
   * draft. Production wires `forgeAllocatingAnswererAdapter<DesignFragmentDraftV1>`. */
  readonly fragmentAnswerer: AnswererAdapter<DesignFragmentDraftV1>;
  /** The durable event sink `designFragment.authoring.*` + `design.*` land on. */
  readonly eventStore: EventStore;
  /** The `created_by` / `published_by` provenance stamp for the composed rows. */
  readonly createdBy: string;
}

export interface ComposeProjectWebDesignSystemInput {
  readonly orgId: string;
  readonly projectId: string;
}

export interface ComposeProjectWebDesignSystemResult {
  readonly designSystemId: string;
  readonly releaseId: string;
  readonly artifactId: string;
  /** The fragment-release ids F2D authored this run (empty when all were present). */
  readonly authoredFragmentIds: readonly string[];
  /** True when a published release already matched the HEAD contract (idempotent no-op). */
  readonly alreadyPublished: boolean;
}

const OPERATOR = { kind: "operator" } as const;

/**
 * Compose (and publish) the project's web design system from its HEAD design contract.
 * Returns `undefined` when the project has no design contract yet (a real empty state —
 * the caller's derive guards this with `MissingDesignContractError` before reaching
 * here, so in production this is only the truly-contract-less case).
 */
export async function composeProjectWebDesignSystem(
  deps: ComposeProjectWebDesignSystemDeps,
  input: ComposeProjectWebDesignSystemInput,
): Promise<ComposeProjectWebDesignSystemResult | undefined> {
  const { orgId, projectId } = input;

  // 1) Read the HEAD contract + IDEMPOTENCY: a published release already tied to this
  // exact contract lineage means the system is composed — short-circuit (no re-publish).
  const head = await runWithOrgScope(deps.pool, orgId, (client) =>
    DesignContractStore.getLatest(client, projectId, OPERATOR),
  );
  if (head === undefined) return undefined;

  const existing = await runWithOrgScope(deps.pool, orgId, (client) =>
    resolveProjectWebDesignSystem(client, { orgId, projectId }),
  );
  if (existing !== undefined) {
    return {
      designSystemId: existing.designSystemId,
      releaseId: existing.releaseId,
      artifactId: existing.artifactId,
      authoredFragmentIds: [],
      alreadyPublished: true,
    };
  }

  // 2) Derive the executable V2 the producer composes against: the lossless migration
  // PLUS the composition-need surfaces (from the authored dimensions) + web profile.
  const contractV2 = withDerivedDesiredSurfaces(migrateDesignContractV1ToV2(head.contract));
  const contractDigest = designContractV2Digest(contractV2);

  // 3) SELECT the missing design fragments for the required surfaces against the org's
  // present registry, then AUTHOR them through ds-3 F2D (fires here for the missing set).
  const required = requiredDesignFragmentsFromSurfaces(contractV2);
  const fragmentStore = new DesignFragmentStore(deps.pool);
  const present = await fragmentStore.listPresentByOrg(orgId);
  // Snapshot the org's present fragment FILE bodies BEFORE authoring persists this
  // run's fragments (the kernel persists-as-validated ahead of the batch gate). The
  // batch gate composes the authored set against THIS pre-run registry, so a NEW
  // fragment colliding with an EXISTING persisted fragment is caught — while the just-
  // authored fragments are NOT double-counted (they are added by the gate separately).
  const presentFiles = await fragmentStore.listPresentFilesByOrg(orgId);
  const missing = selectMissingDesignFragments(required, present);

  const authoredIds: string[] = [];
  const authoredFragmentDigests: string[] = [];
  if (missing.length > 0) {
    const authorer = wrapProviderDesignFragmentAuthorer(deps.fragmentAnswerer, { contract: contractV2 });
    const adapter = buildWebAdapter(randomUUID(), randomUUID());
    const result = await runDesignFragmentAuthoring({
      missing,
      context: { orgId, projectId, createdBy: deps.createdBy },
      deps: {
        authorer,
        adapter,
        store: fragmentStore,
        events: createDesignFragmentAuthoringEvents(deps.eventStore),
        // Cross-run collision defense: the batch gate composes the authored fragments
        // against the org's REAL present file bodies (snapshotted PRE-authoring above),
        // so a NEW fragment whose path collides with an EXISTING persisted fragment is
        // caught (not just NEW-vs-NEW). The pre-run snapshot avoids double-counting this
        // run's own just-persisted fragments (the kernel persists ahead of the gate).
        loadPresentFiles: async () => presentFiles,
      },
    });
    if (result.failedIds.length > 0) {
      // Fail-closed + LOUD: a missing surface could not be authored — never a partial system.
      throw new DesignFragmentAuthoringFailedError([...result.failedIds], result.failureReasons);
    }
    for (const validated of result.validated) {
      authoredIds.push(validated.fragmentReleaseId);
      authoredFragmentDigests.push(validated.fragmentDigest);
    }
  }

  // 4) Assign the durable ids, then build + publish the ds-2 web artifact and the
  // system/release backbone, and PUBLISH the release (piece 2).
  const designSystemId = `design_web_system_${randomUUID()}`;
  const releaseId = `design_web_release_${randomUUID()}`;
  const artifactId = `design_web_artifact_${randomUUID()}`;

  const releaseStore = new DesignSystemReleaseStore(deps.pool);
  await releaseStore.createSystem({
    orgId,
    id: designSystemId,
    slug: `web-${projectId}`.slice(0, 80),
    name: `Web design system for ${projectId}`.slice(0, 200),
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

  const adapter = buildWebAdapter(designSystemId, releaseId);
  // Bootstrap the plain base + materialize the required composition graph (capability
  // check) so the pipeline runs the full ds-2 seam before building the artifact bytes.
  const plain = await adapter.bootstrapPlainSystem({ target: WEB_DESIGN_TARGET, capabilities: [] });
  await adapter.materialize(required, plain);

  const plainReleaseDigest = digestOf(["tanren.ds-composer.plain.v1", PLAIN_BASE_TOKENS]);
  const polishedReleaseDigest = digestOf([
    "tanren.ds-composer.polished.v1",
    contractDigest,
    [...authoredFragmentDigests].sort(),
  ]);
  await adapter.publish({
    artifactId,
    contractDigest,
    plainReleaseDigest,
    polishedReleaseDigest,
    fragmentLineage: [...authoredIds].sort(),
    pool: deps.pool,
    artifactStore: deps.artifactStore,
    eventStore: deps.eventStore,
    orgId,
    projectId,
  });

  await releaseStore.publishRelease({
    orgId,
    releaseId,
    canonicalArtifactId: artifactId,
    publishedBy: deps.createdBy,
  });

  return { designSystemId, releaseId, artifactId, authoredFragmentIds: authoredIds, alreadyPublished: false };
}

function buildWebAdapter(designSystemId: string, releaseId: string): WebDesignTargetAdapter {
  return new WebDesignTargetAdapter({
    designSystemId,
    releaseId,
    tokens: resolveDtcgTokens(PLAIN_BASE_TOKENS),
  });
}

/** A `sha256:<hex>` content address over a stable JSON body (manifest digest anchors). */
function digestOf(body: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex")}`;
}
