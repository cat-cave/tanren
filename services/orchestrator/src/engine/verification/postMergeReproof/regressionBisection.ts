// rv-16b — behavior-aware merge-queue regression bisection. AFTER rv-16a persists a
// post-merge PRODUCTION behavior verdict that REGRESSED (a behavior that previously
// `passed` now records `failed_product` on the live release), this localizes WHICH
// deployed candidate release in the merge window introduced the regression by
// RE-PROVING the failing behavior against candidate states — reusing the rv-11
// {@link AcceptanceOrchestrator} + rv-6 real HTTP driver (see {@link CandidateBehaviorReprover}).
//
// ANTI-COSPLAY / FAIL-CLOSED (the whole point of this node):
//   • Every probe verdict is the REAL orchestrator's fail-closed outcome against a REAL
//     candidate environment — NEVER a fabricated / random / always-first culprit.
//   • A candidate whose environment cannot be re-proven (URL gone, unreachable, plan can't
//     load) yields an `inconclusive` probe → the bisection yields `inconclusive`, it NEVER
//     names a scapegoat. Absence / unobservable / wrong-type fail closed.
//   • A culprit is named ONLY when a REAL adjacent healthy→regressed flip is observed: the
//     culprit re-proves `regressed` AND its immediate predecessor re-proves `healthy`, both
//     by real probes. The 0083 CHECK enforces the same shape at the DB.
//
// The bound is an INTEGER count over the FINITE ordered candidate set (tip + baseline +
// O(log n) binary-search probes + one predecessor confirmation), deduped by a probe cache —
// there is NO wall-clock deadline / iteration cap (timeout-eradication doctrine).

import type { BehaviorVerdictOutcome } from "../../contracts/runtimeVerificationAdapters.js";
import type { BehaviorQuarantineReader } from "../acceptance/behaviorQuarantineGovernance.js";

/** A deployed candidate release the bisection re-proves the failing behavior against. */
export interface CandidateRelease {
  readonly releaseInstanceId: string;
  readonly integrationNodeId: string;
  readonly artifactDigest: string;
  readonly sourceRef: string;
  /** The release's recorded deployment URL (may be superseded/torn-down → unreachable). */
  readonly url: string;
}

/**
 * The ordered candidate window between the last known-good release and the failing release.
 * `candidates` is oldest→newest with the failing release LAST; `baseline` is the known-good
 * anchor release immediately preceding the window (undefined when none is known — then the
 * bisection cannot bracket a flip and fails closed to inconclusive).
 */
export interface CandidateChain {
  readonly candidates: readonly CandidateRelease[];
  readonly baseline: CandidateRelease | undefined;
}

export interface RegressionBisectionTrigger {
  readonly orgId: string;
  readonly projectId: string;
  readonly behaviorRevisionId: string;
  readonly failingReleaseInstanceId: string;
  readonly failingVerdictId: string;
}

/** Reads the ordered candidate window for a regressed behavior (release-chain + verdict history). */
export interface CandidateChainReader {
  read(trigger: RegressionBisectionTrigger): Promise<CandidateChain>;
}

/** Re-proves the failing behavior against ONE candidate release; returns the REAL orchestrator outcome. */
export interface CandidateBehaviorReprover {
  reprove(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly behaviorRevisionId: string;
    readonly candidate: CandidateRelease;
  }): Promise<BehaviorVerdictOutcome>;
}

export type ProbeRole = "tip" | "baseline" | "search" | "predecessor";
export type ProbeClassification = "healthy" | "regressed" | "inconclusive";

export interface BisectionProbe {
  readonly releaseInstanceId: string;
  readonly integrationNodeId: string;
  readonly artifactDigest: string;
  readonly role: ProbeRole;
  readonly outcome: BehaviorVerdictOutcome;
  readonly classification: ProbeClassification;
  readonly reachable: boolean;
}

export type BisectionStatus = "localized" | "inconclusive";

