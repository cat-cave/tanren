// PROOF REUSE (tanren-owns-the-engine.md §3 — the least-repeated-work primitive),
// Wave-3 / Slice-3a. CORRECTNESS-CRITICAL: this decides, at the gate/CI verdict site
// and BEFORE the gate runs, whether a recorded proof can be REUSED (skip the re-gate)
// or the gate MUST be recomputed. A wrong REUSE here would merge UNPROVEN code, so the
// whole module is FAIL-CLOSED: it reuses a proof ONLY when ALL SIX `proofReuseKey`
// components are resolvable AND match a recorded PASSING proof EXACTLY; ANY uncertainty
// — an unresolvable key component, a cache MISS, or a non-passing recorded verdict —
// forces a RECOMPUTE, never a stale reuse.
//
// THE SIX-COMPONENT GUARD (the load-bearing safety invariant): the `proofReuseKey` is
// `hash(memberKey, gateConfigHash, policyVersion, runnerImage, appEnvHash,
// quarantineVersion)` (the FROZEN pure function in contracts/integrationNodes.ts). A
// verdict is sound ONLY if the thing proven (the integrated content — `memberKey`) AND
// the way it was proven (the gate config, policy, runner image, app env, quarantine
// set) are IDENTICAL. So this module never trusts a partially-known key: each component
// is passed in as a {@link KeyComponent} that is EITHER a resolved value OR an explicit
// `unresolvable` — and a single `unresolvable` short-circuits to RECOMPUTE (the gate
// runs) WITHOUT even looking up a proof. There is no "best-effort" reuse.
//
// This module is PURE of I/O at the decision boundary (it takes a `findProof` port + an
// `emit` port) so the six-component guard + the passing-only rule are unit-asserted
// directly, the way correctness demands.

import { type IntegrationNode, type ProofReuseKeyInput, proofReuseKey } from "../contracts/integrationNodes.js";

/**
 * One component of the {@link ProofReuseKeyInput}, resolved from the LIVE gate inputs.
 * It is EITHER a concrete value OR an explicit `unresolvable` — the fail-closed shape:
 * a caller that cannot resolve a component (a missing runner image, an unreadable gate
 * config) hands back `{ resolved: false }`, NEVER a fabricated default. A single
 * unresolvable component forces a recompute (the safety invariant: never reuse on an
 * unknown key).
 */
export type KeyComponent =
  | { readonly resolved: true; readonly value: string }
  | { readonly resolved: false; readonly reason: string };

/** A resolved key component (a concrete value). */
export function resolvedComponent(value: string): KeyComponent {
  return { resolved: true, value };
}

/** An UNRESOLVABLE key component (fail-closed: forces a recompute, never a reuse). */
export function unresolvableComponent(reason: string): KeyComponent {
  return { resolved: false, reason };
}

/**
 * The six LIVE key components, each resolved-or-unresolvable. The `memberKey` is the
 * node's already-computed integrated-content identity (it is on the node — never
 * unresolvable here); the other five are resolved from the live gate context. They are
 * carried as {@link KeyComponent}s so a single unresolvable one fails the whole key
 * CLOSED (recompute).
 */
export interface LiveProofKeyComponents {
  gateConfigHash: KeyComponent;
  policyVersion: KeyComponent;
  runnerImage: KeyComponent;
  appEnvHash: KeyComponent;
  quarantineVersion: KeyComponent;
}

/** The proof-store port (the pg model's `findProof`/`recordProof`, narrowed). */
export interface ProofStorePort {
  /** Look up a reusable proof by its full six-component reuse key; MISS ⇒ undefined. */
  findProof(orgId: string, reuseKey: string): Promise<{ nodeId: string; verdict: string } | undefined>;
  /** Record a gate/CI proof on a node, keyed by the full reuse key. */
  recordProof(input: {
    orgId: string;
    projectId: string;
    nodeId: string;
    keyInput: ProofReuseKeyInput;
    verdict: string;
    evidence?: unknown;
  }): Promise<string>;
}

/** The `integration.proof.reused` emit port (a narrowed event-append). */
export type ProofReusedEmitter = (payload: {
  nodeId: string;
  recordedOnNodeId: string;
  memberKey: string;
  proofReuseKey: string;
}) => Promise<void>;

/** The verdict string a PASSING proof records (only this short-circuits the gate). */
export const PASSING_VERDICT = "passed";

/**
 * The decision: REUSE a recorded passing proof (skip the gate) or RECOMPUTE (run it).
 * On `reuse` the `proofReuseKey` + the recording node are carried for the audit trail;
 * on `recompute` the `reason` names WHY (a key component was unresolvable, the cache
 * missed, or the recorded verdict was not passing) and `keyInput` (present unless a key
 * component was unresolvable) is what a post-gate {@link recordProofVerdict} records under.
 */
export type ProofReuseDecision =
  | { kind: "reuse"; proofReuseKey: string; recordedOnNodeId: string; memberKey: string }
  | { kind: "recompute"; reason: string; keyInput?: ProofReuseKeyInput };

