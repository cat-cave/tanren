import { describe, expect, it } from "vitest";
import { checkNoArbitraryTimeouts } from "./check-architecture-timeouts.mjs";

// The timeout-class eradication lint (feedback_no_timeouts_progress_based). Sibling spec in
// the mold of check-architecture.test.ts: it asserts each flagged form + each bless mechanism.
// The lint ships in REPORT mode (the orchestrator prints, does not fail CI yet); these tests
// exercise the SCANNER directly, independent of report/enforce wiring.
describe("no-arbitrary-timeouts (timeout-class eradication lint)", () => {
  const srcFile = "services/orchestrator/src/engine/sample.ts";

  it("flags a total-duration kill timer (setTimeout that fails/destroys)", () => {
    const text = 'const t = setTimeout(() => fail("timed out", true), command.timeoutMs);\n';
    const flagged = checkNoArbitraryTimeouts([{ file: srcFile, text }]);
    expect(flagged.map((item) => item.rule)).toEqual(["no-arbitrary-timeouts"]);
    expect(flagged[0]?.message).toContain("ActivityWatchdog");
  });

  it("does NOT flag a benign deferred tick (setTimeout with no kill verb)", () => {
    const text = "setTimeout(() => resolve(), ms);\n";
    expect(checkNoArbitraryTimeouts([{ file: srcFile, text }])).toEqual([]);
  });

  it("flags a fixed loop cap (attempt/poll/iteration max), for and while forms", () => {
    const forCap = "for (let i = 0; i < maxAttempts; i += 1) {\n";
    const whileCap = "while (attempt < limit) {\n";
    const flagged = checkNoArbitraryTimeouts([{ file: srcFile, text: forCap + whileCap }]);
    expect(flagged.map((item) => item.message)).toEqual([
      expect.stringContaining("retryUntilConverged"),
      expect.stringContaining("retryUntilConverged"),
    ]);
  });

  it("flags a give-up counter identifier (the generic /max.*(retr|stall|poll)/ family)", () => {
    const text = "if (i > maxStallChecks) escalate();\n";
    const flagged = checkNoArbitraryTimeouts([{ file: srcFile, text }]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.message).toContain("intelligent non-convergence");
  });

  it("flags an explicitly-enumerated banned give-up identifier (maxRetriesPerTransient)", () => {
    const text = "const cap = maxRetriesPerTransient;\n";
    const flagged = checkNoArbitraryTimeouts([{ file: srcFile, text }]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.message).toContain("banned timeout/attempt-cap identifier");
  });

  it("flags a whole-op wall-clock deadline (Date.now() + budget)", () => {
    const text = "const deadline = Date.now() + maxBudgetMs;\n";
    const flagged = checkNoArbitraryTimeouts([{ file: srcFile, text }]);
    expect(flagged.map((item) => item.message)).toEqual([expect.stringContaining("bound on progress")]);
  });

  it("flags a fixed quiet-window / no-output-for-N watchdog (a disguised timeout)", () => {
    const text = "if (quietForMs > stallTimeoutMs) kill();\n";
    const flagged = checkNoArbitraryTimeouts([{ file: srcFile, text }]);
    expect(flagged.map((item) => item.message)).toContain(
      "fixed quiet-window / no-output-for-N watchdog (a DISGUISED timeout) — use a LivenessProbe",
    );
  });

  it("flags the banned 600_000 timeout + MAX_*_ATTEMPTS identifier families", () => {
    const text = "const DEFAULT_TIMEOUT_MS = 600_000;\nconst MAX_INFRA_HOLD_ATTEMPTS = 4;\n";
    const flagged = checkNoArbitraryTimeouts([{ file: srcFile, text }]);
    expect(flagged).toHaveLength(2);
    expect(flagged[0]?.message).toContain("DEFAULT_TIMEOUT_MS");
    expect(flagged[1]?.message).toContain("MAX_INFRA_HOLD_ATTEMPTS");
  });

  it("blesses an enumerated allowlisted identifier (KEYGEN_MAX_ATTEMPTS, maxIterations)", () => {
    const text = "const KEYGEN_MAX_ATTEMPTS = 5;\nfor (let i = 0; i < maxIterations; i += 1) {}\n";
    expect(checkNoArbitraryTimeouts([{ file: srcFile, text }])).toEqual([]);
  });

  it("honors the per-line // arch-allow: timeout-class annotation", () => {
    const text = 'setTimeout(() => fail("x"), ms); // arch-allow: timeout-class — connect handshake, no work to lose\n';
    expect(checkNoArbitraryTimeouts([{ file: srcFile, text }])).toEqual([]);
  });

  it("ignores tests/ and a taxonomy word in prose / JSDoc", () => {
    const testFile = "services/orchestrator/tests/foo.test.ts";
    const kill = 'const t = setTimeout(() => fail("x"), ms);\n';
    expect(checkNoArbitraryTimeouts([{ file: testFile, text: kill }])).toEqual([]);
    const prose = "// We never use a DEFAULT_TIMEOUT_MS kill timer here.\nexport const x = 1;\n";
    expect(checkNoArbitraryTimeouts([{ file: srcFile, text: prose }])).toEqual([]);
  });
});
