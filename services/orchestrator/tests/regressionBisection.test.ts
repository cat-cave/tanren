// rv-16b unit proof: the behavior-aware regression bisector localizes the culprit release by
// RE-PROVING the failing behavior through the REAL rv-11 AcceptanceOrchestrator + rv-6
// HttpAcceptanceSurfaceDriver (an injected fetch stands in for the network, but the driver,
// assertion algebra, and fail-closed outcome resolution are the REAL production code — the
// probe verdict is NOT a mock). It proves the anti-cosplay guarantees:
//   1. A real healthy→regressed flip localizes the culprit.
//   2. An unreachable candidate probe is inconclusive → the bisection REFUSES to name a culprit.
//   3. A tip that no longer reproduces, or a baseline that is not healthy, fails closed.

import { describe, expect, it } from "vitest";
import { compileAcceptancePlan } from "../src/engine/verification/acceptance/index.js";
import type { AcceptancePlan } from "../src/engine/verification/acceptance/index.js";
import type { HttpFetch, HttpResponseLike } from "../src/engine/verification/acceptance/httpDriver.js";
import {
  RealCandidateBehaviorReprover,
  RecordedUrlCandidateEnvironmentResolver,
} from "../src/engine/verification/postMergeReproof/candidateReprover.js";
import {
  RegressionBisector,
  type BisectionResult,
  type CandidateChain,
  type CandidateChainReader,
  type CandidateRelease,
  type RegressionBisectionStore,
} from "../src/engine/verification/postMergeReproof/regressionBisection.js";

const ORG = "org_rb";
const PROJECT = "project_rb";
const BEHAVIOR = "br_rb";
const DIGEST = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;

const ACCEPTANCE = {
  version: "v1" as const,
  httpProbes: [{ probeId: "p1", method: "GET", path: "health" }],
  assertions: [{ assertionId: "a1", subject: "p1.status", comparisonOperator: "equals" as const, expected: 200 }],
};

function planLoader(): { loadPlans: () => Promise<readonly AcceptancePlan[]> } {
  const plan = compileAcceptancePlan({
    id: BEHAVIOR,
    personaRevisionId: "persona_revision_bisect",
    behaviorRevisionHash: `sha256:${"a".repeat(64)}`,
    acceptance: ACCEPTANCE,
  });
  return { loadPlans: () => Promise.resolve([plan]) };
}

// A fetch that returns a REAL response shape keyed by which candidate host is being probed.
// `healthy` → 200 (assertion passes → passed), `regressed` → 500 (assertion fails → failed_product),
// `unreachable` → throw (network error → the driver fails closed to inconclusive_infrastructure).
function fetchBy(states: Record<string, "healthy" | "regressed" | "unreachable">): HttpFetch {
  return async (url) => {
    const host = new URL(url).host;
    const state = states[host];
    if (state === undefined || state === "unreachable") throw new Error(`ECONNREFUSED ${host}`);
    const status = state === "healthy" ? 200 : 500;
    const response: HttpResponseLike = {
      status,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify({ ok: state === "healthy" })),
    };
    return response;
  };
}

function candidate(host: string, index: number): CandidateRelease {
  return {
    releaseInstanceId: `ri_${host}`,
    integrationNodeId: `inode_${host}`,
    artifactDigest: DIGEST(index),
    sourceRef: `${host}-sha`,
    url: `http://${host}/`,
  };
}

function chainReader(chain: CandidateChain): CandidateChainReader {
  return { read: () => Promise.resolve(chain) };
}

function captureStore(): { store: RegressionBisectionStore; recorded: BisectionResult[] } {
  const recorded: BisectionResult[] = [];
  return {
    recorded,
    store: {
      // eslint-disable-next-line @typescript-eslint/require-await
      record: async (result) => {
        recorded.push(result);
      },
    },
  };
}

function bisector(chain: CandidateChain, fetchImpl: HttpFetch, store: RegressionBisectionStore): RegressionBisector {
  return new RegressionBisector({
    chainReader: chainReader(chain),
    reprover: new RealCandidateBehaviorReprover({
      planLoader: planLoader(),
      environmentResolver: new RecordedUrlCandidateEnvironmentResolver(),
      fetchImpl,
    }),
    store,
  });
}