/**
 * Decide REUSE vs RECOMPUTE, FAIL-CLOSED. The order enforces the safety invariant:
 *   1. The six-component guard FIRST — if ANY of the five live components is
 *      unresolvable, RECOMPUTE immediately WITHOUT a lookup (`keyInput` omitted: there
 *      is no sound key to record under either; the post-gate recorder also no-ops). An
 *      unknown key can NEVER reuse.
 *   2. Compute the full `proofReuseKey` from the node's `memberKey` + the five resolved
 *      components, then `findProof`.
 *   3. A cache MISS ⇒ RECOMPUTE.
 *   4. A HIT whose recorded verdict is NOT `passed` ⇒ RECOMPUTE (only a passing verdict
 *      short-circuits; a failing/unknown recorded verdict is never reused).
 *   5. A HIT with a PASSING verdict ⇒ REUSE (emit `integration.proof.reused`).
 * The emit happens HERE on reuse so the skip is always narrated; the caller then skips
 * the gate. On recompute the caller runs the gate and calls {@link recordProofVerdict}.
 */
export async function decideProofReuse(input: {
  orgId: string;
  node: IntegrationNode;
  components: LiveProofKeyComponents;
  store: ProofStorePort;
  emit: ProofReusedEmitter;
}): Promise<ProofReuseDecision> {
  const { orgId, node, components, store, emit } = input;

  // 1. THE SIX-COMPONENT GUARD (fail-closed): a single unresolvable component forces a
  //    recompute with NO lookup. The node's memberKey is always resolved (it is the
  //    node's identity); the five live components must ALL resolve.
  const keyInput = buildKeyInput(node.memberKey, components);
  if (keyInput === undefined) {
    return {
      kind: "recompute",
      reason: `a proof-reuse key component is unresolvable — fail closed (never reuse on an unknown key): ${unresolvableReason(components)}`,
    };
  }

  // 2. The full six-component key, then the lookup.
  const key = proofReuseKey(keyInput);
  const found = await store.findProof(orgId, key);

  // 3. MISS ⇒ recompute.
  if (found === undefined) {
    return { kind: "recompute", reason: "no recorded proof for this six-component key (cache miss)", keyInput };
  }

  // 4. A non-passing recorded verdict is NEVER reused (only a passing verdict clears).
  if (found.verdict !== PASSING_VERDICT) {
    return {
      kind: "recompute",
      reason: `recorded proof verdict is '${found.verdict}' — only '${PASSING_VERDICT}' is reused`,
      keyInput,
    };
  }

  // 5. HIT + PASSING ⇒ reuse. Narrate the skip, then short-circuit the gate.
  await emit({ nodeId: node.nodeId, recordedOnNodeId: found.nodeId, memberKey: node.memberKey, proofReuseKey: key });
  return { kind: "reuse", proofReuseKey: key, recordedOnNodeId: found.nodeId, memberKey: node.memberKey };
}

/**
 * Record the gate's verdict as a proof AFTER a RECOMPUTE ran the gate. No-ops when the
 * decision carried no `keyInput` (a key component was unresolvable — there is no sound
 * key to record under, so we never persist a proof under a half-known key). The verdict
 * is recorded VERBATIM (`passed` only when the gate actually passed) so a future reuse's
 * passing-only rule is honest.
 */
export async function recordProofVerdict(input: {
  decision: ProofReuseDecision;
  store: ProofStorePort;
  orgId: string;
  projectId: string;
  node: IntegrationNode;
  passed: boolean;
  evidence?: unknown;
}): Promise<void> {
  if (input.decision.kind !== "recompute" || input.decision.keyInput === undefined) {
    return;
  }
  await input.store.recordProof({
    orgId: input.orgId,
    projectId: input.projectId,
    nodeId: input.node.nodeId,
    keyInput: input.decision.keyInput,
    verdict: input.passed ? PASSING_VERDICT : "failed",
    ...(input.evidence !== undefined && { evidence: input.evidence }),
  });
}

/**
 * Build the full {@link ProofReuseKeyInput} from the node's memberKey + the five live
 * components — or `undefined` if ANY component is unresolvable (the fail-closed
 * short-circuit). PURE.
 */
function buildKeyInput(memberKey: string, c: LiveProofKeyComponents): ProofReuseKeyInput | undefined {
  if (
    !c.gateConfigHash.resolved ||
    !c.policyVersion.resolved ||
    !c.runnerImage.resolved ||
    !c.appEnvHash.resolved ||
    !c.quarantineVersion.resolved
  ) {
    return undefined;
  }
  return {
    memberKey,
    gateConfigHash: c.gateConfigHash.value,
    policyVersion: c.policyVersion.value,
    runnerImage: c.runnerImage.value,
    appEnvHash: c.appEnvHash.value,
    quarantineVersion: c.quarantineVersion.value,
  };
}

/** Name the first unresolvable component (for the recompute reason). PURE. */
function unresolvableReason(c: LiveProofKeyComponents): string {
  const entries: ReadonlyArray<readonly [string, KeyComponent]> = [
    ["gateConfigHash", c.gateConfigHash],
    ["policyVersion", c.policyVersion],
    ["runnerImage", c.runnerImage],
    ["appEnvHash", c.appEnvHash],
    ["quarantineVersion", c.quarantineVersion],
  ];
  for (const [name, comp] of entries) {
    if (!comp.resolved) {
      return `${name} (${comp.reason})`;
    }
  }
  return "none";
}
