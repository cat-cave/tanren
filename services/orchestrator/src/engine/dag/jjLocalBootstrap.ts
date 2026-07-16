// JJ-LOCAL BOOTSTRAP ASSEMBLY (walker-jj-local-integration-design.md §2.1, §7 PR-3).
//
// The DEPENDENT-RUN counterpart of the batch path's `withJjLocalIntegration`
// (`jjLocalIntegration.ts`). The batch path opens a throwaway gate workspace,
// stacks the ordered members, runs the gate on that workspace, and RELEASES — it
// never hands the assembled state to a new runner, which is why it never needed a
// host-fetchable base ref.
//
// A dependent SPECULATIVE run instead needs its base to BECOME the workspace the
// writer commits onto (§1.2 — "the runner is already where the clone happens; we
// replace its single-ref clone with a multi-ref jj assembly over that same
// runner"). So the bootstrap variant differs from the batch consumer in exactly ONE
// way: its continuation, instead of "run the gate then release", is "create the
// dependent's run branch AT the integrated head, then KEEP the open workspace for
// the caller (the writer loop), releasing at RUN END". The assembled workspace
// BECOMES the run's workspace — not a throwaway gate workspace.
//
// It REUSES `integrateOverWorkspace` + `buildLiveJjWorkspace` wholesale: the
// stack-rebase loop (the §3.5 bookmark-prep + `rebaseOnto` stacking + the
// clean-export materialization) is NOT duplicated here. The ONE new step is the run
// branch creation at the integrated head (`core.branch(ws, runBranch, localRef)`):
// the dependent's PR head therefore already carries the ancestor stack as its
// history prefix (design F3 — real ancestor commits, jj-native, no synthesized base
// object), exactly what a human stacking PRs would have.
//
// A spec-vs-spec ASSEMBLY conflict surfaces the SAME `conflict` outcome the batch
// path returns (the `JjLocalIntegrationResult` conflict shape), so the existing
// walker HOLD/route control flow (§2.1.4, `walker.ts` HOLD-the-dependent) consumes
// it unchanged when PR-4 wires this in.
//
// ADDITIVE (§7 PR-3): this seam is built + conformance-pinned and wired into the
// run path when the ancestor stack is non-empty. The plain default-branch clone
// path is taken for an empty stack.
//
// FAIL-CLOSED: a spec-vs-spec conflict during assembly RELEASES the workspace (there
// is nothing to hand off) and returns the conflict; only a CLEAN assembly keeps the
// workspace open and hands its `release` to the caller. An assembly that integrates
// but fails to surface the open workspace handle is a LOUD throw (never a run branch
// created against a phantom workspace).

import type { AncestorStack } from "./ancestorStack.js";
import { buildLiveJjWorkspace, type LiveJjWorkspace, type LiveJjWorkspaceDeps } from "../providers/liveJjWorkspace.js";
import { SpeculativeAssemblyError } from "./speculativeAssemblyError.js";
import {
  type AncestorSpecPhase,
  type JjIntegrationMember,
  type JjLocalIntegrationInput,
  type JjLocalIntegrationResult,
  integrateOverWorkspace,
} from "./jjLocalIntegration.js";

/**
 * The ancestor SPEC lifecycle bucket per ancestor spec id, captured at bootstrap time (the
 * caller reads it from `specs.status` via `classifySpecStatus`). Threaded into the assembly
 * so the "ancestor branch gone, not merged" case can distinguish a BENIGN race (the ancestor
 * spec is still `pending`/`in_flight` and WILL publish a head) from a LOUD fault (a TERMINAL
 * ancestor that never will). A spec ABSENT from the map ⇒ the fail-closed default (loud).
 */
export type AncestorPhaseBySpecId = ReadonlyMap<string, AncestorSpecPhase>;

/** The local bookmark name the dependent's prospective base materializes as (NEVER pushed). */
export function bootstrapLocalIntegrationRef(runBranch: string): string {
  return `tanren-local-bootstrap-${runBranch.replaceAll(/[^A-Za-z0-9_-]/gu, "_")}`;
}

