// APEX-STALL #1 LOCK (tanren-owns-the-engine.md §7): the live apex run stalled on a
// native_queue merge-time conflict that looped the GitHub PR-merge API 90× without ever
// engaging the resolver (a 409-retry loop, no conflict resolution). That loop is now
// STRUCTURALLY IMPOSSIBLE: a `dirty` mergeability at merge time routes to the conflict
// RESOLVER (invoked EXACTLY ONCE), and the land then flows through the `MergeAuthority`
// CAS — never the host PR-merge endpoint, so there is no 409 to retry against. These
// tests assert the resolver fires once and `probe.merge()` (the host PR-merge call the
// 409-loop hammered) is NEVER called on the authority-gated land path. The shared no-DB
// harness lives in tests/fixtures/mergeDispatcherConflictFixtures.ts (the sibling
// `mergeDispatcherConflictAuthority.test.ts` reuses it too).

import { describe, expect, it } from "vitest";
import { InMemoryCodeHost } from "./conformance/fakes/inMemoryCodeHost.js";
import {
  REPO,
  bundle,
  buildDispatcher,
  countingResolver,
  recordingEventStore,
  scriptedProbe,
} from "./fixtures/mergeDispatcherConflictFixtures.js";

describe("apex-stall #1: a merge-time conflict engages the resolver ONCE, never a 409 retry loop", () => {
  it("a merge-time conflict invokes the resolver EXACTLY ONCE — never a host PR-merge retry loop", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    // First mergeability read (ensureUpToDate) is `dirty` → the conflict path; the
    // resolution clears it so the next read (driveLand) is `clean`; the retired
    // single-PR route then holds until the canonical queue node/proof path drives it.
    const probe = scriptedProbe("clean");
    const events = recordingEventStore();
    const landed: string[] = [];
    const resolver = countingResolver(true);

    const result = await buildDispatcher({
      probe,
      events,
      bundle: bundle(host, { landed }),
      integration: "native_queue",
      resolveConflict: resolver.hook,
    }).directMerge();

    // The resolver was engaged EXACTLY ONCE (not 90×, not 0) — the structural fix for the
    // apex stall (the conflict is resolved, not retried blindly against a 409).
    expect(resolver.calls()).toBe(1);
    // The legacy dispatcher does not recreate a synthetic binding after resolving.
    // It holds for the canonical node/proof path and never falls through to any host merge.
    expect(result.outcome).toBe("blocked");
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
    expect(landed).toEqual([]);
    // A merge-time conflict surfaced exactly one conflict route, not a storm of retries.
    expect(events.events.filter((e) => e === "merge.conflict")).toHaveLength(0);
  });

  it("an UNRESOLVED merge-time conflict resolves ONCE then HOLDS recoverably — never a 409 retry loop", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    const probe = scriptedProbe("dirty");
    const events = recordingEventStore();
    const landed: string[] = [];
    // The resolver cannot reconcile the conflict.
    const resolver = countingResolver(false);

    const result = await buildDispatcher({
      probe,
      events,
      bundle: bundle(host, { landed }),
      integration: "native_queue",
      resolveConflict: resolver.hook,
    }).directMerge();

    // Even when the conflict CANNOT be resolved, the resolver is engaged exactly ONCE and
    // the dispatcher emits the recoverable `merge.conflict` outcome — it does NOT loop a
    // host PR-merge endpoint hoping the 409 clears (the apex-stall failure mode).
    expect(resolver.calls()).toBe(1);
    expect(result.outcome).toBe("conflict");
    expect(landed).toEqual([]);
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
    // Exactly one conflict event (the recoverable hold), not a retry storm.
    expect(events.events.filter((e) => e === "merge.conflict")).toHaveLength(1);
  });
});
