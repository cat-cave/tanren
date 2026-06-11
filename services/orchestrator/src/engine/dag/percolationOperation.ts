// The production change-percolation KICK-OFF operation (autonomy-engine.md §2c
// "Change-percolation — NOT discard"; walker-jj-local-integration-design.md §4): for ONE
// (dependent, ancestor-change) it RE-RESOLVES the dependent's ordered unmerged-ancestor
// stack (against the ancestors' NEW state) and hands it to the never-discard base-shift
// re-executor, which jj-ASSEMBLES `main + ordered ancestors` LOCALLY and rebases the
// dependent's EXISTING branch onto it IN PLACE — then re-gates it so its OWN
// gate+checker+auditor genuinely re-run against the percolated change. It is the
// `PercolationKickOff` seam the PercolatingCoordinator drives. There is NO
// orchestrator-synthesized `tanren/integ` host ref.
//
// It does NOT verify or absorb here — the re-execution settles (absorb / replan) on
// a LATER coordinator pass once its gate+checker+auditor terminate (never merge
// unverified; never record the absorbed key on a bare re-base). The re-base keeps the
// dependent's OWN branch/work as the base — it is re-pointed, not reset.
//
// A spec-vs-spec assembly conflict is NO LONGER detected here (there is no walk-time host
// build) — it surfaces during the base-shift's LOCAL assembly (fail-closed) and the
// coordinator HOLDS the dependent (the work survives), exactly as the run-bootstrap does.

import {
  type PercolationDecision,
  type PercolationKickOff,
  type PercolationKickOffOutcome,
  type SpeculativeDependent,
} from "../contracts/changePercolation.js";
import type { AncestorStack } from "./ancestorStack.js";

/**
 * Re-resolves a dependent's ordered unmerged-ancestor stack — the real PR-head branches
 * the never-discard base shift will jj-assemble the dependent's shifted base from (DAG
 * order; org-scoped/RLS). The kick-off zips the per-ancestor head shas (the dependent's
 * recorded build-base map) into the resolved triples. A seam so the kick-off is
 * conformance-tested without a DB.
 */
export interface PercolationStackResolver {
  resolveStack(input: {
    projectId: string;
    unmergedAncestorSpecIds: ReadonlyArray<string>;
  }): Promise<ReadonlyArray<{ specId: string; runId: string; branch: string }>>;
}

/**
 * RE-BASES the dependent's EXISTING branch onto the re-resolved shifted base (the
 * never-discard `BaseShiftCoordinator`): it jj-assembles `main + ordered ancestors`
 * locally, rebases in place, and re-gates — KEEPING the dependent's OWN run/branch row.
 * Writes the in-flight marker so the coordinator's settle phase resolves it. A SEAM (not
 * inlined) so the kick-off is conformance-tested without a DB or worker.
 *
 * Returns the re-execution run id (the dependent's OWN run id — never a new run; the
 * settle advances the termination key against that same run).
 */
export interface PercolationReexecutor {
  reexecute(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    decision: PercolationDecision;
    /**
     * The RE-RESOLVED ordered ancestor stack the base shift assembles the shifted base
     * from — `[{ specId, runId, branch, headSha }]` (DAG order). Empty when
     * `nonSpeculative` (every ancestor merged ⇒ a real run against plain `default_branch`).
     */
    ancestorStack: AncestorStack;
    /**
     * The re-execution re-bases onto plain `default_branch` and is genuinely
     * NON-speculative — set when EVERY ancestor has merged (the unmerged subset is empty).
     * The re-exec run carries an EMPTY `ancestor_stack` (a real run against main).
     */
    nonSpeculative: boolean;
  }): Promise<{ reexecRunId: string }>;
}

export interface PercolatingKickOffDeps {
  stackResolver: PercolationStackResolver;
  reexecutor: PercolationReexecutor;
}

export class PercolatingKickOff implements PercolationKickOff {
  constructor(private readonly deps: PercolatingKickOffDeps) {}

  async kickOff(input: {
    projectId: string;
    dependent: SpeculativeDependent;
    decision: PercolationDecision;
    mergedAncestorSpecIds: ReadonlyArray<string>;
  }): Promise<PercolationKickOffOutcome> {
    const { projectId, dependent, decision } = input;

    // DROP the merged ancestors from the stack (§2c "ancestor-merged → proactive
    // re-base"): a merged ancestor's content arrives via FRESH MAIN, so only the
    // UNMERGED ancestors are stacked. When EVERY ancestor has merged this subset is
    // empty and the re-base is onto plain default_branch — a genuinely NON-speculative
    // re-execution.
    const merged = new Set(input.mergedAncestorSpecIds);
    const unmergedAncestorSpecIds = Object.keys(dependent.integratedAncestorShas).filter((id) => !merged.has(id));
    const nonSpeculative = unmergedAncestorSpecIds.length === 0;

    // 1. RE-RESOLVE the ordered unmerged-ancestor stack (the real PR-head branches at
    //    their new heads) + zip in the per-ancestor head shas the dependent recorded (the
    //    divergence key). The base shift assembles `main + ordered ancestors` LOCALLY from
    //    these refs. Empty ⇒ non-speculative (re-based onto plain default_branch).
    const resolved = nonSpeculative
      ? []
      : await this.deps.stackResolver.resolveStack({ projectId, unmergedAncestorSpecIds });
    const ancestorStack: AncestorStack = resolved.map((ancestor) => ({
      specId: ancestor.specId,
      runId: ancestor.runId,
      branch: ancestor.branch,
      headSha: dependent.integratedAncestorShas[ancestor.specId] ?? "",
    }));

    // 2 + 3. RE-BASE the dependent's existing branch onto the re-resolved shifted base
    //        (or onto plain main when non-speculative) IN PLACE AND re-gate it (its
    //        gate+checker+auditor re-run against the change), writing the in-flight
    //        marker. Absorption is deferred to the settle of a later pass — NEVER merge
    //        unverified, NEVER absorb on a bare re-base. A spec-vs-spec assembly conflict
    //        surfaces during the base shift's LOCAL assembly (the coordinator HOLDS).
    const { reexecRunId } = await this.deps.reexecutor.reexecute({
      projectId,
      dependent,
      decision,
      ancestorStack,
      nonSpeculative,
    });
    return { result: "reexecuting", ancestorSpecId: decision.ancestorSpecId, reexecRunId };
  }
}
