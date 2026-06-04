// GAP #3 (merge hardening — strict-posture autonomy): the strict/lenient governance
// posture must NOT strand an AUTONOMOUS-tier (reviewPolicy auto/simulated + native_queue)
// done-run spec into a 3×-churn → park when the only external committer is a configured
// known-automation login (a co-author trailer / a second bot). On the autonomous tier
// such a block AUTO-APPROVES (the obvious continue); the `human` tier still blocks (a
// real human decision). The known-bot set is CONFIGURABLE per project (not a hardcoded
// single `web-flow`). Driven through the pure `decidePosture` AND end-to-end via
// `mergeForRun` (fixtures live here, never in src/).

import { describe, expect, it } from "vitest";
import { vcsProviderOver } from "./helpers/vcsProvider.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import {
  assessExternalChange,
  decidePosture,
  mergeForRun,
  tanrenIdentity,
  type ContributorProbe,
} from "../src/engine/workflow/reviewMerge/index.js";
import { noopConflictResolver } from "./fixtures/noopConflictResolver.js";
import {
  FIXTURE_TANREN_LOGIN,
  recordingMergeProbe,
  ReviewMergePool,
  tanrenSecrets,
  tanrenUserHttp,
} from "./reviewMerge.fixtures.js";

describe("decidePosture — autonomous-tier known-bot auto-approve (GAP #3)", () => {
  // The bot login is NOT in the Tanren identity set — it is an EXTERNAL committer that
  // strict would normally block; the autonomous-tier known-bot set is what auto-approves.
  const botOnly = assessExternalChange({ logins: ["co-author-bot"] }, tanrenIdentity(["tanren[bot]"]));
  const botPlusHuman = assessExternalChange({ logins: ["co-author-bot", "mallory"] }, tanrenIdentity(["tanren[bot]"]));
  const knownBots = new Set(["co-author-bot"]);

  it("strict + known-bot-only external → AUTO-APPROVES on the autonomous tier (no strand)", () => {
    const decision = decidePosture("strict", botOnly, { autonomousTier: true, platformLogins: knownBots });
    expect(decision.kind).toBe("proceed");
    expect(decision.reason).toContain("known-automation");
  });

  it("lenient + known-bot-only external → AUTO-APPROVES on the autonomous tier", () => {
    expect(decidePosture("lenient", botOnly, { autonomousTier: true, platformLogins: knownBots }).kind).toBe("proceed");
  });

  it("strict + known-bot-only external → STILL BLOCKS on the human tier (autonomousTier false)", () => {
    expect(decidePosture("strict", botOnly, { autonomousTier: false, platformLogins: knownBots }).kind).toBe("block");
    // With NO auto-approve context at all (today's behavior) → block (byte-identical).
    expect(decidePosture("strict", botOnly).kind).toBe("block");
  });

  it("strict + (known-bot + genuine human) external → STILL BLOCKS even on the autonomous tier", () => {
    // Not EVERY external login is a known-bot → the obvious-continue does not apply.
    expect(decidePosture("strict", botPlusHuman, { autonomousTier: true, platformLogins: knownBots }).kind).toBe(
      "block",
    );
  });

  it("strict + an external login NOT in the configured set → blocks (the set is the gate, not a blanket pass)", () => {
    expect(decidePosture("strict", botOnly, { autonomousTier: true, platformLogins: new Set() }).kind).toBe("block");
  });
});

describe("mergeForRun governance — autonomous-tier known-bot auto-approve (GAP #3)", () => {
  const botProbe: ContributorProbe = {
    listContributors: async () => ({ logins: [FIXTURE_TANREN_LOGIN, "co-author-bot"] }),
  };

  // A native_queue AUTONOMOUS-tier (reviewPolicy auto) run whose only external committer
  // is a configured known-automation login must NOT strand into a posture block (which a
  // done-run never re-readies from → 3×-churn → park). It auto-approves + ENTERS the queue.
  it("strict + native_queue + auto + known-bot committer → AUTO-APPROVES + enters the queue (no strand)", async () => {
    const pool = new ReviewMergePool("native_queue", "strict", "auto");
    pool.governancePlatformLogins = ["co-author-bot"];
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({ merged: true, mergeSha: "x", conflict: false, status: 200, message: "merged" });

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: await tanrenSecrets(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(tanrenUserHttp()),
      runId: "run_1",
      mergeProbe: probe,
      contributorProbe: botProbe,
      enqueueNativeQueue: async () => ({ queueId: "mq_1", created: true }),
    });

    // It did NOT strand: it auto-approved past the strict block + entered the queue.
    expect(result.outcome).toBe("queued");
    expect(events.events.find((e) => e.eventType === "merge.blocked")).toBeUndefined();
    expect(events.events.some((e) => e.eventType === "merge.queued")).toBe(true);
    // No direct merge attempted (the native_queue enqueue pass, not the drive pass).
    expect(probe.mergeCalls).toBe(0);
  });

  // The same known-bot committer on the HUMAN tier STILL blocks — the auto-approve is
  // scoped to the autonomous tiers; a human makes the real decision.
  it("strict + native_queue + HUMAN + known-bot committer → STILL blocks (auto-approve is autonomous-only)", async () => {
    const pool = new ReviewMergePool("native_queue", "strict", "human");
    pool.governancePlatformLogins = ["co-author-bot"];
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({ merged: true, mergeSha: "x", conflict: false, status: 200, message: "merged" });

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      secrets: await tanrenSecrets(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(tanrenUserHttp()),
      runId: "run_1",
      mergeProbe: probe,
      contributorProbe: botProbe,
      enqueueNativeQueue: async () => ({ queueId: "mq_1", created: true }),
    });

    expect(result.outcome).toBe("blocked");
    expect(events.events.find((e) => e.eventType === "merge.blocked")?.payload).toMatchObject({ posture: "strict" });
  });
});
