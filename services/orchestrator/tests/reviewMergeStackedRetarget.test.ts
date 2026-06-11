// walker-jj-local-integration-design.md §3.2/§3.3: the STACKED-PR RETARGET WALK at the
// merge stage (jj-local, unconditional). A dependent is stacked on an ordered ancestor stack
// (`runs.ancestor_stack`); each ancestor merge walks the PR base ONE step down the stack — to
// the next still-unmerged ancestor's PR-head branch, then to `default_branch` once the stack
// empties — and drops the merged head from `runs.ancestor_stack`. The merge HOLD is
// UNCHANGED: the MERGE still waits for ALL ancestors.

import { describe, expect, it } from "vitest";
import { vcsProviderOver } from "./helpers/vcsProvider.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { mergeForRun } from "../src/engine/workflow/reviewMerge/index.js";
import { resolveStackRetarget } from "../src/engine/workflow/reviewMerge/speculativeStackRetarget.js";
import type { AncestorStack } from "../src/engine/dag/ancestorStack.js";
import { noopConflictResolver } from "./fixtures/noopConflictResolver.js";
import {
  AUTHORITY_HEAD_SHA,
  authorityBundle,
  authorityHost,
  recordingMergeProbe,
  ReviewMergePool,
  unusedHttp,
} from "./reviewMerge.fixtures.js";

const member = (specId: string, branch: string): AncestorStack[number] => ({
  specId,
  runId: `run_${specId}`,
  branch,
  headSha: "a".repeat(40),
});

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
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(unusedHttp()),
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
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(unusedHttp()),
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
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      vcsProvider: vcsProviderOver(unusedHttp()),
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
});
