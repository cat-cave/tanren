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
    // The same line satisfies BOTH the original (c) (`Date.now() + … budget` same-line)
    // AND the new (c2) (LHS-name deadline assignment). Both fire — that's intentional;
    // the diagnostic surface is informational, not de-duped across overlapping rules.
    expect(flagged.map((item) => item.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("bound on progress")]),
    );
    expect(flagged.length).toBeGreaterThanOrEqual(1);
  });

  // Task #31 (critic-arc R1 #2 / R2): the cloud-allocator disguised survivor. Its
  // `const deadline = Date.now() + readyTimeoutMs;` has the deadline word as the LHS NAME
  // (keyword before `=`), and the kill-verb companion `if (Date.now() >= deadline) throw …`
  // rides a SEPARATE line. The original `Date.now() + … (deadline|budget)` pattern only
  // matches when the deadline word is on the SAME line as the `Date.now()` RHS — so it
  // scanned past the LHS-name form for 7 months across 5 cloud allocators. Pin the two
  // shapes so the survivor cannot reintroduce itself.
  it("flags a deadline-shape ASSIGNMENT — `const deadline = Date.now() + readyTimeoutMs;` (LHS-name form)", () => {
    // No `(deadline|budget|expir)` word on the RHS — the original (c) pattern does NOT
    // fire here; only the new (c2) deadline-assignment pattern catches it.
    const text = "const deadline = Date.now() + readyTimeoutMs;\n";
    const flagged = checkNoArbitraryTimeouts([{ file: srcFile, text }]);
    expect(flagged.map((item) => item.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("deadline-shape assignment")]),
    );
  });

  it("flags a wall-clock kill COMPARISON on its own line — `if (Date.now() >= deadline) throw …`", () => {
    const text = "if (Date.now() >= deadline) { throw new Error('timeout'); }\n";
    const flagged = checkNoArbitraryTimeouts([{ file: srcFile, text }]);
    expect(flagged.map((item) => item.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("wall-clock kill comparison")]),
    );
  });

  it("does NOT flag a non-Date.now() expiry computed from a TTL (the legitimate KEEP-list shape)", () => {
    // `nowSeconds() + APP_JWT_TTL_SECONDS` is a token-TTL safety-window calc against a
    // REAL external constraint (the forge expires the token); it is not a wall-clock
    // kill on legitimate work. Distinct from `Date.now() + readyTimeoutMs`, so the lint
    // must not fire on this shape.
    const text = "const expiry = nowSeconds() + APP_JWT_TTL_SECONDS;\n";
    expect(checkNoArbitraryTimeouts([{ file: srcFile, text }])).toEqual([]);
  });

  it("honors `// arch-allow: timeout-class` on a deadline-assignment line", () => {
    const text =
      "const deadline = Date.now() + readyTimeoutMs; // arch-allow: timeout-class — lease external bound, not a kill\n";
    expect(checkNoArbitraryTimeouts([{ file: srcFile, text }])).toEqual([]);
  });

  it("honors `// arch-allow: timeout-class` on a wall-clock kill-comparison line", () => {
    const text = "if (Date.now() >= deadline) refresh(); // arch-allow: timeout-class — token-TTL refresh window\n";
    expect(checkNoArbitraryTimeouts([{ file: srcFile, text }])).toEqual([]);
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

  // Task #41 / audit #672 — close the disguised-survivor evasion paths the prior
  // regex set scanned past. Each new pattern carries its own positive test, its own
  // negative shape that must NOT trip, and an `// arch-allow: timeout-class` bless test.

  it("(g) flags AbortSignal.timeout(N) — a primitive wall-clock-kill (audit #672 evasion path)", () => {
    const text = "const signal = AbortSignal.timeout(5000);\n";
    const flagged = checkNoArbitraryTimeouts([{ file: srcFile, text }]);
    expect(flagged.map((item) => item.rule)).toEqual(["no-arbitrary-timeouts"]);
    expect(flagged[0]?.message).toContain("AbortSignal.timeout(N) is a wall-clock kill primitive");
  });

  it("(g) flags AbortSignal.timeout used inline in a fetch options bag", () => {
    const text = "await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });\n";
    const flagged = checkNoArbitraryTimeouts([{ file: srcFile, text }]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.message).toContain("AbortSignal.timeout(N)");
  });

  it("(g) does NOT flag AbortSignal.abort() (the immediate-abort companion, not a wall-clock timer)", () => {
    const text = "controller.abort();\nconst sig = AbortSignal.abort();\n";
    expect(checkNoArbitraryTimeouts([{ file: srcFile, text }])).toEqual([]);
  });

  it("(g) honors `// arch-allow: timeout-class` on an AbortSignal.timeout line", () => {
    const text =
      "const sig = AbortSignal.timeout(5000); // arch-allow: timeout-class — discrete one-shot probe, abort cannot truncate work\n";
    expect(checkNoArbitraryTimeouts([{ file: srcFile, text }])).toEqual([]);
  });

  it("flags the retired native merge-claim TTL disguised as a lease constant (#1023)", () => {
    const text = "export const MERGE_CLAIM_LEASE_MS = 15 * 60 * 1000;\n";
    const flagged = checkNoArbitraryTimeouts([{ file: srcFile, text }]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.message).toContain("MERGE_CLAIM_LEASE_MS");
  });

  it("(h) flags Promise.race against a setTimeout that rejects (the disguised wall-clock wait)", () => {
    const text =
      "await Promise.race([\n" +
      "  work,\n" +
      "  new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),\n" +
      "]);\n";
    const flagged = checkNoArbitraryTimeouts([{ file: srcFile, text }]);
    expect(flagged.some((d) => d.rule === "no-arbitrary-timeouts")).toBe(true);
    expect(flagged.some((d) => d.message.includes("Promise.race against a wall-clock timer"))).toBe(true);
  });

  it("(h) does NOT flag the legitimate poll-with-wakeup Promise.race (sleep raced with a wake signal)", () => {
    // The shape used in services/orchestrator/src/engine/worker/runWorker.ts:139 and
    // services/orchestrator/src/routes/runs/sse.ts:217 — both branches resolve, neither
    // rejects or throws, so the lookahead window contains no kill verb. Untouched.
    const text =
      "const woken = new Promise<void>((resolve) => { this.wakeWaiter = resolve; });\n" +
      "await Promise.race([this.sleep(this.args.intervalMs), woken]);\n";
    expect(checkNoArbitraryTimeouts([{ file: srcFile, text }])).toEqual([]);
  });

  it("(h) flags Promise.race where the kill verb rides the opener line (single-line shape)", () => {
    const text = "await Promise.race([work, timer.then(() => { throw new Error('x'); })]);\n";
    const flagged = checkNoArbitraryTimeouts([{ file: srcFile, text }]);
    expect(flagged.some((d) => d.message.includes("Promise.race against a wall-clock timer"))).toBe(true);
  });

  it("(h) honors `// arch-allow: timeout-class` inside a multi-line Promise.race body window", () => {
    const text =
      "await Promise.race([\n" +
      "  // arch-allow: timeout-class — discrete one-shot, no work to lose\n" +
      "  work,\n" +
      "  new Promise((_, rej) => setTimeout(() => rej(new Error('x')), ms)),\n" +
      "]);\n";
    expect(
      checkNoArbitraryTimeouts([{ file: srcFile, text }]).filter((d) => d.message.includes("Promise.race")),
    ).toEqual([]);
  });

  // (e+) BARE retry-cap identifiers the suffix-only family did not catch. The prior
  // patterns required a leading qualifier (`MAX_X_ATTEMPTS`, `FOO_RETRIES`). A fresh
  // module reintroducing `MAX_ATTEMPTS` / `RETRY_LIMIT` / `MAX_TRIES` / `ATTEMPT_LIMIT` /
  // `RETRY_CAP` / `ATTEMPT_CAP` / `RETRY_COUNT` scanned past the gate — task #41.
  it("(e+) flags BARE retry-cap identifiers (MAX_ATTEMPTS, RETRY_LIMIT, ATTEMPT_LIMIT, MAX_TRIES)", () => {
    const text =
      "const MAX_ATTEMPTS = 4;\n" +
      "const RETRY_LIMIT = 5;\n" +
      "const ATTEMPT_LIMIT = 3;\n" +
      "const MAX_TRIES = 6;\n";
    const flagged = checkNoArbitraryTimeouts([{ file: srcFile, text }]);
    expect(flagged).toHaveLength(4);
    const ids = flagged.map((d) => d.message);
    expect(ids[0]).toContain("MAX_ATTEMPTS");
    expect(ids[1]).toContain("RETRY_LIMIT");
    expect(ids[2]).toContain("ATTEMPT_LIMIT");
    expect(ids[3]).toContain("MAX_TRIES");
  });

  it("(e+) flags the remaining bare retry-cap family (RETRY_CAP, ATTEMPT_CAP, RETRY_COUNT, MAX_RETRY_COUNT)", () => {
    const text = "const RETRY_CAP = 2;\nconst ATTEMPT_CAP = 3;\nconst RETRY_COUNT = 4;\nconst MAX_RETRY_COUNT = 5;\n";
    const flagged = checkNoArbitraryTimeouts([{ file: srcFile, text }]);
    expect(flagged).toHaveLength(4);
  });

  it("(e+) honors `// arch-allow: timeout-class` on a bare retry-cap identifier line", () => {
    const text =
      "const MAX_ATTEMPTS = 1; // arch-allow: timeout-class — external API allows exactly 1 attempt, fact not budget\n";
    expect(checkNoArbitraryTimeouts([{ file: srcFile, text }])).toEqual([]);
  });

  // Audit lane C3 F1 — the disguised loop-cap-under-a-different-noun family. The prior
  // give-up-identifier stem set (`attempt|iter|poll|retr|tries|stall`) missed
  // `VERCEL_MAX_PROJECT_PAGES = 100` in `vercelDeployProvisioner.listApps` because
  // "pages" is not in the taxonomy — but a page/round/turn/cycle/pass/rework counter used as
  // a for-loop upper bound with a throw on the exhaust branch IS a give-up count under
  // another name (a Vercel team with >100 projects would spuriously fail here). Pin each
  // new stem with a positive test + a bless test so a regression is loud.
  it("(give-up+) flags a MAX_*_PAGES identifier (audit C3 F1 — VERCEL_MAX_PROJECT_PAGES survivor)", () => {
    // The exact real-world shape the audit flagged — SCREAMING_CASE with a `_PAGES` suffix
    // AND a leading qualifier (`VERCEL_MAX_...`). The optional-prefix capture group grabs
    // the WHOLE identifier so the allowlist / dedup keys on `VERCEL_MAX_PROJECT_PAGES`, not
    // a sub-span (the naming stays specific).
    const text = "const VERCEL_MAX_PROJECT_PAGES = 100;\nif (page > VERCEL_MAX_PROJECT_PAGES) throw new Error('x');\n";
    const flagged = checkNoArbitraryTimeouts([{ file: srcFile, text }]);
    expect(flagged.length).toBeGreaterThanOrEqual(1);
    expect(flagged[0]?.message).toContain("VERCEL_MAX_PROJECT_PAGES");
    expect(flagged[0]?.message).toContain("intelligent non-convergence");
  });

  it("(give-up+) flags a MAX_*_PAGES used as the RHS of a for-loop upper bound", () => {
    // The disguised loop-cap shape: a SCREAMING_CASE `_PAGES` bound as the loop RHS. The
    // loop head fires the fixed-loop-cap detector via the extended `for (… < <ident>)`
    // pattern; the identifier itself also matches the extended stem set — both are
    // legitimate findings.
    const text =
      "const VERCEL_MAX_PROJECT_PAGES = 100;\n" +
      "for (let page = 0; page < VERCEL_MAX_PROJECT_PAGES; page++) { doWork(); }\n" +
      "throw new Error('exceeded pages');\n";
    const flagged = checkNoArbitraryTimeouts([{ file: srcFile, text }]);
    expect(flagged.length).toBeGreaterThanOrEqual(1);
    expect(flagged.some((d) => d.message.includes("retryUntilConverged"))).toBe(true);
  });

  it("(give-up+) flags the new stem family — _ROUNDS / _TURNS / _CYCLES / _PASSES / _REWORKS", () => {
    // Each of the new stems on its own: they are ALL the same class as `_PAGES` (a
    // structural counter of work units that shouldn't be bounded on a fixed number).
    const text =
      "const MAX_TRIAGE_ROUNDS = 5;\n" +
      "const MAX_PLAN_TURNS = 4;\n" +
      "const MAX_REWORK_CYCLES = 3;\n" +
      "const MAX_AUDIT_PASSES = 2;\n" +
      "const MAX_FIX_REWORKS = 6;\n";
    const flagged = checkNoArbitraryTimeouts([{ file: srcFile, text }]);
    expect(flagged).toHaveLength(5);
    const messages = flagged.map((d) => d.message);
    // The whole-identifier capture names each identifier in full — no qualifier stripped.
    expect(messages[0]).toContain("MAX_TRIAGE_ROUNDS");
    expect(messages[1]).toContain("MAX_PLAN_TURNS");
    expect(messages[2]).toContain("MAX_REWORK_CYCLES");
    expect(messages[3]).toContain("MAX_AUDIT_PASSES");
    expect(messages[4]).toContain("MAX_FIX_REWORKS");
  });

  it("(give-up+) flags the camelCase forms — maxPages / maxTurns / maxRounds", () => {
    // The stem set is case-insensitive, so the camelCase variants are caught too.
    const text = "const cap = maxPages;\nconst a = maxTurns;\nconst b = maxRounds;\n";
    const flagged = checkNoArbitraryTimeouts([{ file: srcFile, text }]);
    expect(flagged).toHaveLength(3);
  });

  it("(give-up+) does NOT flag adjacent but doctrinally-legitimate identifiers", () => {
    // Negatives: a page-SIZE (a request tuning knob, not a give-up cap) and a page-INDEX
    // (a loop variable, not a bound) don't carry the give-up shape (no `max` stem + no
    // suffix match). These MUST NOT trip — they'd be false positives on legitimate pager
    // code. Same for a bare `pageCount` (an observability count) and a `pageSize`
    // constant (the batch size, not a give-up bound).
    const text = "const pageSize = 100;\nconst pageCount = 0;\nconst pageIndex = 0;\n";
    expect(checkNoArbitraryTimeouts([{ file: srcFile, text }])).toEqual([]);
  });

  it("(give-up+) honors `// arch-allow: timeout-class` on a MAX_*_PAGES line", () => {
    // A hypothetical LEGITIMATE bless (a page-cap dictated by an external contract, not a
    // safety budget). The per-line annotation exempts the line — same mechanism as every
    // other timeout-class shape.
    const text =
      "const MAX_UPSTREAM_PAGES = 3; // arch-allow: timeout-class — Vercel v9 caps team-list requests at 3 pages, external fact not budget\n";
    expect(checkNoArbitraryTimeouts([{ file: srcFile, text }])).toEqual([]);
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
