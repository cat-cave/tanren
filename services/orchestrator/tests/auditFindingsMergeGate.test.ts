// WAVE-2 / SLICE S3a PROOF (tanren-owns-the-engine.md §4): the audit's P0–P3 FINDINGS
// are the SOLE audit gate in the LIVE merge decision — the project `auditPosture`
// (`decideFromFindings`) turns them into block/route/fix, and the legacy
// passed/loop_to_planner/halt verdict path is gone. These tests drive the LIVE merge
// path (`authorizeAndLand`, which builds the input through `buildAuthorizeLandInput` and
// runs the real `MergeAuthorityImpl`), proving:
//   (a) a P0/P1 finding at merge time → BLOCKED via the authority's decideFromFindings;
//   (b) P2/P3 findings → NOT blocked (the merge lands), routed/fixed per posture;
//   (c) a MISSING audit record → BLOCKED (fail-closed, no silent pass);
//   (d) the DORA knob: the SAME findings block under strict vs route under velocity,
//       end-to-end through the live merge path.

import { describe, expect, it } from "vitest";
import { InMemoryCodeHost } from "./conformance/fakes/inMemoryCodeHost.js";
import { authorizeAndLand } from "../src/engine/merge/mergeAuthorityGate.js";
import { auditMissingFinding } from "../src/engine/merge/landSignals.js";
import { decideFromFindings, type AuditPosture } from "../src/engine/contracts/auditPosture.js";
import { evaluatePostureGate } from "../src/engine/forge/audits/postureGate.js";
import type { Finding } from "../src/engine/contracts/findings.js";
import type { GateOutcome } from "../src/engine/workflow/gate/index.js";
import type { AuthorityLandStore } from "../src/engine/merge/mergeAuthorityV2Impl.js";

const REPO = { owner: "o", name: "r" };
// Strict = block on anything down to P3; velocity = only P0/P1 block, route the rest.
const STRICT: AuditPosture = { blockReviewAt: "P3", p2p3Handling: "fix-if-idle" };
const VELOCITY: AuditPosture = { blockReviewAt: "P1", p2p3Handling: "route-to-dag" };

const STORE: AuthorityLandStore = {
  persistAuthorizedDecision: async () => ({ effectIntentId: "intent_1" }),
  recordLandReceipt: async () => ({ auditId: "a1" }),
};

const P0: Finding = { id: "p0", severity: "P0", title: "data loss", body: "b" };
const P1: Finding = { id: "p1", severity: "P1", title: "blocking defect", body: "b" };
const P2: Finding = { id: "p2", severity: "P2", title: "quality gap", body: "b" };
const P3: Finding = { id: "p3", severity: "P3", title: "polish", body: "b" };

/** A fully-clear live land input EXCEPT the findings + posture under test. */
function landInput(host: InMemoryCodeHost, findings: ReadonlyArray<Finding>, posture: AuditPosture) {
  return {
    codeHost: host,
    repo: REPO,
    intoMain: "main",
    headBranch: "feat",
    runId: "run",
    specId: "s",
    gateConfigHash: "gc",
    policyVersion: "pv",
    gatedHeadSha: "sha-feat",
    store: STORE,
    signals: {
      gateOutcome: { passed: true, results: [] } as GateOutcome,
      findings,
      auditPosture: posture,
      reviewVerdict: "approved" as const,
      mergeability: { state: "clean" as const, behind: false, baseBranch: "main", headBranch: "feat" },
      budget: { ceilingUsd: undefined, spentUsd: 0 },
      demo: "not_required" as const,
      hitlSignoff: "not_required" as const,
      conflictsResolved: true,
    },
  };
}

/** A seeded host whose feat head IS the gated sha so only the findings vary the outcome. */
function seededHost(): InMemoryCodeHost {
  const host = new InMemoryCodeHost();
  host.seed(REPO, "main", "sha-main");
  return host;
}

async function seedFeat(host: InMemoryCodeHost): Promise<void> {
  await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
}

describe("S3a — findings are the LIVE audit gate (a): a P0/P1 finding BLOCKS the merge", () => {
  it("a P0 finding at merge time → BLOCKED via the authority's decideFromFindings (not a legacy verdict)", async () => {
    const host = seededHost();
    await seedFeat(host);
    const disposition = await authorizeAndLand(landInput(host, [P0], VELOCITY));
    expect(disposition.kind).toBe("blocked");
    const reasons = disposition.kind === "blocked" ? disposition.reasons.join(" ") : "";
    // The block names the FINDINGS input (the posture policy), not any legacy verdict.
    expect(reasons).toMatch(/findings.*auditPosture|blocked by policy/u);
    // main never advanced — the un-audited-clean change did NOT land.
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
  });

  it("a P1 finding under velocity (blockReviewAt:P1) → BLOCKED (only P0/P1 block)", async () => {
    const host = seededHost();
    await seedFeat(host);
    const disposition = await authorizeAndLand(landInput(host, [P1], VELOCITY));
    expect(disposition.kind).toBe("blocked");
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
  });
});

