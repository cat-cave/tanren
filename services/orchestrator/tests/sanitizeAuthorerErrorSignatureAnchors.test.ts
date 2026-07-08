// Round III H3 (Codex, verified via `node -e`): the sanitizer's retry-after
// and ms regexes over-matched. Both regressions verified against the pre-fix
// regexes; the fixes anchor the regex boundaries so distinct failure classes
// / progressing dep-version pairs no longer collapse into the same signature
// (a false fixed-point on a legitimately-progressing writer).
//
// The base positive-case coverage for the sanitizer lives in
// `fragmentAuthoringLoopBudget.test.ts` under "Fix 2 — sanitize authorer-threw
// signature"; this file is scoped to the H3 hazard + boundary regressions.

import { describe, expect, it } from "vitest";
import { sanitizeAuthorerErrorSignature } from "../src/engine/templates/index.js";

describe("Round III H3 — retry-after regex requires the unit to have a boundary", () => {
  it("does NOT eat the leading `s` of an adjacent word (word after remains intact)", () => {
    // Prior behavior: the single-`s` unit greedy-matched into the following
    // word, so `retry after 12 sockets are open` collapsed to a signature
    // where the leading `s` of `sockets` had been eaten as the unit. Every
    // error of shape `retry after N s <word>` folded into the same signature.
    const sanitized = sanitizeAuthorerErrorSignature("retry after 12 sockets are open");
    expect(sanitized).toBe("retry-after:<N> sockets are open");
  });

  it("does NOT eat the leading `s` of an adjacent lowercase word starting with `s`", () => {
    // Sibling case: `slots`, `sec` shorter than 3, etc.
    const sanitized = sanitizeAuthorerErrorSignature("retry after 5 slots freed");
    expect(sanitized).toBe("retry-after:<N> slots freed");
  });

  it("still matches unit at end of input (positive: no word after)", () => {
    expect(sanitizeAuthorerErrorSignature("retry after 30s")).toBe("retry-after:<N>");
  });

  it("still matches unit followed by punctuation (positive: `s. Try later.`)", () => {
    expect(sanitizeAuthorerErrorSignature("retry after 30s. Try later.")).toBe("retry-after:<N>. Try later.");
  });

  it("still matches Retry-After with no unit at all (positive: `Retry-After: 12`)", () => {
    expect(sanitizeAuthorerErrorSignature("Retry-After: 12")).toBe("retry-after:<N>");
  });

  it("still matches `retry after N seconds` where the full `seconds` word is present", () => {
    expect(sanitizeAuthorerErrorSignature("please retry after 30 seconds")).toBe("please retry-after:<N>");
  });
});

describe("Round III H3 — ms regex requires a whitespace/paren/start boundary before the digit", () => {
  it("does NOT collapse hyphen-embedded `1ms` inside an npm-style package name", () => {
    // Prior behavior: `\b\d+…ms\b` matched the `1ms` inside `foo-1ms-cache-bar`
    // (word boundary fires at the `-`/`1` transition). Distinct dep versions
    // `foo-1ms-x` and `foo-2ms-x` collapsed identically.
    const sanitized = sanitizeAuthorerErrorSignature("installed foo-1ms-cache-bar");
    expect(sanitized).toBe("installed foo-1ms-cache-bar");
  });

  it("distinct dep versions with hyphen-embedded numeric segments hash to DIFFERENT signatures", () => {
    // The failure mode this closes: a writer iterating dep versions ships
    // `foo-1ms-cache` on attempt N and `foo-2ms-cache` on attempt N+1 — the
    // pre-fix sanitizer collapsed both to `foo-<MS>-cache`, giving the F2
    // fixed-point a false positive on real progress.
    const a = sanitizeAuthorerErrorSignature("installed foo-1ms-cache-bar");
    const b = sanitizeAuthorerErrorSignature("installed foo-2ms-cache-bar");
    expect(a).not.toBe(b);
  });

  it("still collapses `1ms elapsed` (positive: leading digit at start-of-string)", () => {
    expect(sanitizeAuthorerErrorSignature("1ms elapsed")).toBe("<MS> elapsed");
  });

  it("still collapses `took 4200ms and failed` (positive: leading digit after whitespace)", () => {
    expect(sanitizeAuthorerErrorSignature("operation took 4200ms and failed")).toBe("operation took <MS> and failed");
  });

  it("still collapses `elapsed 12.3 ms` (positive: fractional after whitespace)", () => {
    expect(sanitizeAuthorerErrorSignature("elapsed 12.3 ms")).toBe("elapsed <MS>");
  });

  it("still collapses ms after paren / bracket (positive: `(5ms)` / `[10ms]`)", () => {
    expect(sanitizeAuthorerErrorSignature("call (5ms) done")).toBe("call (<MS>) done");
    expect(sanitizeAuthorerErrorSignature("call [10ms] done")).toBe("call [<MS>] done");
  });
});

describe("Round III H3 — semver-style dep pins hash to distinct signatures", () => {
  it("`vitest@^4.0.0` and `vitest@^5.0.0` are NOT collapsed to the same signature", () => {
    // Regression: these are neither Unix timestamps nor ms values nor
    // retry-after clocks, so they should pass through untouched. A writer
    // iterating major versions must not trip the F2 fixed-point detector.
    const a = sanitizeAuthorerErrorSignature("dep-mismatch: vitest@^4.0.0 required but ^5.0.0 installed");
    const b = sanitizeAuthorerErrorSignature("dep-mismatch: vitest@^5.0.0 required but ^4.0.0 installed");
    expect(a).not.toBe(b);
    // And the semver chars themselves are preserved (no ms/timestamp
    // accidental match on `4.0.0` etc.).
    expect(a).toContain("^4.0.0");
    expect(a).toContain("^5.0.0");
  });
});
