// GAP #3 (merge hardening — strict-posture autonomy): the strict/lenient governance
// posture must NOT strand an AUTONOMOUS-tier (reviewPolicy auto/simulated + native_queue)
// done-run spec into a 3×-churn → park when the only external committer is a configured
// known-automation login (a co-author trailer / a second bot). On the autonomous tier
// such a block AUTO-APPROVES (the obvious continue); the `human` tier still blocks (a
// real human decision). The known-bot set is CONFIGURABLE per project (not a hardcoded
// single `web-flow`). Driven through the pure `decidePosture` AND end-to-end via
// `mergeForRun` (fixtures live here, never in src/).

import { describe, expect, it } from "vitest";
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
  ReviewMergePool,
  authorityBundle,
  authorityHost,
  fakeMergeWriter,
  recordingMergeProbe,
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
    const probe = recordingMergeProbe();
    const host = authorityHost();
    const landed: string[] = [];

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: await tanrenSecrets(),
      resolveConflict: noopConflictResolver,
      githubHttp: tanrenUserHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
      contributorProbe: botProbe,
      enqueueNativeQueue: async () => ({ queueId: "mq_1", created: true }),
    });

    // It did NOT strand: it auto-approved past the strict block + entered the queue.
    expect(result.outcome).toBe("queued");
    expect(events.events.find((e) => e.eventType === "merge.blocked")).toBeUndefined();
    expect(events.events.some((e) => e.eventType === "merge.queued")).toBe(true);
    // No land attempted (the native_queue enqueue pass, not the drive pass).
    expect(landed).toEqual([]);
  });

  // The same known-bot committer on the HUMAN tier STILL blocks — the auto-approve is
  // scoped to the autonomous tiers; a human makes the real decision.
  it("strict + native_queue + HUMAN + known-bot committer → STILL blocks (auto-approve is autonomous-only)", async () => {
    const pool = new ReviewMergePool("native_queue", "strict", "human");
    pool.governancePlatformLogins = ["co-author-bot"];
    const events = new FakeEventStore();
    const probe = recordingMergeProbe();
    const host = authorityHost();
    const landed: string[] = [];

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: await tanrenSecrets(),
      resolveConflict: noopConflictResolver,
      githubHttp: tanrenUserHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
      contributorProbe: botProbe,
      enqueueNativeQueue: async () => ({ queueId: "mq_1", created: true }),
    });

    expect(result.outcome).toBe("blocked");
    expect(events.events.find((e) => e.eventType === "merge.blocked")?.payload).toMatchObject({ posture: "strict" });
  });
});