describe("S3a — findings are the LIVE audit gate (b): P2/P3 do NOT block; routed/fixed per posture", () => {
  it("a P2 finding under velocity → NOT blocked: the merge LANDS", async () => {
    const host = seededHost();
    await seedFeat(host);
    const disposition = await authorizeAndLand(landInput(host, [P2], VELOCITY));
    expect(disposition.kind).toBe("merged");
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-feat");
  });

  it("the residual P2/P3 are ROUTED as DAG specs under route-to-dag (the postureGate path)", () => {
    // The SAME findings + posture the live land cleared feed the postureGate: the
    // residuals become routable DAG specs (velocity routes; nothing blocks).
    const gate = evaluatePostureGate([P2, P3], VELOCITY, { idleAwaitingReview: false });
    expect(gate.decision.block).toBe(false);
    expect(gate.routeSpecs.map((s) => s.title)).toEqual([P2.title, P3.title]);
    expect(gate.fixInPlace).toEqual([]);
  });

  it("the residual P2/P3 are FIXED IN PLACE when idle under fix-if-idle (else carried forward)", () => {
    const idle = evaluatePostureGate(
      [P2],
      { blockReviewAt: "P1", p2p3Handling: "fix-if-idle" },
      {
        idleAwaitingReview: true,
      },
    );
    expect(idle.decision.block).toBe(false);
    expect(idle.fixInPlace).toEqual([P2]);
    expect(idle.routeSpecs).toEqual([]);

    const live = evaluatePostureGate(
      [P2],
      { blockReviewAt: "P1", p2p3Handling: "fix-if-idle" },
      {
        idleAwaitingReview: false,
      },
    );
    // Not idle ⇒ carried forward (never spawn fix-work mid-run), still not blocked.
    expect(live.decision.block).toBe(false);
    expect(live.fixInPlace).toEqual([]);
    expect(live.dispositions.map((d) => d.action)).toEqual(["carryForward"]);
  });
});

describe("S3a — findings are the LIVE audit gate (c): a MISSING audit record BLOCKS (fail-closed)", () => {
  it("the synthetic missing-audit finding is a P0 that blocks under ANY posture (strict AND velocity)", () => {
    const missing = auditMissingFinding("run_x");
    expect(missing.severity).toBe("P0");
    expect(decideFromFindings([missing], STRICT).block).toBe(true);
    expect(decideFromFindings([missing], VELOCITY).block).toBe(true);
  });

  it("a missing audit record at merge time → BLOCKED on the live path (no silent pass)", async () => {
    const host = seededHost();
    await seedFeat(host);
    // The bundle builder maps a missing/unreadable audit record to [auditMissingFinding];
    // drive the SAME blocking input through the live land — it must NOT merge.
    const disposition = await authorizeAndLand(landInput(host, [auditMissingFinding("run")], VELOCITY));
    expect(disposition.kind).toBe("blocked");
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
  });
});

describe("S3a — findings are the LIVE audit gate (d): the DORA knob, end-to-end through the merge", () => {
  it("the SAME P2 finding BLOCKS under strict but LANDS (routed) under velocity", async () => {
    // STRICT (blockReviewAt:P3) — a P2 is at-or-above P3 ⇒ blocks.
    const strictHost = seededHost();
    await seedFeat(strictHost);
    const strict = await authorizeAndLand(landInput(strictHost, [P2], STRICT));
    expect(strict.kind).toBe("blocked");
    expect(await strictHost.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");

    // VELOCITY (blockReviewAt:P1) — a P2 is below P1 ⇒ does NOT block ⇒ lands.
    const velocityHost = seededHost();
    await seedFeat(velocityHost);
    const velocity = await authorizeAndLand(landInput(velocityHost, [P2], VELOCITY));
    expect(velocity.kind).toBe("merged");
    expect(await velocityHost.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-feat");

    // And under velocity the same P2 routes into the DAG (it was not dropped).
    expect(evaluatePostureGate([P2], VELOCITY, { idleAwaitingReview: false }).routeSpecs).toHaveLength(1);
  });
});