export interface BisectionResult {
  readonly trigger: RegressionBisectionTrigger;
  readonly status: BisectionStatus;
  readonly baselineReleaseInstanceId: string | undefined;
  readonly culprit: CandidateRelease | undefined;
  readonly inconclusiveReason: string | undefined;
  readonly candidateCount: number;
  readonly probes: readonly BisectionProbe[];
}

/** Persists the bisection result (culprit + probe trail, or inconclusive + why). */
export interface RegressionBisectionStore {
  record(result: BisectionResult): Promise<void>;
}

/**
 * Classify a real re-proof outcome. ONLY `passed` is healthy; `failed_product`/`failed_visual`
 * is a genuine product regression; EVERYTHING else — an unreachable/unavailable environment
 * (`inconclusive_*`), a coverage/contract failure (`failed_verification_contract`), a
 * superseded cancel — is `inconclusive` and fails the bisection closed (never a culprit).
 */
export function classifyProbe(outcome: BehaviorVerdictOutcome): ProbeClassification {
  if (outcome === "passed") return "healthy";
  if (outcome === "failed_product" || outcome === "failed_visual") return "regressed";
  return "inconclusive";
}

/**
 * The behavior-aware regression bisector: reads the candidate window, re-proves the failing
 * behavior against candidate states through the REAL executor, localizes the culprit (or fails
 * closed to inconclusive), and persists the sealed result + probe trail.
 */
export class RegressionBisector {
  public constructor(
    private readonly deps: {
      readonly chainReader: CandidateChainReader;
      readonly reprover: CandidateBehaviorReprover;
      readonly store: RegressionBisectionStore;
    },
  ) {}

  public async bisect(trigger: RegressionBisectionTrigger): Promise<BisectionResult> {
    const chain = await this.deps.chainReader.read(trigger);
    const result = await this.localize(trigger, chain);
    await this.deps.store.record(result);
    return result;
  }

  private async localize(trigger: RegressionBisectionTrigger, chain: CandidateChain): Promise<BisectionResult> {
    const probes: BisectionProbe[] = [];
    const cache = new Map<string, ProbeClassification>();
    const baselineId = chain.baseline?.releaseInstanceId;
    const probe = async (candidate: CandidateRelease, role: ProbeRole): Promise<ProbeClassification> => {
      const cached = cache.get(candidate.releaseInstanceId);
      if (cached !== undefined) return cached;
      const outcome = await this.deps.reprover.reprove({
        orgId: trigger.orgId,
        projectId: trigger.projectId,
        behaviorRevisionId: trigger.behaviorRevisionId,
        candidate,
      });
      const classification = classifyProbe(outcome);
      probes.push({
        releaseInstanceId: candidate.releaseInstanceId,
        integrationNodeId: candidate.integrationNodeId,
        artifactDigest: candidate.artifactDigest,
        role,
        outcome,
        classification,
        reachable: outcome !== "inconclusive_infrastructure",
      });
      cache.set(candidate.releaseInstanceId, classification);
      return classification;
    };

    const candidates = chain.candidates;
    const n = candidates.length;
    const inconclusive = (reason: string): BisectionResult => ({
      trigger,
      status: "inconclusive",
      baselineReleaseInstanceId: baselineId,
      culprit: undefined,
      inconclusiveReason: reason,
      candidateCount: n,
      probes,
    });
    if (n === 0) return inconclusive("no deployed candidate releases in the regression window");

    // 1. Reproduce the failure at the tip (the release rv-16a recorded as regressed).
    const tip = candidates[n - 1]!;
    const tipV = await probe(tip, "tip");
    if (tipV !== "regressed") return inconclusive(`tip re-probe did not reproduce the regression (${tipV})`);

    // 2. A localization needs a proven known-good lower anchor to bracket the flip.
    if (chain.baseline === undefined) {
      return inconclusive("no known-good baseline release precedes the regression window");
    }
    const baseV = await probe(chain.baseline, "baseline");
    if (baseV !== "healthy") return inconclusive(`baseline anchor did not re-prove healthy (${baseV})`);

    // 3. Binary search for the FIRST regressed candidate. Invariant: index -1 (baseline) is
    //    healthy and hi is always a regressed position — so the terminal lo is regressed.
    // Data-bounded interval collapse over the FINITE candidate set (not a timeout/attempt cap):
    // the [lo, hi] window strictly narrows each step until the boundary index is isolated.
    let lo = 0;
    let hi = n - 1;
    while (lo !== hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      const midV = await probe(candidates[mid]!, "search");
      if (midV === "inconclusive") {
        return inconclusive(`probe at candidate index ${mid} was inconclusive: cannot bracket the regression`);
      }
      if (midV === "regressed") hi = mid;
      else lo = mid + 1;
    }
    const culprit = candidates[lo]!;

    // 4. Anti-scapegoat: confirm the culprit's immediate predecessor re-proves healthy, so a
    //    named culprit ALWAYS carries a REAL adjacent healthy→regressed flip.
    const predecessor = lo === 0 ? chain.baseline : candidates[lo - 1]!;
    const predV = await probe(predecessor, "predecessor");
    if (predV !== "healthy") {
      return inconclusive(`culprit predecessor did not re-prove healthy (${predV}): cannot confirm the flip`);
    }
    if ((cache.get(culprit.releaseInstanceId) ?? (await probe(culprit, "search"))) !== "regressed") {
      return inconclusive("culprit did not re-prove regressed: cannot confirm the flip");
    }
    return {
      trigger,
      status: "localized",
      baselineReleaseInstanceId: baselineId,
      culprit,
      inconclusiveReason: undefined,
      candidateCount: n,
      probes,
    };
  }
}

