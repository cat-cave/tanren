// The `WALKER_JJ_LOCAL_BASE` flag (walker-jj-local-integration-design.md §7 PR-4) is the
// ONE engine flag that defaults OFF — the OPPOSITE polarity of the kill-switches. It is a
// build-forward gate: the jj-local base path is reachable ONLY when an operator EXPLICITLY
// sets `WALKER_JJ_LOCAL_BASE=1`. PR-7 flips the default; PR-9 removes the flag. This pins
// the default-OFF polarity so a regression (e.g. copying the `!== "0"` kill-switch shape)
// can't silently make the unproven path live in production.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walkerJjLocalBase } from "../src/engine/dag/walkerJjLocalBaseFlag.js";

describe("WALKER_JJ_LOCAL_BASE flag (default-OFF, opt-in)", () => {
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

  it("DEFAULT OFF: unset ⇒ false (production keeps the legacy single-ref clone)", () => {
    delete process.env[KEY];
    expect(walkerJjLocalBase()).toBe(false);
  });

  it("ON only for the explicit `1` token", () => {
    process.env[KEY] = "1";
    expect(walkerJjLocalBase()).toBe(true);
  });

  it('any other value stays OFF (no kill-switch `!== "0"` polarity — a typo can\'t enable it)', () => {
    for (const value of ["0", "true", "on", "yes", "", " 1 ", "2"]) {
      process.env[KEY] = value;
      expect(walkerJjLocalBase()).toBe(false);
    }
  });
});