/** The facts the bootstrap assembly clones + stacks the dependent's base against. */
export interface BootstrapDependentBaseInput {
  /** The repo URL the workspace clones (the SAME the run's facts carry). */
  repoUrl: string;
  /** The default branch the stack assembles ONTO (`main` — the real history root). */
  baseBranch: string;
  /** The dependent's run branch (`runs.branch`) — created AT the assembled head. */
  runBranch: string;
}

/**
 * A successfully bootstrapped dependent base: the OPEN workspace (the writer commits
 * onto it; the caller MUST `release` it at run end), the dependent's run branch
 * (created at the integrated head), the materialized integrated head sha + tree hash
 * (the assembled `main + ancestors` content identity), the per-ancestor pristine
 * head shas (the divergence key — the same the batch node keys on), and the LOCAL
 * assembly bookmark name (NEVER a host ref).
 */
export interface BootstrapDependentBaseSuccess {
  outcome: "bootstrapped";
  /** The OPEN workspace the run branch lives in — handed to the writer loop. */
  live: LiveJjWorkspace;
  /** Release the workspace's runner — the caller runs this at RUN END (LOUD on a leak). */
  release: () => Promise<void>;
  /** The dependent's run branch, created at the assembled head. */
  runBranch: string;
  /** The LOCAL assembly bookmark the stack materialized as (NEVER pushed to the host). */
  localRef: string;
  /** The exact cloned base-branch commit the ancestor stack was assembled over. */
  baseSha: string;
  /**
   * The assembled integrated head sha (`main + ordered ancestors`) — the dependent's run
   * branch was created AT it (the run branch is a distinct commit whose PARENT is this
   * head; the writer's first commit lands on the run branch). It is the dependent's base
   * sha — the divergence point its PR delta is measured against.
   */
  headSha: string;
  /** The assembled head's git tree hash (the content identity proof reuse keys on). */
  treeHash: string;
  /** The pristine per-ancestor PR-head shas captured at assembly time (the divergence key). */
  memberHeadShas: Record<string, string>;
}

/**
 * The outcome of `bootstrapDependentBase`. On `bootstrapped`: the open workspace +
 * run branch (above). On `conflict`: the SAME spec-vs-spec conflict shape the batch
 * path returns — the walker HOLDS the dependent + routes the ancestor pair to the
 * resolver (the workspace is released; nothing was handed off).
 */
export type BootstrapDependentBaseResult =
  | BootstrapDependentBaseSuccess
  | Extract<JjLocalIntegrationResult, { outcome: "conflict" }>;

/**
 * Map an ordered ancestor stack to the ordered jj-local integration members. The ancestor's
 * `headSha` (`ancestor_stack[].headSha`) rides through as `knownHeadSha` so the assembly can
 * PROVE a merged-and-deleted ancestor (its commit now in the base) and drop it rather than
 * crash on the vanished branch (the never-discard mid-flight-merge race, §3) — an empty
 * placeholder sha simply makes a genuinely-missing branch stay a loud failure.
 *
 * The ancestor's SPEC lifecycle bucket (from `phaseBySpecId`) rides through as `ancestorPhase`
 * so the "branch gone, not merged" case can benign-WAIT (re-driven) when the ancestor spec is
 * still non-terminal, instead of TERMINALLY stranding the dependent. A spec ABSENT from the
 * map ⇒ no `ancestorPhase` ⇒ the assembly's fail-closed default (the loud throw).
 */
function membersForStack(stack: AncestorStack, phaseBySpecId: AncestorPhaseBySpecId): JjIntegrationMember[] {
  return stack.map((ancestor) => {
    const phase = phaseBySpecId.get(ancestor.specId);
    return {
      specId: ancestor.specId,
      branch: ancestor.branch,
      ...(ancestor.headSha !== "" && { knownHeadSha: ancestor.headSha }),
      ...(phase !== undefined && { ancestorPhase: phase }),
    };
  });
}

