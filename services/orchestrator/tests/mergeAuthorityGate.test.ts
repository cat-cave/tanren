// Unit coverage for the §5 cutover boundary (no DB): the FAIL-CLOSED input mapping
// (`mergeAuthorityInputs`) and the live land gate (`authorizeAndLand`) — including the
// clean land via `CodeHost.landAuthorizedRef` (the ff-only CAS) and the CAS-rejection
// → `cas_rejected` (a benign race) mapping. The truth table itself is the frozen
// conformance suite; this pins the LIVE-PATH translation + the host CAS land wiring.

import { describe, expect, it } from "vitest";
import { InMemoryCodeHost } from "./conformance/fakes/inMemoryCodeHost.js";
import { authorizeAndLand } from "../src/engine/merge/mergeAuthorityGate.js";
import { LandCasRejectedError } from "../src/engine/providers/githubCodeHost.js";
import {
  budgetScopeFrom,
  demoFrom,
  gateVerdictFrom,
  hitlSignoffFrom,
  mergeabilityFrom,
  reviewVerdictFrom,
} from "../src/engine/merge/mergeAuthorityInputs.js";
import type { AuthorityLandStore } from "../src/engine/merge/mergeAuthorityV2Impl.js";
import type { BehaviorLandGate } from "../src/engine/merge/behaviorLandGate.js";
import type { GateOutcome } from "../src/engine/workflow/gate/index.js";
import type { AuditPosture } from "../src/engine/contracts/auditPosture.js";

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

const STORE: AuthorityLandStore = {
  persistAuthorizedDecision: async () => ({ effectIntentId: "intent_1" }),
  recordLandReceipt: async () => ({ auditId: "a1" }),
};

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
    // Default: no pre-merge behavior verification was required (most runs) — the behavior
    // section is not-applicable and NEVER blocks. Behavior tests below override this.
    behaviorGate: { kind: "not_applicable" as const },
    store: STORE,
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

describe("authorizeAndLand — clean land via CodeHost.landAuthorizedRef CAS", () => {
  it("a fully-clear authorization lands the PR head onto main via the ff-only CAS", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    const disposition = await authorizeAndLand(gateInput(host));
    expect(disposition.kind).toBe("merged");
    // main advanced to the authorized PR head via the CAS push (NOT a host merge API).
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-feat");
  });

  it("a CAS rejection (main raced ahead between read and land) → cas_rejected (benign race)", async () => {
    // A host whose ref reads succeed (so prepare resolves the target) but whose
    // landAuthorizedRef throws the typed CAS rejection — main raced ahead between the
    // gate's base read and the land. The gate maps it to cas_rejected (a benign race).
    const racingHost = {
      ...new InMemoryCodeHost(),
      fetchRef: async (input: { remoteBranch: string }) => (input.remoteBranch === "main" ? "sha-main" : "sha-feat"),
      landAuthorizedIntegration: async () => {
        // The TYPED rejection the GitHub impl throws — the gate classifies it by
        // `instanceof LandCasRejectedError` (§3.2), not a brittle message regex.
        throw new LandCasRejectedError("main", "sha-main", "sha-main-moved");
      },
    } as unknown as InMemoryCodeHost;
    const disposition = await authorizeAndLand(gateInput(racingHost));
    expect(disposition.kind).toBe("cas_rejected");
  });

  it("§3.2 TYPED CAS: a non-CAS land error whose message contains 'cascade'/'case' is NOT mis-classified as cas_rejected", async () => {
    // The old classification was a message regex `/...|CAS|.../iu` that matched ANY
    // "case"/"cascade"/"showcase" substring — mis-mapping a genuine fault into a benign
    // retry. The typed `instanceof LandCasRejectedError` check makes the message irrelevant.
    const failingHost = {
      ...new InMemoryCodeHost(),
      fetchRef: async (input: { remoteBranch: string }) => (input.remoteBranch === "main" ? "sha-main" : "sha-feat"),
      landAuthorizedIntegration: async () => {
        throw new Error("transient gateway failure in the deploy cascade (showcase env)");
      },
    } as unknown as InMemoryCodeHost;
    // A real fault must PROPAGATE (it is not a benign CAS race), not become `cas_rejected`.
    await expect(authorizeAndLand(gateInput(failingHost))).rejects.toThrow(/cascade|showcase/u);
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

  it("TOCTOU LOCK: gate PASSED for the CURRENT head (sha unchanged) → lands (commit-binding satisfied)", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    // gatedHeadSha === the landed head (sha-feat) — the binding is satisfied.
    const disposition = await authorizeAndLand(gateInput(host));
    expect(disposition.kind).toBe("merged");
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-feat");
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

  it("TOCTOU LOCK (gv-2 positive): review forge receipt headSha equals landing head → lands", async () => {
    const head = "c".repeat(40);
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: head });
    const input = gateInput(host);
    input.gatedHeadSha = head;
    input.reviewedHeadSha = head;
    input.requiresExactReviewReceipt = true;
    const disposition = await authorizeAndLand(input);
    expect(disposition.kind).toBe("merged");
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe(head);
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

  it("REQUIRED + PASSING behavior (+ CI passing) → authorized; main advances to the PR head", async () => {
    const { host, disposition } = await landWithBehavior({ kind: "passed", passedBlockingCount: 2 });
    expect(disposition.kind).toBe("merged");
    // The land actually happened only because the behavior verdict was a decisive pass.
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-feat");
  });

  it("NO behavior requirement (not_applicable) → authorized on CI alone (non-behavior runs still merge)", async () => {
    const { host, disposition } = await landWithBehavior({ kind: "not_applicable" });
    expect(disposition.kind).toBe("merged");
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-feat");
  });
});
