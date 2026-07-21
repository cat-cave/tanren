// Unit coverage for the §5 cutover boundary (no DB): the FAIL-CLOSED input mapping
// (`mergeAuthorityInputs`) and the legacy per-run gate (`authorizeAndLand`). The
// per-run route preserves its fail-closed guards but may never synthesize a V2
// integration-node/proof binding or reach host CAS; canonical queue land is covered
// by the exact-node authority suites.

import { describe, expect, it } from "vitest";
import { InMemoryCodeHost } from "./conformance/fakes/inMemoryCodeHost.js";
import { authorizeAndLand } from "../src/engine/merge/mergeAuthorityGate.js";
import {
  budgetScopeFrom,
  demoFrom,
  gateVerdictFrom,
  hitlSignoffFrom,
  mergeabilityFrom,
  reviewVerdictFrom,
} from "../src/engine/merge/mergeAuthorityInputs.js";
import type { BehaviorLandGate } from "../src/engine/merge/behaviorLandGate.js";
import type { DesignRenderGate } from "../src/engine/merge/designRenderLandGate.js";
import type { GateOutcome } from "../src/engine/workflow/gate/index.js";
import type { AuditPosture } from "../src/engine/contracts/auditPosture.js";
import { noRequiredReviewGate } from "../src/engine/governance/reviewRules.js";
import { migrateProjectConfig } from "../src/engine/config/projectConfig.js";

const REPO = { owner: "o", name: "r" };
const POSTURE: AuditPosture = { blockReviewAt: "P1", p2p3Handling: "route-to-dag" };
// An "absent signal" sentinel typed as the union — the live path's not-resolved form.
const ABSENT = undefined;

describe("mergeAuthorityInputs — every uncertain signal maps to its blocking enum", () => {
  it("gate: absent/not-run → unknown (blocks); passed/failed pass through", () => {
    expect(gateVerdictFrom(ABSENT)).toBe("unknown");
    expect(gateVerdictFrom({ passed: true, results: [] } as GateOutcome)).toBe("passed");
  });

  it("review: absent → unread (blocks); changes_requested preserved", () => {
    expect(reviewVerdictFrom(ABSENT)).toBe("unread");
    expect(reviewVerdictFrom("changes_requested")).toBe("changes_requested");
    expect(reviewVerdictFrom("approved")).toBe("approved");
  });

  it("mergeability: absent → unknown (blocks); only clean clears", () => {
    expect(mergeabilityFrom(ABSENT)).toBe("unknown");
  });

  it("budget: failClosed → unresolvable; absent ceiling → not_required; configured → resolved", () => {
    expect(budgetScopeFrom({ ceilingUsd: ABSENT, spentUsd: 0, failClosedReason: "unpriced" }).kind).toBe(
      "unresolvable",
    );
    expect(budgetScopeFrom({ ceilingUsd: ABSENT, spentUsd: 0 }).kind).toBe("not_required");
    expect(budgetScopeFrom({ ceilingUsd: 50, spentUsd: 10 }).kind).toBe("resolved");
    // A non-finite ceiling is NEVER unlimited — it fails closed.
    expect(budgetScopeFrom({ ceilingUsd: Number.POSITIVE_INFINITY, spentUsd: 0 }).kind).toBe("unresolvable");
  });

  it("demo + hitl: absent → the blocking value (unverified / pending)", () => {
    expect(demoFrom(ABSENT)).toBe("unverified");
    expect(hitlSignoffFrom(ABSENT)).toBe("pending");
    expect(hitlSignoffFrom("not_required")).toBe("not_required");
  });
});

describe("merge integration configuration", () => {
  it("rejects the removed direct_merge automatic mode instead of falling back", () => {
    expect(() => migrateProjectConfig({ version: 1, mergeIntegration: "direct_merge" })).toThrow(
      /native_queue|external_reviewer|not_configured/u,
    );
  });
});

function gateInput(host: InMemoryCodeHost) {
  return {
    codeHost: host,
    repo: REPO,
    intoMain: "main",
    headBranch: "feat",
    runId: "run",
    specId: "s",
    gateConfigHash: "gc",
    policyVersion: "pv",
    // The gate verdict was for the EXACT commit being landed (the `feat` head, sha-feat).
    gatedHeadSha: "sha-feat",
    // Human/auto path (no forge receipt) unless a TOCTOU test overrides.
    reviewedHeadSha: undefined,
    requiresExactReviewReceipt: false,
    reviewGate: noRequiredReviewGate(),
    // Default: no pre-merge behavior verification was required (most runs) — the behavior
    // section is not-applicable and NEVER blocks. Behavior tests below override this.
    behaviorGate: { kind: "not_applicable" as const },
    // ds-4: no composed design system / advisory posture by default — the design_render
    // section is not-applicable and NEVER blocks. Design tests below override this.
    designRenderGate: { kind: "not_applicable" as const },
    signals: {
      gateOutcome: { passed: true, results: [] } as GateOutcome,
      findings: [],
      auditPosture: POSTURE,
      reviewVerdict: "approved" as const,
      mergeability: { state: "clean" as const, behind: false, baseBranch: "main", headBranch: "feat" },
      budget: { ceilingUsd: undefined, spentUsd: 0 },
      demo: "not_required" as const,
      hitlSignoff: "not_required" as const,
      conflictsResolved: true,
    },
  };
}

