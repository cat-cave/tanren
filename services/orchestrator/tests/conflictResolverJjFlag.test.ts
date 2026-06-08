// Unit test for the `CONFLICT_RESOLVER_JJ_LIVE` kill-switch (conflictResolverJjFlag.ts,
// Wave-3/S1). DEFAULT ON (the cutover): only the exact OFF token reverts to the
// git-merge-abort applier; a typo'd value can never silently disable the jj path.

import { afterEach, describe, expect, it } from "vitest";
import { conflictResolverJjLive } from "../src/engine/merge/conflictResolverJjFlag.js";

const prior = process.env["CONFLICT_RESOLVER_JJ_LIVE"];

afterEach(() => {
  if (prior === undefined) delete process.env["CONFLICT_RESOLVER_JJ_LIVE"];
  else process.env["CONFLICT_RESOLVER_JJ_LIVE"] = prior;
});

describe("conflictResolverJjLive", () => {
  it("DEFAULT ON: unset → the jj applier is authoritative", () => {
    delete process.env["CONFLICT_RESOLVER_JJ_LIVE"];
    expect(conflictResolverJjLive()).toBe(true);
  });

  it("kill-switch: the exact OFF token '0' reverts to the git-merge-abort applier", () => {
    process.env["CONFLICT_RESOLVER_JJ_LIVE"] = "0";
    expect(conflictResolverJjLive()).toBe(false);
  });

  it("fail-safe: any other value (a typo) leaves the jj applier authoritative", () => {
    process.env["CONFLICT_RESOLVER_JJ_LIVE"] = "off";
    expect(conflictResolverJjLive()).toBe(true);
    process.env["CONFLICT_RESOLVER_JJ_LIVE"] = "1";
    expect(conflictResolverJjLive()).toBe(true);
  });
});
