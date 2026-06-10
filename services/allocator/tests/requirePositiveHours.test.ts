// The reap-everything guard + no-silent-fallback (Codex r4 §1).
// TANREN_MAX_RUN_HOURS becomes the sweeper's abandoned threshold (now - hours) AND
// derives the scoped-credential token TTL. A `0` makes the threshold exactly `now`,
// so listActiveOlderThan(now) reaps EVERY active runner (incl. the live apex run);
// `abc` → NaN → an Invalid Date threshold. The default applies ONLY when UNSET/blank;
// a PRESENT non-positive / malformed value is a deploy-config PARSE failure that
// THROWS loud (it must NOT silently degrade to the default, masking a typo'd value).
import { describe, expect, it } from "vitest";
import { requirePositiveHours } from "../src/requirePositiveHours.js";

describe("requirePositiveHours (UNSET defaults, PRESENT-malformed throws)", () => {
  it("accepts a strictly positive value", () => {
    expect(requirePositiveHours("6", 6, "TANREN_MAX_RUN_HOURS")).toBe(6);
    expect(requirePositiveHours("0.5", 6, "TANREN_MAX_RUN_HOURS")).toBe(0.5);
    expect(requirePositiveHours("12", 6, "TANREN_MAX_RUN_HOURS")).toBe(12);
  });

  it("uses the default ONLY for unset/blank (a normal omission, not a parse failure)", () => {
    // An unset env var reads back as `string | undefined`.
    const unset: string | undefined = process.env["TANREN_MAX_RUN_HOURS_DEFINITELY_UNSET"];
    expect(requirePositiveHours(unset, 6, "TANREN_MAX_RUN_HOURS")).toBe(6);
    expect(requirePositiveHours("", 6, "TANREN_MAX_RUN_HOURS")).toBe(6);
  });

  it("THROWS LOUD on `0` — a present value, never silently the default (threshold never <= now)", () => {
    expect(() => requirePositiveHours("0", 6, "TANREN_MAX_RUN_HOURS")).toThrow(
      /TANREN_MAX_RUN_HOURS='0' is not a positive number/u,
    );
  });

  it("THROWS LOUD on `abc` (→ NaN), `-3` (negative), and `Infinity` (non-finite)", () => {
    for (const bad of ["abc", "-3", "Infinity"]) {
      expect(() => requirePositiveHours(bad, 6, "TANREN_MAX_RUN_HOURS")).toThrow(/is not a positive number/u);
    }
  });
});
