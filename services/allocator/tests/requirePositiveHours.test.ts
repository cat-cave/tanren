// Fix #4 — the reap-everything guard. TANREN_MAX_RUN_HOURS becomes the sweeper's
// abandoned threshold (now - hours). A `0` makes the threshold exactly `now`, so
// listActiveOlderThan(now) reaps EVERY active runner (incl. the live apex run);
// `abc` → NaN → an Invalid Date threshold. Parse fail-closed: reject non-finite
// or <= 0, fall back to the default with a LOUD console.error.
import { afterEach, describe, expect, it, vi } from "vitest";
import { requirePositiveHours } from "../src/requirePositiveHours.js";

describe("requirePositiveHours (reaper threshold never <= now)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a strictly positive value", () => {
    expect(requirePositiveHours("6", 6, "TANREN_MAX_RUN_HOURS")).toBe(6);
    expect(requirePositiveHours("0.5", 6, "TANREN_MAX_RUN_HOURS")).toBe(0.5);
    expect(requirePositiveHours("12", 6, "TANREN_MAX_RUN_HOURS")).toBe(12);
  });

  it("uses the default for unset/blank with no error (a normal omission, not a parse failure)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // An unset env var: process.env reads back as `string | undefined`.
    const unset: string | undefined = process.env["TANREN_MAX_RUN_HOURS_DEFINITELY_UNSET"];
    expect(requirePositiveHours(unset, 6, "TANREN_MAX_RUN_HOURS")).toBe(6);
    expect(requirePositiveHours("", 6, "TANREN_MAX_RUN_HOURS")).toBe(6);
    expect(spy).not.toHaveBeenCalled();
  });

  it("(e) `0` falls back to the default with a LOUD error — threshold never <= now", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const hours = requirePositiveHours("0", 6, "TANREN_MAX_RUN_HOURS");
    expect(hours).toBe(6);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatch(/TANREN_MAX_RUN_HOURS/u);
    expect(spy.mock.calls[0]?.[0]).toMatch(/never be <= now/u);
    // The resulting threshold (now - 6h) is strictly in the past, never now.
    const now = Date.now();
    const threshold = now - hours * 3_600_000;
    expect(threshold).toBeLessThan(now);
  });

  it("(e) `abc` (→ NaN) falls back to the default with a LOUD error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const hours = requirePositiveHours("abc", 6, "TANREN_MAX_RUN_HOURS");
    expect(hours).toBe(6);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("rejects a negative value LOUDLY (also a <= now / future threshold)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(requirePositiveHours("-3", 6, "TANREN_MAX_RUN_HOURS")).toBe(6);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("rejects Infinity LOUDLY (non-finite)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(requirePositiveHours("Infinity", 6, "TANREN_MAX_RUN_HOURS")).toBe(6);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
