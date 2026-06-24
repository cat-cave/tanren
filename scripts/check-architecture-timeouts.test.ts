import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkNoArbitraryTimeouts } from "./check-architecture-timeouts.mjs";
import { runArchitectureChecks } from "./check-architecture.mjs";

// The timeout-class eradication lint (feedback_no_timeouts_progress_based). Sibling spec in
// the mold of check-architecture.test.ts: it asserts each flagged form + each bless mechanism.
// The lint is ENFORCED (Phase-1 SEAL): folded into `runArchitectureChecks` (the exit-1 set),
// so a violation FAILS CI. These tests exercise the SCANNER directly + assert the enforcement
// wiring (the gate now exits NON-ZERO on a synthetic violation, was report-only before).
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

  // Task #32 — disguised survivor: a multi-LINE setTimeout whose opener line is bare
  // (no kill verb on the opener line) but whose callback body on a FOLLOWING line
  // rejects/throws/destroys. The original single-line scan missed `staticRunnerAllocator.ts`'s
  // outer discovery timer for exactly this reason (same blind-spot class as ssh2 #638).
  it("flags a MULTI-LINE total-duration kill timer (callback body on a following line)", () => {
    const text =
      "const timer = setTimeout(\n" +
      "  () => settle(() => reject(new Error(`discovery timed out after ${timeoutMs}ms`))),\n" +
      "  timeoutMs,\n" +
      ");\n";
    const flagged = checkNoArbitraryTimeouts([{ file: srcFile, text }]);
    expect(flagged.map((item) => item.rule)).toEqual(["no-arbitrary-timeouts"]);
    expect(flagged[0]?.message).toContain("ActivityWatchdog");
    // The diagnostic points at the OPENER line (the `setTimeout(`), not the kill-verb line.
    expect(flagged[0]?.line).toBe(1);
  });

  it("does NOT flag a multi-line setTimeout whose body merely resolves (no kill verb)", () => {
    const text = "setTimeout(\n  () => resolve(),\n  ms,\n);\n";
    expect(checkNoArbitraryTimeouts([{ file: srcFile, text }])).toEqual([]);
  });

  it("honors `// arch-allow: timeout-class` on a multi-line setTimeout BODY line (oxfmt-stable bless)", () => {
    // The single-line `// arch-allow` annotation can ride the opener line only when the
    // formatter doesn't split the construct across lines. For a multi-line setTimeout the
    // opener line ends in `(` and oxfmt moves a trailing annotation onto the callback body.
    // The lint honors the annotation when it lands on a body line within the lookahead
    // window, so the bless stays attached to the kill timer the formatter chose to shape.
    const text =
      "const timer = setTimeout(() => {\n" +
      "  // arch-allow: timeout-class — discrete one-shot fetch abort, no work to lose\n" +
      "  controller.abort();\n" +
      "}, abortMs);\n";
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

// ENFORCEMENT wiring (Phase-1 SEAL): the lint is no longer report-only — it is part of
// `runArchitectureChecks` (the exit-1 aggregator), so a synthetic timeout-class violation now
// surfaces as a diagnostic AND makes the CLI exit NON-ZERO (it used to print + exit 0).
describe("no-arbitrary-timeouts is CI-GATING (folded into the exit-1 set)", () => {
  const scriptPath = resolve(import.meta.dirname, "check-architecture.mjs");

  it("runArchitectureChecks SURFACES a synthetic timeout violation (it is in the enforced set)", async () => {
    const root = mkdtempSync(join(tmpdir(), "arch-timeout-enforce-"));
    try {
      mkdirSync(join(root, "services/orchestrator/src/engine"), { recursive: true });
      // A banned give-up cap in a production src file — the violation the lint must now gate on.
      writeFileSync(
        join(root, "services/orchestrator/src/engine/violating.ts"),
        "const MAX_DRIVE_ATTEMPTS = 4;\nexport const drive = MAX_DRIVE_ATTEMPTS;\n",
      );
      const diagnostics = await runArchitectureChecks({ root });
      expect(diagnostics.some((d) => d.rule === "no-arbitrary-timeouts")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the CLI EXITS NON-ZERO on a synthetic timeout violation (was report-only / exit 0)", () => {
    const root = mkdtempSync(join(tmpdir(), "arch-timeout-cli-"));
    try {
      mkdirSync(join(root, "services/orchestrator/src/engine"), { recursive: true });
      writeFileSync(
        join(root, "services/orchestrator/src/engine/violating.ts"),
        "const MAX_DRIVE_ATTEMPTS = 4;\nexport const drive = MAX_DRIVE_ATTEMPTS;\n",
      );
      const run = spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8" });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("no-arbitrary-timeouts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
