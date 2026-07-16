import type pg from "pg";
import type { AncestorStack } from "../dag/ancestorStack.js";
import type { BootstrapDependentBaseSuccess } from "../dag/jjLocalBootstrap.js";
import { createLogger } from "../observability/logger.js";
import {
  buildCoverageAuthorityReadyNodeMaterializer,
  type CoverageAuthorityWorkspace,
} from "../runtimeVerification/coverageAuthorityMaterializer.js";
import type { RunPlannerLoopInput } from "./plannerRun.js";

const log = createLogger("jj-local-bootstrap");

/** Exact eager-base node facts captured from the successful jj-local assembly. */
export interface EagerBaseNodeUpsertFacts {
  orgId: string;
  projectId: string;
  baseBranch: string;
  /** The exact cloned base-branch commit, before the local integration commit. */
  baseSha: string;
  ref: string;
  /** Ordered live ancestors; a proven merged-and-dropped ancestor is already in baseSha. */
  members: ReadonlyArray<{ specId: string; runId: string; branch: string; headSha: string }>;
  headSha: string;
  treeHash: string;
}

/**
 * The eager producer receives the still-open authoritative workspace separately from facts;
 * it never accepts changed targets. The production implementation derives those itself.
 */
export type EagerBaseNodeUpsert = (
  facts: EagerBaseNodeUpsertFacts,
  workspace: CoverageAuthorityWorkspace,
) => Promise<void>;

/** Build the Pg-backed eager producer over the sole coverage-authority materializer. */
export function buildEagerBaseNodeUpsert(pool: pg.Pool): EagerBaseNodeUpsert {
  const materialize = buildCoverageAuthorityReadyNodeMaterializer(pool);
  return async (facts, workspace) => {
    await materialize({
      projectId: facts.projectId,
      orgId: facts.orgId,
      baseBranch: facts.baseBranch,
      baseSha: facts.baseSha,
      ref: facts.ref,
      purpose: "eager_base",
      members: facts.members,
      headSha: facts.headSha,
      treeHash: facts.treeHash,
      workspace,
    });
  };
}

/**
 * Observe the clean eager assembly through the production authority producer. A materializer
 * failure is loud but remains non-fatal to the writer run; critically, its transaction cannot
 * leave a ready row with an empty or stale authority stamp.
 */
export async function recordEagerBaseNode(
  upsert: EagerBaseNodeUpsert,
  input: RunPlannerLoopInput,
  stack: AncestorStack,
  bootstrapped: BootstrapDependentBaseSuccess,
): Promise<void> {
  const orgId = input.context.orgId;
  if (orgId === undefined || orgId === null) return;
  const members = stack.flatMap((ancestor) => {
    const headSha = bootstrapped.memberHeadShas[ancestor.specId];
    // An absent SHA is the proven merged-and-dropped race arm: its content is already
    // represented by the exact cloned baseSha, so it is not a live integrated member.
    return headSha === undefined
      ? []
      : [{ specId: ancestor.specId, runId: ancestor.runId, branch: ancestor.branch, headSha }];
  });
  try {
    await upsert(
      {
        orgId,
        projectId: input.context.projectId,
        baseBranch: input.context.targetBranch,
        baseSha: bootstrapped.baseSha,
        ref: bootstrapped.localRef,
        members,
        headSha: bootstrapped.headSha,
        treeHash: bootstrapped.treeHash,
      },
      {
        ssh: input.ssh,
        target: bootstrapped.live.target,
        workspacePath: bootstrapped.live.workspacePath,
      },
    );
  } catch (error) {
    log.warn(
      "observe-only eager_base integration-node materialization failed (non-fatal)",
      { runBranch: input.context.runBranch, projectId: input.context.projectId },
      error,
    );
  }
}