// apex v91 ROOT CAUSE (composer-attributable): the greenfield PR head was the COMPOSED
// commit, authored `Tanren Composer <composer@tanren.invalid>` → GitHub `author.login = null`
// → the external-change gate keyed it `<unknown>` external → BLOCKED every auto-merge under
// lenient/strict (173× `merge.blocked` on v91, not one PR merged). The fix authors the
// composed commit as the run's RESOLVED bot login — the SAME login the merge stage's
// `resolveTanrenLogins` puts in the Tanren identity set — so a clean greenfield PR reads as
// Tanren's OWN change (NOT external) and auto-merges, while a genuine outside human still
// blocks. Proven here both as the pure gate decision AND end-to-end through `mergeForRun`.
describe("governance — Tanren's own resolved push identity is internal (apex v91 composer block)", () => {
  const identity = tanrenIdentity([FIXTURE_TANREN_LOGIN]);

  it("the resolved bot login on the PR's only commit is NOT an external change (its own greenfield PR)", () => {
    const assessment = assessExternalChange({ logins: [FIXTURE_TANREN_LOGIN] }, identity);
    expect(assessment.hasExternalChange).toBe(false);
    expect(assessment.externalLogins).toEqual([]);
    // lenient (mirrors strict for external coexistence) PROCEEDS — no operator approval, and
    // it does NOT depend on the known-bot auto-approve set (the identity match is the reason).
    expect(decidePosture("lenient", assessment, { autonomousTier: true, platformLogins: new Set() }).kind).toBe(
      "proceed",
    );
  });

  it("the pre-fix `<unknown>` (unattributed composer commit) IS external and blocks even on the autonomous tier", () => {
    // The v91 shape: an empty/unmapped login. It is NEVER a known-bot, so the autonomous-tier
    // auto-approve can't rescue it — documenting exactly why the unattributable commit blocked.
    const unattributed = assessExternalChange({ logins: [""] }, identity);
    expect(unattributed.hasExternalChange).toBe(true);
    expect(unattributed.externalLogins).toEqual(["<unknown>"]);
    expect(decidePosture("lenient", unattributed, { autonomousTier: true, platformLogins: new Set() }).kind).toBe(
      "block",
    );
  });

  it("a genuine OUTSIDE human committer still blocks under lenient (real external detection intact)", () => {
    const human = assessExternalChange({ logins: [FIXTURE_TANREN_LOGIN, "mallory"] }, identity);
    expect(human.hasExternalChange).toBe(true);
    expect(human.externalLogins).toEqual(["mallory"]);
    expect(decidePosture("lenient", human, { autonomousTier: true, platformLogins: new Set() }).kind).toBe("block");
  });

  // End-to-end through mergeForRun: the merge stage RESOLVES the bot login from the active
  // credential (`resolveTanrenLogins` → `GET /user` → tanren[bot]) and merges it into the
  // identity set — so a PR whose only committer is that resolved login auto-merges under
  // LENIENT with NO configured platformLogins (proving it is the self-identity recognition,
  // not the GAP#3 known-bot set, that clears the block).
  it("lenient + native_queue + auto + ONLY the resolved bot login committer → auto-merges (no strand, no platformLogins needed)", async () => {
    const pool = new ReviewMergePool("native_queue", "lenient", "auto");
    const events = new FakeEventStore();
    const host = authorityHost();
    const landed: string[] = [];
    const botOnlyProbe: ContributorProbe = { listContributors: async () => ({ logins: [FIXTURE_TANREN_LOGIN] }) };

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: await tanrenSecrets(),
      resolveConflict: noopConflictResolver,
      githubHttp: tanrenUserHttp(),
      runId: "run_1",
      mergeProbe: recordingMergeProbe(),
      mergeAuthority: authorityBundle(host, landed, { events }),
      contributorProbe: botOnlyProbe,
      enqueueNativeQueue: async () => ({ queueId: "mq_1", created: true }),
    });

    expect(result.outcome).toBe("queued");
    expect(events.events.find((e) => e.eventType === "merge.blocked")).toBeUndefined();
    expect(events.events.some((e) => e.eventType === "merge.queued")).toBe(true);
  });

  // The contrast case: a genuine outside human on the same lenient/autonomous run STILL
  // blocks (with NO known-bot set to rescue it) — Tanren's own-identity clearance must not
  // weaken real external detection.
  it("lenient + native_queue + auto + a genuine outside human committer → STILL blocks", async () => {
    const pool = new ReviewMergePool("native_queue", "lenient", "auto");
    const events = new FakeEventStore();
    const host = authorityHost();
    const landed: string[] = [];
    const humanProbe: ContributorProbe = {
      listContributors: async () => ({ logins: [FIXTURE_TANREN_LOGIN, "mallory"] }),
    };

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: await tanrenSecrets(),
      resolveConflict: noopConflictResolver,
      githubHttp: tanrenUserHttp(),
      runId: "run_1",
      mergeProbe: recordingMergeProbe(),
      mergeAuthority: authorityBundle(host, landed, { events }),
      contributorProbe: humanProbe,
      enqueueNativeQueue: async () => ({ queueId: "mq_1", created: true }),
    });

    expect(result.outcome).toBe("blocked");
    expect(events.events.find((e) => e.eventType === "merge.blocked")?.payload).toMatchObject({
      posture: "lenient",
      externalLogins: ["mallory"],
    });
    expect(landed).toEqual([]);
  });
});
