// The `WALKER_JJ_LOCAL_BASE` flag (walker-jj-local-integration-design.md §7 PR-7) now
// DEFAULTS ON — the SAME polarity as the engine kill-switches. PR-7 flipped it: the
// jj-local base path is the LIVE default, and `WALKER_JJ_LOCAL_BASE=0` is the break-glass
// to the legacy single-ref clone (which stays until PR-9). This pins the default-ON polarity
// so a regression can't silently revert the proven path off in production.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walkerJjLocalBase } from "../src/engine/dag/walkerJjLocalBaseFlag.js";

describe("WALKER_JJ_LOCAL_BASE flag (default-ON, kill-switch via `0`)", () => {
  const KEY = "WALKER_JJ_LOCAL_BASE";
  let prior: string | undefined;

  beforeEach(() => {
    prior = process.env[KEY];
    delete process.env[KEY];
  });
  afterEach(() => {
    if (prior === undefined) delete process.env[KEY];
    else process.env[KEY] = prior;
  });

  it("DEFAULT ON: unset ⇒ true (production takes the jj-local base path)", () => {
    delete process.env[KEY];
    expect(walkerJjLocalBase()).toBe(true);
  });

  it("OFF only for the explicit `0` token (break-glass to the legacy single-ref clone)", () => {
    process.env[KEY] = "0";
    expect(walkerJjLocalBase()).toBe(false);
  });

  it("ON for the explicit `1` token", () => {
    process.env[KEY] = "1";
    expect(walkerJjLocalBase()).toBe(true);
  });

  it('any other value stays ON (kill-switch `!== "0"` polarity — only `0` reverts)', () => {
    for (const value of ["true", "on", "yes", "", " 0 ", "2"]) {
      process.env[KEY] = value;
      expect(walkerJjLocalBase()).toBe(true);
    }
  });
});
