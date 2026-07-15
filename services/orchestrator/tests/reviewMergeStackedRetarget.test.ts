// walker-jj-local-integration-design.md §3.2/§3.3 + gv-4 transitive safety:
// the STACKED-PR RETARGET WALK at the merge stage. A dependent is stacked on an
// ordered ancestor stack (`runs.ancestor_stack`); each ancestor merge walks the
// PR base ONE step down the stack — to the next still-unmerged ancestor's
// PR-head branch, then to `default_branch` once the stack empties — and drops
// the merged head from `runs.ancestor_stack`. Membership is the COMPLETE
// persisted member vector, never direct-only `depends_on`. The merge HOLD is
// UNCHANGED: the MERGE still waits for ALL ancestors.

import { describe, expect, it } from "vitest";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { mergeForRun } from "../src/engine/workflow/reviewMerge/index.js";
import {
  ancestorStackMemberSpecIds,
  resolveStackRetarget,
} from "../src/engine/workflow/reviewMerge/speculativeStackRetarget.js";
import type { AncestorStack } from "../src/engine/dag/ancestorStack.js";
import { noopConflictResolver } from "./fixtures/noopConflictResolver.js";
import {
  AUTHORITY_HEAD_SHA,
  ReviewMergePool,
  authorityBundle,
  authorityHost,
  fakeMergeWriter,
  recordingMergeProbe,
  unusedHttp,
} from "./reviewMerge.fixtures.js";

const member = (specId: string, branch: string): AncestorStack[number] => ({
  specId,
  runId: `run_${specId}`,
  branch,
  headSha: "a".repeat(40),
});

const chain6: AncestorStack = [
  member("spec_a", "tanren/run_a"),
  member("spec_b", "tanren/run_b"),
  member("spec_c", "tanren/run_c"),
  member("spec_d", "tanren/run_d"),
  member("spec_e", "tanren/run_e"),
  member("spec_f", "tanren/run_f"),
];

describe("resolveStackRetarget (pure walk target)", () => {
  it("drops merged heads and targets the IMMEDIATE still-unmerged ancestor branch", () => {
    const stack: AncestorStack = [member("spec_a", "br_a"), member("spec_b", "br_b"), member("spec_c", "br_c")];
    // spec_a merged → the immediate (last) remaining is spec_c.
    const r = resolveStackRetarget(stack, new Set(["spec_a"]), "main");
    expect(r.toBase).toBe("br_c");
    expect(r.remainingStack.map((m) => m.specId)).toEqual(["spec_b", "spec_c"]);
  });

  it("walks to default_branch once the stack empties (all merged)", () => {
    const stack: AncestorStack = [member("spec_a", "br_a"), member("spec_b", "br_b")];
    const r = resolveStackRetarget(stack, new Set(["spec_a", "spec_b"]), "main");
    expect(r.toBase).toBe("main");
    expect(r.remainingStack).toEqual([]);
  });

  it("a blank-branch immediate ancestor falls back to default_branch (defensive)", () => {
    const stack: AncestorStack = [{ specId: "spec_a", runId: "", branch: "", headSha: "a".repeat(40) }];
    const r = resolveStackRetarget(stack, new Set(), "main");
    expect(r.toBase).toBe("main");
  });

  it("NEGATIVE: incomplete direct-only merged set leaves a merged transitive ancestor as base", () => {
    // Depth-6: only the direct parent is marked merged (the pre-gv-4 defect shape).
    // The walk MUST leave a stale merged transitive as toBase — proving that
    // direct-only membership is insufficient. The production path below must
    // NOT use this incomplete set.
    const directOnly = new Set(["spec_f"]);
    const incomplete = resolveStackRetarget(chain6, directOnly, "main");
    expect(incomplete.toBase).not.toBe("main");
    expect(incomplete.remainingStack.map((m) => m.specId)).toEqual(["spec_a", "spec_b", "spec_c", "spec_d", "spec_e"]);
    // Complete member vector empties the stack and targets default_branch.
    const full = new Set(ancestorStackMemberSpecIds(chain6));
    const complete = resolveStackRetarget(chain6, full, "main");
    expect(complete.toBase).toBe("main");
    expect(complete.remainingStack).toEqual([]);
  });
});