describe("authorizeAndLand — synthetic per-run land is closed fail-closed", () => {
  it("a fully-clear legacy attempt is blocked and never advances main", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    const disposition = await authorizeAndLand(gateInput(host));
    expect(disposition).toMatchObject({ kind: "blocked", reasons: [expect.stringContaining("canonical queue authority")] });
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
  });

  it("FINAL CLAIM FENCE: a freeze arriving after authorization but before CAS blocks host land", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    let fenceCalls = 0;
    const disposition = await authorizeAndLand({
      ...gateInput(host),
      // Simulates QueuePolicyController.apply(claim) observing a freeze/blackout
      // after proof completion. The callback is invoked after authorizeLand and
      // immediately before authority.land / CodeHost CAS.
      confirmBeforeAuthorityCas: async () => {
        fenceCalls += 1;
        return false;
      },
    });
    expect(fenceCalls).toBe(1);
    expect(disposition.kind).toBe("blocked");
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
  });

  it("an unpersisted legacy attempt never calls a host CAS implementation", async () => {
    let hostLandCalls = 0;
    const racingHost = {
      ...new InMemoryCodeHost(),
      fetchRef: async (input: { remoteBranch: string }) => (input.remoteBranch === "main" ? "sha-main" : "sha-feat"),
      landAuthorizedIntegration: async () => {
        hostLandCalls += 1;
        throw new Error("host land must be unreachable without a persisted node/proof");
      },
    } as unknown as InMemoryCodeHost;
    const disposition = await authorizeAndLand(gateInput(racingHost));
    expect(disposition.kind).toBe("blocked");
    expect(hostLandCalls).toBe(0);
  });

  it("a host-land error cannot be surfaced from the closed synthetic route", async () => {
    const failingHost = {
      ...new InMemoryCodeHost(),
      fetchRef: async (input: { remoteBranch: string }) => (input.remoteBranch === "main" ? "sha-main" : "sha-feat"),
      landAuthorizedIntegration: async () => {
        throw new Error("transient gateway failure in the deploy cascade (showcase env)");
      },
    } as unknown as InMemoryCodeHost;
    await expect(authorizeAndLand(gateInput(failingHost))).resolves.toMatchObject({ kind: "blocked" });
  });

  it("an uncertain input (gate unknown) → blocked, no land target, main untouched", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    const input = gateInput(host);
    input.signals.gateOutcome = ABSENT;
    const disposition = await authorizeAndLand(input);
    expect(disposition.kind).toBe("blocked");
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
  });

  it("TOCTOU LOCK: gate PASSED for sha A, head advanced to sha B before land → BLOCKED (commit-bound, not just time-fresh)", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    // The head ADVANCED to sha-B after the gate passed for sha-A (an eager base-shift /
    // concurrent rebase / push between the fresh pre_merge gate and the land).
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-B" });
    const input = gateInput(host);
    // The gate verdict is for the OLD head sha-A — not the current head sha-B.
    input.gatedHeadSha = "sha-A";
    const disposition = await authorizeAndLand(input);
    expect(disposition.kind).toBe("blocked");
    const reasons = disposition.kind === "blocked" ? disposition.reasons.join(" ") : "";
    expect(reasons).toMatch(/different commit|gated 'sha-A'.*sha-B/u);
    // The un-gated commit (sha-B) was NEVER landed; main untouched.
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
  });

  it("TOCTOU LOCK: gate PASSED for the CURRENT head clears the guard but cannot revive the removed route", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    // gatedHeadSha === the landed head (sha-feat) — the binding is satisfied.
    const disposition = await authorizeAndLand(gateInput(host));
    expect(disposition.kind).toBe("blocked");
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
  });

  it("TOCTOU LOCK (gv-2 former bug): review.approved with forge headSha A, head advanced to B → BLOCKED", async () => {
    const headA = "a".repeat(40);
    const headB = "b".repeat(40);
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: headB });
    const input = gateInput(host);
    // Gate binds to the live head so only the review receipt is the mismatch.
    input.gatedHeadSha = headB;
    // Former bug: land trusted review.approved existence and ignored the receipt head.
    input.reviewedHeadSha = headA;
    input.requiresExactReviewReceipt = true;
    const disposition = await authorizeAndLand(input);
    expect(disposition.kind).toBe("blocked");
    const reasons = disposition.kind === "blocked" ? disposition.reasons.join(" ") : "";
    expect(reasons).toContain(`reviewed '${headA}' != landing '${headB}'`);
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
  });

  it("TOCTOU LOCK (gv-2 positive): an exact review receipt clears the guard but cannot revive the removed route", async () => {
    const head = "c".repeat(40);
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: head });
    const input = gateInput(host);
    input.gatedHeadSha = head;
    input.reviewedHeadSha = head;
    input.requiresExactReviewReceipt = true;
    const disposition = await authorizeAndLand(input);
    expect(disposition.kind).toBe("blocked");
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
  });

  it("simulated policy blocks an approved event with no complete forge receipt", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    const input = gateInput(host);
    input.requiresExactReviewReceipt = true;
    const disposition = await authorizeAndLand(input);
    expect(disposition).toMatchObject({ kind: "blocked", reasons: [expect.stringContaining("no complete")] });
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
  });
});