/**
 * The live-jj-workspace opener the bootstrap allocates against. Defaults to the real
 * A1-backed {@link buildLiveJjWorkspace} (a runner allocation + authenticated clone);
 * injected as a port so the conformance can drive the FULL bootstrap (assembly + run
 * branch + keep-open/release) over a LOCAL jj workspace WITHOUT allocating a runner.
 */
export type BuildBootstrapWorkspacePort = (deps: LiveJjWorkspaceDeps) => Promise<LiveJjWorkspace>;

/**
 * Bootstrap a dependent speculative run's base by jj-assembling `main + ordered
 * ancestor PR-head refs` LOCALLY on the dependent's allocated runner, then creating
 * the dependent's run branch AT the assembled head — and KEEPING the workspace open
 * for the writer loop (the §2.1 bootstrap variant).
 *
 * Reuses `buildLiveJjWorkspace` + `integrateOverWorkspace` wholesale (the §3.5
 * bookmark-prep + `rebaseOnto` stacking + clean-export materialization). The ONE new
 * step is `core.branch(ws, runBranch, localRef)` — the run branch at the integrated
 * head, so the dependent's PR head carries the ancestor stack as its history prefix
 * (design F3).
 *
 * `workspaceDeps` are A1's live-jj-workspace deps (the SAME thread the batch path +
 * conflict resolver + base-shift use) — they ALREADY allocate the runner the run is
 * to use, so the assembly happens on the run's own runner (no extra allocation).
 *
 * RELEASE OWNERSHIP: on a CLEAN assembly the workspace stays OPEN and its `release`
 * is handed to the caller (the writer loop runs it at run end). On a spec-vs-spec
 * conflict (nothing to hand off) OR any throw, the workspace is RELEASED here before
 * returning/re-throwing — never a leaked runner.
 */
export async function bootstrapDependentBase(
  stack: AncestorStack,
  workspaceDeps: LiveJjWorkspaceDeps,
  input: BootstrapDependentBaseInput,
  phaseBySpecId: AncestorPhaseBySpecId,
  buildWorkspace: BuildBootstrapWorkspacePort = buildLiveJjWorkspace,
): Promise<BootstrapDependentBaseResult> {
  const localRef = bootstrapLocalIntegrationRef(input.runBranch);
  const integrationInput: JjLocalIntegrationInput = {
    baseBranch: input.baseBranch,
    repoUrl: input.repoUrl,
    members: membersForStack(stack, phaseBySpecId),
    localRef,
  };

  const live = await buildWorkspace(workspaceDeps);
  let keepOpen = false;
  try {
    const integration = await integrateOverWorkspace(live, workspaceDeps.ssh, integrationInput);
    if (integration.outcome === "conflict") {
      // Nothing to hand off — the walker HOLDS the dependent + routes the pair. The
      // workspace is released in the `finally` (keepOpen stays false).
      return integration;
    }
    // The CLEAN assembly's open workspace handle must be present (the real
    // `integrateOverWorkspace` always surfaces it) — a run branch is NEVER created
    // against a phantom workspace.
    const workspace = integration.workspace;
    if (workspace === undefined) {
      throw new SpeculativeAssemblyError(
        "phantom_workspace",
        `jj-local bootstrap: assembly of ${input.runBranch} on ${input.baseBranch} did not surface an open workspace handle`,
      );
    }
    // The ONE new step: create the dependent's run branch AT the integrated head
    // (`localRef`), so the writer commits onto a branch whose history prefix IS the
    // assembled `main + ordered ancestors` (design F3 — real ancestor commits).
    await live.core.branch(workspace, input.runBranch, integration.localRef);
    keepOpen = true;
    return {
      outcome: "bootstrapped",
      live,
      release: live.release,
      runBranch: input.runBranch,
      localRef: integration.localRef,
      baseSha: integration.baseSha,
      headSha: integration.headSha,
      treeHash: integration.treeHash,
      memberHeadShas: integration.memberHeadShas,
    };
  } finally {
    // The workspace stays OPEN only on a clean assembly (handed to the writer loop);
    // every other path (conflict, throw) releases it — never a leaked runner.
    if (!keepOpen) {
      await live.release();
    }
  }
}