/**
 * The live trigger seam. For each post-merge PRODUCTION behavior verdict that REGRESSED
 * (`failed_product`/`failed_visual`), run a bisection bound to the failing release. Every
 * other verdict (passed / inconclusive / contract) is left alone. A no-op when no bisector is
 * wired or the settled job carries no release binding.
 *
 * rv-17: a QUARANTINED behavior is NEVER used to name a culprit. A flaky behavior's "regression"
 * is non-deterministic — bisecting it would re-prove flaky probes and could scapegoat a healthy
 * release, exactly the anti-scapegoat failure rv-16 exists to avoid. When a quarantine reader is
 * wired, a quarantined behavior's regressed verdict is skipped (no bisection produced).
 */
export async function recordRegressionBisections(
  bisector: Pick<RegressionBisector, "bisect"> | undefined,
  result:
    | {
        readonly decision: string;
        readonly verdicts: readonly {
          readonly behaviorRevisionId: string;
          readonly verdictId: string;
          readonly outcome: BehaviorVerdictOutcome;
        }[];
      }
    | undefined,
  job: { readonly orgId: string; readonly projectId: string; readonly releaseInstanceId?: string },
  quarantineReader?: Pick<BehaviorQuarantineReader, "isQuarantined">,
): Promise<readonly BisectionResult[]> {
  if (bisector === undefined || result === undefined || result.decision !== "recorded") return [];
  if (job.releaseInstanceId === undefined) return [];
  const results: BisectionResult[] = [];
  for (const verdict of result.verdicts) {
    if (classifyProbe(verdict.outcome) !== "regressed") continue;
    // A quarantined (flaky) behavior is never bisected — it cannot name a culprit.
    if (
      quarantineReader !== undefined &&
      (await quarantineReader.isQuarantined({ orgId: job.orgId, projectId: job.projectId }, verdict.behaviorRevisionId))
    ) {
      continue;
    }
    results.push(
      await bisector.bisect({
        orgId: job.orgId,
        projectId: job.projectId,
        behaviorRevisionId: verdict.behaviorRevisionId,
        failingReleaseInstanceId: job.releaseInstanceId,
        failingVerdictId: verdict.verdictId,
      }),
    );
  }
  return results;
}
