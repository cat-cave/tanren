// mq-15 merge-train artifact watcher (a RunMergeWatcher, driven AFTER demoWatcher in
// PostMergeSubscriber.runChain). It turns ONE completed land group into ONE sealed,
// content-addressed delivery artifact — a PROJECTION of already-authoritative evidence,
// never a new authority or proof chain. Sealing/verification are DELEGATED to the
// injected `ProofSubstrate` (engine/contracts/cas.ts); this watcher invents no signer.
//
// This file is the DB shell: it resolves org ownership under a de-privileged read, then
// runs the pure fail-closed gates + seal in `mergeTrainArtifactGates.ts`. It seals only
// when EVERY bound input is present and exact (completed land group + matching main SHA,
// same-project authority decision, integration.proof_root.composed, merge.group.formed,
// land receipt, verified deploy, and a successful proof-backed demo). Any missing /
// duplicate / cross-project / mismatched input persists NO row and stays silent (the
// read/UI remain `unknown`, never green). A signature the substrate cannot verify
// persists NO row. Duplicate delivery is idempotent (one row per land group).

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { CasByteStore, ProofSubstrate } from "../contracts/cas.js";

// Re-exported so the worker boot wires the watcher + its injected substrate types from a
// SINGLE module (keeping autonomyLoops' dependency count within the lint budget).
export type { CasByteStore, ProofSubstrate } from "../contracts/cas.js";
import { createLogger } from "../observability/logger.js";
import { CompletedPayload, type Evidence, gatherEvidenceFromClient, sealEvidence } from "./mergeTrainArtifactGates.js";
import { PgMergeTrainArtifactStore } from "./mergeTrainArtifactStore.js";
import { loadValidatedRunEvent } from "./runLineage.js";
import type { RunMergeWatcher } from "./subscriber.js";

const log = createLogger("merge-train-artifact");

export interface MergeTrainArtifactWatcherDeps {
  readonly pool: pg.Pool;
  readonly proofSubstrate: ProofSubstrate;
  readonly casByteStore: CasByteStore;
  readonly store?: PgMergeTrainArtifactStore;
}

export class MergeTrainArtifactWatcher implements RunMergeWatcher {
  private readonly store: PgMergeTrainArtifactStore;

  constructor(private readonly deps: MergeTrainArtifactWatcherDeps) {
    this.store = deps.store ?? new PgMergeTrainArtifactStore(deps.pool);
  }

  async check(runId: string): Promise<void> {
    const evidence = await this.gather(runId);
    if (evidence === undefined) return;
    const outcome = await sealEvidence(
      { proofSubstrate: this.deps.proofSubstrate, casByteStore: this.deps.casByteStore, store: this.store },
      evidence,
    );
    if (outcome.status === "verification_failed") {
      // A train the sole substrate cannot verify is NEVER sealed as a delivery.
      log.warn("merge-train seal rejected: bundle failed verification", {
        landGroupId: evidence.completed.landGroupId,
        reason: outcome.reason,
      });
      return;
    }
    if (outcome.inserted) {
      log.info("merge-train artifact sealed", {
        landGroupId: evidence.completed.landGroupId,
        bundleDigest: outcome.artifact.sealedBundle.bundleDigest,
      });
    }
  }

  /** Resolve org ownership under a de-privileged read, then gate under org scope. */
  private async gather(runId: string): Promise<Evidence | undefined> {
    const completedEvent = await runWithSystemScope(this.deps.pool, (client) =>
      loadValidatedRunEvent(client, { runId, eventType: "merge.land_group.completed", requireEventSpec: false }),
    );
    if (completedEvent === undefined) return undefined;
    const completed = CompletedPayload.safeParse(completedEvent.payload);
    if (!completed.success) return undefined;
    const lineage = completedEvent.lineage;
    if (completed.data.projectId !== lineage.projectId) return undefined;

    return runWithOrgScope(this.deps.pool, lineage.orgId, (client) =>
      gatherEvidenceFromClient(client, lineage, completed.data, runId, (eventType) =>
        loadValidatedRunEvent(client, { runId, eventType, requireEventSpec: false }),
      ),
    );
  }
}

/** Build the watcher. Absent a `ProofSubstrate`, the caller must not construct it. */
export function buildMergeTrainArtifactWatcher(deps: MergeTrainArtifactWatcherDeps): MergeTrainArtifactWatcher {
  return new MergeTrainArtifactWatcher(deps);
}
