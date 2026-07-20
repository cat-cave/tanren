// The `integration_nodes` TYPED SHAPE (tanren-owns-the-engine.md §3) — the ONE run
// model. There is one run: work on a base branch that may shift. The base is
// `main + an ordered set of not-yet-landed ancestor branches` — an INTEGRATION
// NODE. The SAME object is an eager dependent build, a merge-queue batch, and a
// stacked/chain PR; this kills the speculative-vs-real and eager-vs-unrelated
// divergence (§7 deletes the two divergent base-shift handlers → one).
//
// WHY a typed shape NOW (no DB migration — Wave 2 persists it): Wave 0 is the
// design freeze. The pure functions `memberKey` + `proofReuseKey` are the durable
// asset the never-discard rebase + the proof-reuse cache are built on, so they ship
// + are unit-tested now even though the table does not yet exist. The guardrail
// (§7) — migrate the old `speculative_base` + percolation/merge events through an
// explicit compatibility read-model, not silent abandonment — lands in Wave 2.

import { createHash } from "node:crypto";

// An unambiguous separator between hashed components so distinct member-boundary
// placements (e.g. ["ab","c"] vs ["a","bc"]) can never collide into the same key.
// A newline never appears in a git sha or a config hash, and (unlike a NUL) keeps
// this source file clean ASCII text.
const MEMBER_SEPARATOR = "\n";

/**
 * What an integration node IS, in the unified run model:
 *   - `eager_base`   — an eager dependent's dynamic base (main + its unmerged
 *                      ancestors): the dependent's run is created against this.
 *   - `eager_beam`   — a bounded mq-8 build-only frontier (ancestors + an already
 *                      published dependent head), never a merge or land candidate.
 *   - `merge_batch`  — a speculative merge-queue batch (several ready heads merged
 *                      together) the gate proves once before the real land.
 *   - `stack_head`   — the head of a stacked / chain PR.
 *   - `bisect_prefix`— a prefix node a bisection reads a reusable prefix proof from.
 *   - `pre_merge_preview` — an ephemeral node the OPT-IN pre-merge behavior gate (rv-premerge)
 *                      binds a candidate's preview `verification_environments` row to, so a
 *                      `pre_merge` acceptance run has a real node FK before merge. Run-unique
 *                      (member_key keyed on the run), never assembled by the merge coordinator.
 * All are the SAME object; the purpose only labels intent, never branches the path.
 */
/** The purpose vocabulary as a tuple (the read seam validates a raw column against it). */
export const INTEGRATION_NODE_PURPOSES = [
  "eager_base",
  "eager_beam",
  "merge_batch",
  "stack_head",
  "bisect_prefix",
  "pre_merge_preview",
] as const;
export type IntegrationNodePurpose = (typeof INTEGRATION_NODE_PURPOSES)[number];

/**
 * One ordered member of an integration node: the (spec, run) whose `branch` (at
 * `headSha`) is merged in. Order is DAG order (ancestors before dependents) and is
 * LOAD-BEARING — `memberKey` hashes the ordered member shas, so reordering members
 * is a different node (a different proof).
 */
export interface IntegrationNodeMember {
  specId: string;
  runId: string;
  branch: string;
  headSha: string;
}

/**
 * The typed shape of an `integration_nodes` row (Wave 2 persists it). It carries
 * everything the never-discard rebase + proof-reuse reason over:
 *   - `nodeId`              — the node's stable identity.
 *   - `baseBranch`/`baseSha`— the real base (`main`) the node is built ON, at a SHA.
 *   - `ref`                 — the ephemeral git ref the node materializes as.
 *   - `purpose`             — the intent label (never branches control flow).
 *   - `members`             — the ordered members merged into the base.
 *   - `memberKey`           — `hash(baseSha + ordered member shas)`: identity of the
 *                             integrated CONTENT (the proof-reuse cache's primary key).
 *   - `gateConfigHash`/`policyVersion` — the gate + posture inputs a proof is keyed
 *                             on, so a proof is only reused when policy is identical.
 *   - `affectedFingerprint`— the affected-tier fingerprint (Wave-3 tier skipping).
 *   - `headSha`/`treeHash` — the materialized node's head + tree (when built).
 *   - `status`             — the node's lifecycle (building → ready → landed → stale).
 */
export interface IntegrationNode {
  nodeId: string;
  baseBranch: string;
  baseSha: string;
  ref: string;
  purpose: IntegrationNodePurpose;
  members: ReadonlyArray<IntegrationNodeMember>;
  memberKey: string;
  gateConfigHash: string;
  policyVersion: string;
  affectedFingerprint: string;
  headSha?: string;
  treeHash?: string;
  status: IntegrationNodeStatus;
}

/** The lifecycle status of an integration node. */
export const INTEGRATION_NODE_STATUSES = ["building", "ready", "landed", "stale"] as const;
export type IntegrationNodeStatus = (typeof INTEGRATION_NODE_STATUSES)[number];

/**
 * PURE: the MEMBER KEY — `hash(baseSha + ordered member shas)`. This is the
 * identity of the integrated CONTENT: the same base + the same ordered member
 * heads always yield the same key, so a batch proof carries into the real merge and
 * a bisection reads a prefix node's proof. Order is LOAD-BEARING (it is a list, not
 * a set) — a different order is a different integration, hence a different key.
 */
export function memberKey(baseSha: string, orderedMemberShas: ReadonlyArray<string>): string {
  const h = createHash("sha256");
  h.update(baseSha);
  for (const sha of orderedMemberShas) {
    h.update(MEMBER_SEPARATOR);
    h.update(sha);
  }
  return h.digest("hex");
}

/** The full set of inputs a gate/CI proof is keyed on (`proofReuseKey`). */
export interface ProofReuseKeyInput {
  /** Identity of the integrated content (`memberKey`). */
  memberKey: string;
  /** The gate config the proof was produced under. */
  gateConfigHash: string;
  /** The posture/policy version the proof was produced under. */
  policyVersion: string;
  /** The runner image the proof ran on (a different image is a different proof). */
  runnerImage: string;
  /** The app-environment hash (env that affects the build/test). */
  appEnvHash: string;
  /** The quarantine (flaky-skip) set version in effect. */
  quarantineVersion: string;
}

/**
 * PURE: the PROOF-REUSE KEY (§3 proof reuse). A gate/CI verdict on a node is reused
 * ONLY when EVERY component matches: the integrated content (`memberKey`), the gate
 * config, the policy version, the runner image, the app-env, and the quarantine
 * version. WHY all six: a verdict is only sound if the thing proven AND the way it
 * was proven are identical — any drift (a new gate rule, a new runner image, a
 * changed quarantine set) must force a recompute, never a stale reuse.
 */
export function proofReuseKey(input: ProofReuseKeyInput): string {
  const h = createHash("sha256");
  for (const part of [
    input.memberKey,
    input.gateConfigHash,
    input.policyVersion,
    input.runnerImage,
    input.appEnvHash,
    input.quarantineVersion,
  ]) {
    h.update(part);
    h.update(MEMBER_SEPARATOR);
  }
  return h.digest("hex");
}