describe("stacked-PR retarget walk (merge stage)", () => {
  it("walks the base ONE step to the next ancestor while the merge stays HELD; drops the merged head", async () => {
    const pool = new ReviewMergePool("direct_merge");
    pool.specDependsOn = ["spec_a", "spec_b"];
    // immediate-below ancestor a merged; b still unmerged.
    pool.mergedAncestors = ["spec_a"];
    pool.ancestorStack = [member("spec_a", "tanren/run_a"), member("spec_b", "tanren/run_b")];
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({
      mergeability: { state: "clean", behind: false, baseBranch: "tanren/run_a", headBranch: "tanren/run_1" },
    });
    const host = authorityHost();
    const landed: string[] = [];

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
    });

    // The merge is still HELD (spec_b unmerged) — never landed.
    expect(result.outcome).toBe("blocked");
    expect(landed).toEqual([]);
    // The base walked ONE step: live base tanren/run_a → next still-unmerged tanren/run_b.
    expect(probe.retargetedBases).toEqual(["tanren/run_b"]);
    // The merged head (spec_a) was dropped from runs.ancestor_stack.
    expect(pool.ancestorStackWrites).toEqual([{ runId: "run_1", stack: [member("spec_b", "tanren/run_b")] }]);
    const retargeted = events.events.find((e) => e.eventType === "merge.retargeted");
    expect(retargeted?.payload).toMatchObject({ fromBase: "tanren/run_a", toBase: "tanren/run_b" });
    // The hold event still fires (merge waits for ALL ancestors).
    expect(events.events.some((e) => e.eventType === "merge.speculative_held")).toBe(true);
  });

  it("DIAMOND/3-ancestor: walks to default_branch + merges once the stack empties", async () => {
    const pool = new ReviewMergePool("direct_merge");
    pool.specDependsOn = ["spec_a", "spec_b", "spec_c"];
    // all landed → hold clears.
    pool.mergedAncestors = ["spec_a", "spec_b", "spec_c"];
    pool.ancestorStack = [
      member("spec_a", "tanren/run_a"),
      member("spec_b", "tanren/run_b"),
      member("spec_c", "tanren/run_c"),
    ];
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({
      mergeabilityReads: [
        // walk read: live base is the last-still-unmerged from a PRIOR pass (tanren/run_c).
        { state: "clean", behind: false, baseBranch: "tanren/run_c", headBranch: "tanren/run_1" },
        // directMerge's own up-to-date read after the retarget to main, then the authority
        // land's re-read (both clean — the sticky last entry).
        { state: "clean", behind: false, baseBranch: "main", headBranch: "tanren/run_1" },
      ],
    });
    const host = authorityHost();
    const landed: string[] = [];

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
    });

    expect(result.outcome).toBe("merged");
    // Stack emptied → retarget to default_branch (main) before the land.
    expect(probe.retargetedBases).toEqual(["main"]);
    expect(landed).toEqual([AUTHORITY_HEAD_SHA]);
    // The whole stack was dropped.
    expect(pool.ancestorStackWrites).toEqual([{ runId: "run_1", stack: [] }]);
    const retargeted = events.events.find((e) => e.eventType === "merge.retargeted");
    expect(retargeted?.payload).toMatchObject({ fromBase: "tanren/run_c", toBase: "main" });
    expect(events.events.some((e) => e.eventType === "merge.completed")).toBe(true);
    expect(events.events.some((e) => e.eventType === "merge.speculative_held")).toBe(false);
  });

  it("steady state (live base already the walk target, no drop): no retarget, no write", async () => {
    const pool = new ReviewMergePool("direct_merge");
    pool.specDependsOn = ["spec_a", "spec_b"];
    // nothing merged yet.
    pool.mergedAncestors = [];
    pool.ancestorStack = [member("spec_a", "tanren/run_a"), member("spec_b", "tanren/run_b")];
    const events = new FakeEventStore();
    // Live base already equals the immediate ancestor (tanren/run_b) — no walk needed.
    const probe = recordingMergeProbe({
      mergeability: { state: "clean", behind: false, baseBranch: "tanren/run_b", headBranch: "tanren/run_1" },
    });
    const host = authorityHost();
    const landed: string[] = [];

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
    });

    // still held (nothing merged); base already correct; stack unchanged → no write.
    expect(result.outcome).toBe("blocked");
    expect(probe.retargetedBases).toEqual([]);
    expect(pool.ancestorStackWrites).toEqual([]);
    expect(events.events.some((e) => e.eventType === "merge.retargeted")).toBe(false);
  });

  it("gv-4 depth-6: transitive merged ancestors retarget to default_branch even when depends_on is direct-only", async () => {
    // Defect shape: depth-6 chain; specs.depends_on lists only the immediate parent.
    // All six stack members are genuinely merged. Pre-gv-4 code would pass only
    // [spec_f] into the merged query → remaining stack kept a–e → toBase = e, not main.
    const pool = new ReviewMergePool("direct_merge");
    // direct-only — must be ignored for membership
    pool.specDependsOn = ["spec_f"];
    pool.mergedAncestors = ["spec_a", "spec_b", "spec_c", "spec_d", "spec_e", "spec_f"];
    pool.ancestorStack = chain6;
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({
      mergeabilityReads: [
        { state: "clean", behind: false, baseBranch: "tanren/run_f", headBranch: "tanren/run_1" },
        { state: "clean", behind: false, baseBranch: "main", headBranch: "tanren/run_1" },
      ],
    });
    const host = authorityHost();
    const landed: string[] = [];

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
    });

    expect(result.outcome).toBe("merged");
    expect(probe.retargetedBases).toEqual(["main"]);
    expect(pool.ancestorStackWrites).toEqual([{ runId: "run_1", stack: [] }]);
    const retargeted = events.events.find((e) => e.eventType === "merge.retargeted");
    expect(retargeted?.payload).toMatchObject({ fromBase: "tanren/run_f", toBase: "main" });
    expect(landed).toEqual([AUTHORITY_HEAD_SHA]);
  });

  it("gv-4 depth-6 partial: drops five transitive merged ancestors; holds on unmerged tip", async () => {
    const pool = new ReviewMergePool("direct_merge");
    // direct-only; f unmerged
    pool.specDependsOn = ["spec_f"];
    pool.mergedAncestors = ["spec_a", "spec_b", "spec_c", "spec_d", "spec_e"];
    pool.ancestorStack = chain6;
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({
      mergeability: { state: "clean", behind: false, baseBranch: "tanren/run_a", headBranch: "tanren/run_1" },
    });
    const host = authorityHost();
    const landed: string[] = [];

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
    });

    expect(result.outcome).toBe("blocked");
    expect(landed).toEqual([]);
    // Walk target is the still-unmerged tip, not a stale merged grandparent.
    expect(probe.retargetedBases).toEqual(["tanren/run_f"]);
    expect(pool.ancestorStackWrites).toEqual([{ runId: "run_1", stack: [member("spec_f", "tanren/run_f")] }]);
    const retargeted = events.events.find((e) => e.eventType === "merge.retargeted");
    expect(retargeted?.payload).toMatchObject({ fromBase: "tanren/run_a", toBase: "tanren/run_f" });
    expect(events.events.some((e) => e.eventType === "merge.speculative_held")).toBe(true);
  });

  it("gv-4 depth-6 partial-drop: held speculativeBase records the post-walk tip, not the stale merged immediate ancestor", async () => {
    // Defect shape the old `speculative.ancestorStack.at(-1)` payload had: when the
    // IMMEDIATE (last) stack ancestor is the one that merged, the pre-drop stack tip is
    // a MERGED ancestor. The held event must record the post-walk remaining tip (the
    // next still-unmerged ancestor) via the SAME sole resolver the walk uses — never the
    // stale merged immediate. Only spec_f (the immediate) is merged here; a–e still hold.
    const pool = new ReviewMergePool("direct_merge");
    // direct-only depends_on is irrelevant under gv-4 (membership is the full vector).
    pool.specDependsOn = ["spec_f"];
    // Only the immediate (spec_f) is merged; a–e still hold.
    pool.mergedAncestors = ["spec_f"];
    pool.ancestorStack = chain6;
    const events = new FakeEventStore();
    // Live base is stale at the just-merged immediate (tanren/run_f) so the walk fires.
    const probe = recordingMergeProbe({
      mergeability: { state: "clean", behind: false, baseBranch: "tanren/run_f", headBranch: "tanren/run_1" },
    });
    const host = authorityHost();
    const landed: string[] = [];

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
    });

    // Still HELD — a–e are unmerged.
    expect(result.outcome).toBe("blocked");
    expect(landed).toEqual([]);
    // Walk retargets off the stale merged immediate onto the new post-walk tip (spec_e).
    expect(probe.retargetedBases).toEqual(["tanren/run_e"]);
    expect(pool.ancestorStackWrites).toEqual([
      {
        runId: "run_1",
        stack: [
          member("spec_a", "tanren/run_a"),
          member("spec_b", "tanren/run_b"),
          member("spec_c", "tanren/run_c"),
          member("spec_d", "tanren/run_d"),
          member("spec_e", "tanren/run_e"),
        ],
      },
    ]);
    const retargeted = events.events.find((e) => e.eventType === "merge.retargeted");
    expect(retargeted?.payload).toMatchObject({ fromBase: "tanren/run_f", toBase: "tanren/run_e" });
    // THE assertion that fails under the old `ancestorStack.at(-1)` behavior: the held
    // base is the post-walk remaining tip (spec_e), NOT the stale merged immediate (spec_f).
    const held = events.events.find((e) => e.eventType === "merge.speculative_held");
    expect(held?.payload).toMatchObject({
      speculativeBase: "tanren/run_e",
      unmergedAncestors: ["spec_a", "spec_b", "spec_c", "spec_d", "spec_e"],
    });
    expect(held?.payload?.speculativeBase).not.toBe("tanren/run_f");
  });

  it("gv-4 diamond/fan-in: merged shared + left drop; right remains base; hold retained", async () => {
    // Fan-in: stack [shared, left, right]; depends_on only lists immediate parents.
    const diamond: AncestorStack = [
      member("spec_shared", "tanren/run_shared"),
      member("spec_left", "tanren/run_left"),
      member("spec_right", "tanren/run_right"),
    ];
    const pool = new ReviewMergePool("direct_merge");
    // no transitive shared in depends_on
    pool.specDependsOn = ["spec_left", "spec_right"];
    pool.mergedAncestors = ["spec_shared", "spec_left"];
    pool.ancestorStack = diamond;
    const events = new FakeEventStore();
    const probe = recordingMergeProbe({
      mergeability: {
        state: "clean",
        behind: false,
        baseBranch: "tanren/run_shared",
        headBranch: "tanren/run_1",
      },
    });
    const host = authorityHost();
    const landed: string[] = [];

    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: probe,
      mergeAuthority: authorityBundle(host, landed, { events }),
    });

    expect(result.outcome).toBe("blocked");
    expect(probe.retargetedBases).toEqual(["tanren/run_right"]);
    expect(pool.ancestorStackWrites).toEqual([{ runId: "run_1", stack: [member("spec_right", "tanren/run_right")] }]);
    // shared (transitive) must not remain as base after merge.
    expect(probe.retargetedBases).not.toContain("tanren/run_shared");
    expect(events.events.some((e) => e.eventType === "merge.speculative_held")).toBe(true);
  });
});
