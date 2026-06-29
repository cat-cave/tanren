// AUDIT FINDING #14 (HARDENING) — the canonicalizer behind the convergence detector.
// Pins the invariant the inner loop relies on: two SEMANTICALLY-IDENTICAL rejection
// reasons that differ only in incidental nondeterminism — ANSI escape codes, tool-
// reported durations, wall-clock timestamps, run/task/spec id references, vitest's
// trailing summary block, content-addressed hex blobs — canonicalize to the SAME
// string (so the detector's structural read collapses them onto one state and trips
// the fixed-point detector instead of looping forever). A TRULY DIFFERENT failure
// (different tier / step / error class / message body) still hashes differently.
//
// The v64-class confusion the audit named: a sequence of "reason 1 with timestamp A,
// reason 1 with timestamp B" must hash IDENTICALLY (so the detector escalates to the
// residual P0 instead of re-driving forever); a sequence of "real reason 1, real
// reason 2" must still hash DIFFERENTLY (progress is preserved).

import { describe, expect, it } from "vitest";
import { canonicalizeFailureSignature } from "../src/engine/workflow/convergenceSignatureCanonical.js";

describe("canonicalizeFailureSignature — strips incidental nondeterminism", () => {
  it("preserves an empty string (the no-rejection-text upstream path)", () => {
    expect(canonicalizeFailureSignature("")).toBe("");
  });

  it("strips ANSI CSI escape sequences (color codes, cursor moves)", () => {
    const esc = String.fromCodePoint(0x1b);
    const colored = `${esc}[31mFAIL${esc}[0m: ${esc}[1mtypecheck failed${esc}[0m`;
    const plain = "FAIL: typecheck failed";
    expect(canonicalizeFailureSignature(colored)).toBe(canonicalizeFailureSignature(plain));
  });

  it("strips ISO 8601 timestamps wherever they appear", () => {
    const a = '[2026-06-28T12:34:56.789Z] gate tier "fast" failed';
    const b = '[2026-06-28T13:00:00Z] gate tier "fast" failed';
    expect(canonicalizeFailureSignature(a)).toBe(canonicalizeFailureSignature(b));
  });

  it("strips run/task/spec ids (preserving the prefix kind)", () => {
    const a = "task task_550e8400-e29b-41d4-a716-446655440000 failed in run run_abc-123-def";
    const b = "task task_999cafe0-aaaa-bbbb-cccc-1234567890ab failed in run run_xyz-789-uvw";
    expect(canonicalizeFailureSignature(a)).toBe(canonicalizeFailureSignature(b));
    // The CANONICAL form keeps the kind so a `run_` reference is still distinguishable
    // from a `spec_` reference (different semantic shapes).
    const c = "task task_550e8400-e29b-41d4-a716-446655440000 failed in spec spec_xyz-789";
    expect(canonicalizeFailureSignature(a)).not.toBe(canonicalizeFailureSignature(c));
  });

  it("strips durations in units (ms, s, min, sec, hr)", () => {
    const samples = [
      "vitest finished in 12s",
      "vitest finished in 1.4 min",
      "vitest finished in 123 ms",
      "vitest finished in 1 hour",
      "vitest finished in 8.43s",
    ];
    const canonical = samples.map((sample) => canonicalizeFailureSignature(sample));
    // All collapse to the same shape.
    for (const c of canonical) {
      expect(c).toBe(canonical[0]);
    }
  });

  it("strips parenthesized durations like (123 ms) preserving the parens", () => {
    const a = "tests passed (1234 ms)";
    const b = "tests passed (567 ms)";
    expect(canonicalizeFailureSignature(a)).toBe(canonicalizeFailureSignature(b));
    expect(canonicalizeFailureSignature(a)).toContain("(");
    expect(canonicalizeFailureSignature(a)).toContain(")");
  });

  it("strips mm:ss elapsed-time formatting", () => {
    const a = "ran for 15:23";
    const b = "ran for 02:01";
    expect(canonicalizeFailureSignature(a)).toBe(canonicalizeFailureSignature(b));
  });

  it("strips wall-clock hh:mm:ss formatting", () => {
    const a = "Start at 12:34:56";
    const b = "Start at 03:15:42";
    expect(canonicalizeFailureSignature(a)).toBe(canonicalizeFailureSignature(b));
  });

  it("strips vitest's trailing summary block (Test Files / Tests / Duration / Start at)", () => {
    const a = [
      "FAIL tests/foo.test.ts",
      " Test Files  3 failed | 5 passed (8)",
      "      Tests  10 failed | 50 passed (60)",
      "   Start at  12:34:56",
      "   Duration  8.43s (transform 100ms, setup 5ms, collect 200ms, tests 7.5s)",
    ].join("\n");
    const b = [
      "FAIL tests/foo.test.ts",
      " Test Files  4 failed | 6 passed (10)",
      "      Tests  20 failed | 100 passed (120)",
      "   Start at  03:15:42",
      "   Duration  15.21s (transform 200ms, setup 7ms, collect 300ms, tests 14s)",
    ].join("\n");
    expect(canonicalizeFailureSignature(a)).toBe(canonicalizeFailureSignature(b));
  });

  it("strips long content-addressed hex blobs (commit shas, sha256)", () => {
    const a = "merge of abc123def456789012345678 failed";
    const b = "merge of fedcba0987654321abcdef01 failed";
    expect(canonicalizeFailureSignature(a)).toBe(canonicalizeFailureSignature(b));
  });

  it("strips 0x-prefixed pointer / hex addresses", () => {
    const a = "fault at 0xdeadbeef in module";
    const b = "fault at 0xcafe1234 in module";
    expect(canonicalizeFailureSignature(a)).toBe(canonicalizeFailureSignature(b));
  });

  it("normalizes whitespace (collapses runs of spaces/tabs, trims leading/trailing)", () => {
    const a = "   gate    failed\t\ttypecheck\n\n\nstep   ";
    const b = "gate failed typecheck\nstep";
    expect(canonicalizeFailureSignature(a)).toBe(canonicalizeFailureSignature(b));
  });

  it("PRESERVES bare numbers (error counts are MEANINGFUL — the 1000→1 trajectory must read as progress)", () => {
    // Two error counts that differ MUST canonicalize differently — otherwise the
    // detector reads a shrinking trajectory as a fixed point and escalates falsely.
    const a = "Found 1000 type errors";
    const b = "Found 1 type errors";
    expect(canonicalizeFailureSignature(a)).not.toBe(canonicalizeFailureSignature(b));
  });

  it("PRESERVES a genuinely-different failure body (a truly different failure still hashes differently)", () => {
    const a = 'gate tier "fast" failed at step "typecheck" with exit 1';
    const b = 'gate tier "fast" failed at step "lint" with exit 1';
    expect(canonicalizeFailureSignature(a)).not.toBe(canonicalizeFailureSignature(b));
  });
});