describe("authorizeAndLand — the rv-gate runtime BEHAVIOR verdict gates the REAL land decision", () => {
  async function landWithBehavior(behaviorGate: BehaviorLandGate) {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    // Every OTHER signal clears (gate passed, review approved, clean, budget/demo/hitl ok):
    // the behavior verdict is the ONLY variable, so the land decision changes iff the
    // behavior gate does — proving REAL production consumption, not a library-only function.
    const disposition = await authorizeAndLand({ ...gateInput(host), behaviorGate });
    return { host, disposition };
  }

  it("REQUIRED + FAILING behavior (failed_product) → NOT authorized (blocked); main untouched", async () => {
    const { host, disposition } = await landWithBehavior({
      kind: "failed",
      behaviorRevisionId: "br-checkout",
      outcome: "failed_product",
    });
    expect(disposition.kind).toBe("blocked");
    const reasons = disposition.kind === "blocked" ? disposition.reasons.join(" ") : "";
    expect(reasons).toMatch(/runtimeBehavior.*failed_product/u);
    // A failing required behavior NEVER lands — main stays put.
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
  });

  it("REQUIRED + failed_visual → NOT authorized (blocked)", async () => {
    const { disposition } = await landWithBehavior({
      kind: "failed",
      behaviorRevisionId: "br-render",
      outcome: "failed_visual",
    });
    expect(disposition.kind).toBe("blocked");
  });

  it("REQUIRED but INCONCLUSIVE/absent verdict → NOT authorized (fail-closed; inconclusive ≠ passed)", async () => {
    const { host, disposition } = await landWithBehavior({
      kind: "inconclusive",
      reason: "pre-merge behavior verification is 'running', not a completed pass",
    });
    expect(disposition.kind).toBe("blocked");
    const reasons = disposition.kind === "blocked" ? disposition.reasons.join(" ") : "";
    expect(reasons).toMatch(/runtimeBehavior.*inconclusive ≠ passed/u);
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
  });

  it("REQUIRED + PASSING behavior (+ CI passing) still cannot create a synthetic authority binding", async () => {
    const { host, disposition } = await landWithBehavior({ kind: "passed", passedBlockingCount: 2 });
    expect(disposition.kind).toBe("blocked");
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
  });

  it("NO behavior requirement (not_applicable) leaves the closed route blocked", async () => {
    const { host, disposition } = await landWithBehavior({ kind: "not_applicable" });
    expect(disposition.kind).toBe("blocked");
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
  });
});

describe("authorizeAndLand — the ds-4 DESIGN-RENDER verdict gates the REAL land decision", () => {
  async function landWithDesignRender(designRenderGate: DesignRenderGate) {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    // Every OTHER signal clears (CI passed, review approved, clean, behavior n/a): the design
    // verdict is the ONLY variable, so the land decision changes iff the design gate does —
    // proving REAL production consumption on the live land path.
    const disposition = await authorizeAndLand({ ...gateInput(host), designRenderGate });
    return { host, disposition };
  }

  it("REQUIRED + FAILING design render (failed_visual) → NOT authorized (blocked); main untouched", async () => {
    const { host, disposition } = await landWithDesignRender({
      kind: "failed",
      failingScenarioKey: "button:dark:mobile:en-US",
      failingRuleIds: ["button-name"],
    });
    expect(disposition.kind).toBe("blocked");
    const reasons = disposition.kind === "blocked" ? disposition.reasons.join(" ") : "";
    expect(reasons).toMatch(/design_render.*button-name/u);
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
  });

  it("REQUIRED but INCONCLUSIVE/absent design verdict → NOT authorized (fail-closed; inconclusive ≠ passed)", async () => {
    const { host, disposition } = await landWithDesignRender({
      kind: "inconclusive_infrastructure",
      reason: "the project has a published design system but no design-render verdict (required-but-absent)",
    });
    expect(disposition.kind).toBe("blocked");
    const reasons = disposition.kind === "blocked" ? disposition.reasons.join(" ") : "";
    expect(reasons).toMatch(/design_render.*inconclusive ≠ passed/u);
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
  });

  it("REQUIRED + PASSING design render (+ CI passing) still cannot create a synthetic authority binding", async () => {
    const { host, disposition } = await landWithDesignRender({ kind: "passed", passedCheckpointCount: 4 });
    expect(disposition.kind).toBe("blocked");
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
  });

  it("NO design requirement (not_applicable) leaves the closed route blocked", async () => {
    const { host, disposition } = await landWithDesignRender({ kind: "not_applicable" });
    expect(disposition.kind).toBe("blocked");
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
  });
});