const TRIGGER = {
  orgId: ORG,
  projectId: PROJECT,
  behaviorRevisionId: BEHAVIOR,
  failingReleaseInstanceId: "ri_c3",
  failingVerdictId: "verdict_fail_rb",
};

describe("rv-16b behavior-aware regression bisection (real executor + real driver)", () => {
  it("localizes the culprit at the REAL healthy→regressed flip, proven by real HTTP probes", async () => {
    const base = candidate("good", 1);
    const c1 = candidate("c1", 2);
    const c2 = candidate("c2", 3);
    // c3 is the failing tip.
    const c3 = candidate("c3", 4);
    const chain: CandidateChain = { candidates: [c1, c2, c3], baseline: base };
    const { store, recorded } = captureStore();
    const result = await bisector(
      chain,
      fetchBy({ good: "healthy", c1: "healthy", c2: "regressed", c3: "regressed" }),
      store,
    ).bisect(TRIGGER);

    expect(result.status).toBe("localized");
    expect(result.culprit?.releaseInstanceId).toBe("ri_c2");
    expect(result.inconclusiveReason).toBeUndefined();
    // The named culprit re-proved regressed AND its predecessor re-proved healthy — both real probes.
    const culpritProbe = result.probes.find((p) => p.releaseInstanceId === "ri_c2");
    expect(culpritProbe?.outcome).toBe("failed_product");
    expect(result.probes.find((p) => p.releaseInstanceId === "ri_c1")?.outcome).toBe("passed");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.culprit?.releaseInstanceId).toBe("ri_c2");
  });

  it("REFUSES to name a culprit when a candidate probe is unreachable (fail-closed → inconclusive)", async () => {
    const base = candidate("good", 1);
    const c1 = candidate("c1", 2);
    // c2 is unreachable at the search midpoint.
    const c2 = candidate("c2", 3);
    const c3 = candidate("c3", 4);
    const chain: CandidateChain = { candidates: [c1, c2, c3], baseline: base };
    const { store, recorded } = captureStore();
    const result = await bisector(
      chain,
      fetchBy({ good: "healthy", c1: "healthy", c2: "unreachable", c3: "regressed" }),
      store,
    ).bisect(TRIGGER);

    expect(result.status).toBe("inconclusive");
    expect(result.culprit).toBeUndefined();
    expect(result.inconclusiveReason).toContain("inconclusive");
    // The unreachable probe was recorded as a real inconclusive_infrastructure outcome, not fabricated.
    expect(result.probes.find((p) => p.releaseInstanceId === "ri_c2")).toMatchObject({
      outcome: "inconclusive_infrastructure",
      reachable: false,
    });
    expect(recorded[0]?.status).toBe("inconclusive");
    expect(recorded[0]?.culprit).toBeUndefined();
  });

  it("fails closed when the tip no longer reproduces the regression", async () => {
    const chain: CandidateChain = {
      candidates: [candidate("c1", 2), candidate("c3", 4)],
      baseline: candidate("good", 1),
    };
    const { store } = captureStore();
    const result = await bisector(chain, fetchBy({ good: "healthy", c1: "healthy", c3: "healthy" }), store).bisect(
      TRIGGER,
    );
    expect(result.status).toBe("inconclusive");
    expect(result.culprit).toBeUndefined();
    expect(result.inconclusiveReason).toContain("did not reproduce");
  });

  it("fails closed with no known-good baseline anchor", async () => {
    const chain: CandidateChain = { candidates: [candidate("c3", 4)], baseline: undefined };
    const { store } = captureStore();
    const result = await bisector(chain, fetchBy({ c3: "regressed" }), store).bisect(TRIGGER);
    expect(result.status).toBe("inconclusive");
    expect(result.culprit).toBeUndefined();
    expect(result.inconclusiveReason).toContain("no known-good baseline");
  });

  it("fails closed when the baseline anchor does not re-prove healthy (never a scapegoat)", async () => {
    const chain: CandidateChain = {
      candidates: [candidate("c1", 2), candidate("c3", 4)],
      baseline: candidate("good", 1),
    };
    const { store } = captureStore();
    const result = await bisector(
      chain,
      fetchBy({ good: "regressed", c1: "regressed", c3: "regressed" }),
      store,
    ).bisect(TRIGGER);
    expect(result.status).toBe("inconclusive");
    expect(result.culprit).toBeUndefined();
    expect(result.inconclusiveReason).toContain("baseline anchor");
  });
});