describe("canonicalizeFailureSignature — the v64-class confusion (the audit's named class)", () => {
  // The bug shape the audit named: two attempts whose underlying failure is identical
  // but whose surface text differs in timestamps + durations + ids confused the
  // detector into "different failure → progress" and re-drove forever.
  it("'reason 1 with timestamp A' and 'reason 1 with timestamp B' canonicalize IDENTICALLY", () => {
    const attemptA =
      "[2026-06-28T12:34:56.789Z] checker rejected (task task_aaa-111): " +
      "subtask 0 incomplete — missing test for behavior B1 (1.4s)";
    const attemptB =
      "[2026-06-28T13:00:00.001Z] checker rejected (task task_bbb-222): " +
      "subtask 0 incomplete — missing test for behavior B1 (2.0s)";
    const canonicalA = canonicalizeFailureSignature(attemptA);
    const canonicalB = canonicalizeFailureSignature(attemptB);
    expect(canonicalA).toBe(canonicalB);
  });

  it("'real reason 1' and 'real reason 2' canonicalize DIFFERENTLY (progress preserved)", () => {
    const realFailure1 =
      "[2026-06-28T12:34:56Z] checker rejected (task task_aaa-111): " +
      "subtask 0 incomplete — missing test for behavior B1";
    const realFailure2 =
      "[2026-06-28T12:35:00Z] checker rejected (task task_aaa-111): " +
      "subtask 0 incomplete — typecheck error in foo.ts: type 'string' is not assignable to type 'number'";
    expect(canonicalizeFailureSignature(realFailure1)).not.toBe(canonicalizeFailureSignature(realFailure2));
  });

  it("a sequence of identical failures with shifting timestamps / durations / ids ALL collapse onto one signature", () => {
    // Realistic v64 shape: the same gate failure recurring across many attempts, each
    // dressed in fresh nondeterminism. ALL must canonicalize to the SAME string so
    // the detector reads "fixed point" instead of "progress every attempt".
    const attempts = [
      '[2026-06-28T12:34:56Z] task task_aaa-111 — gate tier "fast" failed at step "typecheck" with exit 1 (took 12s)',
      '[2026-06-28T12:35:01Z] task task_bbb-222 — gate tier "fast" failed at step "typecheck" with exit 1 (took 11.4s)',
      '[2026-06-28T12:35:08Z] task task_ccc-333 — gate tier "fast" failed at step "typecheck" with exit 1 (took 13 sec)',
      '[2026-06-28T12:35:15Z] task task_ddd-444 — gate tier "fast" failed at step "typecheck" with exit 1 (took 1.4 min)',
    ];
    const canonical = attempts.map((attempt) => canonicalizeFailureSignature(attempt));
    for (let i = 1; i < canonical.length; i += 1) {
      expect(canonical[i]).toBe(canonical[0]);
    }
  });

  it("a vitest summary tail with shifting counts + duration collapses onto one signature", () => {
    // Realistic vitest output: the underlying FAIL line is the same, only the summary
    // counts + duration shift run-over-run. The detector must NOT read this as progress.
    const baseFail = 'FAIL tests/foo.test.ts > foo > "does the thing"\n  AssertionError: expected 1 to equal 2';
    const summaryA = [
      baseFail,
      "",
      " Test Files  3 failed | 5 passed (8)",
      "      Tests  10 failed | 50 passed (60)",
      "   Start at  12:34:56",
      "   Duration  8.43s (transform 100ms, setup 5ms)",
    ].join("\n");
    const summaryB = [
      baseFail,
      "",
      " Test Files  4 failed | 4 passed (8)",
      "      Tests  15 failed | 45 passed (60)",
      "   Start at  13:01:23",
      "   Duration  9.10s (transform 105ms, setup 6ms)",
    ].join("\n");
    expect(canonicalizeFailureSignature(summaryA)).toBe(canonicalizeFailureSignature(summaryB));
  });

  it("ANSI-colored vitest output collapses with the plain-text equivalent", () => {
    const esc = String.fromCodePoint(0x1b);
    const colored = `${esc}[31mFAIL${esc}[0m tests/foo.test.ts > ${esc}[1mfoo${esc}[0m\n  AssertionError: expected 1 to equal 2`;
    const plain = "FAIL tests/foo.test.ts > foo\n  AssertionError: expected 1 to equal 2";
    expect(canonicalizeFailureSignature(colored)).toBe(canonicalizeFailureSignature(plain));
  });
});

describe("canonicalizeFailureSignature — placeholder shape (operator-readable diagnostic)", () => {
  // The canonical form is also the hash pre-image a human inspects on the timeline.
  // The placeholders are spelled distinctly so a human can see WHERE the canonicalizer
  // collapsed which class of noise (so a real-world fixed point is still debuggable).
  it("uses distinct, readable placeholders for each stripped class", () => {
    const sample = "[2026-06-28T12:34:56Z] task task_aaa-111 failed (1.4s) sha abc123def456789012345678";
    const canonical = canonicalizeFailureSignature(sample);
    expect(canonical).toContain("<ts>");
    expect(canonical).toContain("task_<id>");
    expect(canonical).toContain("<dur>");
    expect(canonical).toContain("<hex>");
  });
});
