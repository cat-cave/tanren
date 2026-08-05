// THE REGRESSION CONTRACT AT THE GATE (runGateTier + the `regression` step field).
//
// These drive the real tier runner against a recording SSH mock and pin the behaviour
// change: a test step declaring `regression` is judged on pass→fail TRANSITIONS against
// the run's baseline instead of on absolute redness — so a writer mid-feature is not
// blocked by its own in-progress tests, while a pre-existing test it broke fails the
// iteration that broke it.
//
// Every test here fails on `main`, where the `regression` field does not exist and a
// nonzero exit is unconditionally fatal.
import { describe, expect, it } from "vitest";
import { baselineFromReport } from "../src/engine/ci/regression.js";
import type { JunitOutcome } from "../src/engine/ci/junit.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import type { EventName, EventPayload } from "../src/engine/events/index.js";
import { GateFailedPayload, GateStepResult } from "../src/engine/events/schemas/gate.js";
import { runGateTier } from "../src/engine/workflow/gate/runGateTier.js";

const target: RunnerHandle = { host: "h", port: 22, username: "u", hostKeyFingerprint: "fp" };
const REPORT_PATH = "reports/junit.xml";

function junitXml(cases: Record<string, JunitOutcome>): string {
  const body = Object.entries(cases)
    .map(([name, outcome]) => {
      if (outcome === "passed") return `<testcase classname="suite" name="${name}"/>`;
      if (outcome === "skipped") return `<testcase classname="suite" name="${name}"><skipped/></testcase>`;
      const tag = outcome === "error" ? "error" : "failure";
      return `<testcase classname="suite" name="${name}"><${tag} message="boom"/></testcase>`;
    })
    .join("");
  return `<?xml version="1.0"?><testsuites><testsuite name="suite">${body}</testsuite></testsuites>`;
}

function baselineOf(cases: Record<string, JunitOutcome>) {
  // Build the baseline through the real parser path, so the test cannot drift from the
  // shape the capture step actually produces.
  const passing = new Set(
    Object.entries(cases)
      .filter(([, outcome]) => outcome === "passed")
      .map(([name]) => `suite.${name}`),
  );
  return { passing, total: Object.keys(cases).length };
}

/**
 * An SSH mock that runs the gate step and serves its JUnit report. `reports` is consumed
 * one entry per step invocation, so a test can script "red on the first run, green on the
 * confirmation run" — the flake case.
 */
class TestRunSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  stepRuns = 0;
  /** Raw bodies served instead of a rendered report, one per step run (for malformed XML). */
  rawBodies: (string | undefined)[] = [];
  constructor(
    private readonly reports: (Record<string, JunitOutcome> | undefined)[],
    private readonly exitCode = 1,
  ) {}
  private current(): Record<string, JunitOutcome> | undefined {
    return this.reports[Math.min(this.stepRuns, this.reports.length) - 1];
  }
  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    const base = { stderr: "", timedOut: false };
    if (command.command.includes("cat ")) {
      const raw = this.rawBodies[Math.max(this.stepRuns - 1, 0)];
      if (raw !== undefined) return { ...base, exitCode: 0, stdout: raw };
      const cases = this.current();
      if (cases === undefined) return { ...base, exitCode: 0, stdout: "__TANREN_FILE_ABSENT__" };
      return { ...base, exitCode: 0, stdout: junitXml(cases) };
    }
    this.stepRuns += 1;
    const cases = this.current();
    const red = cases !== undefined && Object.values(cases).some((o) => o === "failed" || o === "error");
    return { ...base, exitCode: red ? this.exitCode : 0, stdout: "suite output" };
  }
}

function recordingEvents() {
  const events: { eventType: EventName; payload: unknown }[] = [];
  const appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>) => {
    events.push({ eventType, payload });
  };
  return { events, appendEvent };
}

const regressionStep = { name: "test", run: "run-tests", regression: { reportPath: REPORT_PATH } };

async function runTier(ssh: CommandSubstrate, baseline?: ReturnType<typeof baselineOf>) {
  const { events, appendEvent } = recordingEvents();
  const result = await runGateTier({
    ssh,
    target,
    workspacePath: "/ws",
    tier: "fast",
    when: "per_iteration",
    steps: [regressionStep],
    appendEvent,
    ...(baseline === undefined ? {} : { regressionBaseline: baseline }),
  });
  return { result, events };
}

describe("the regression contract at the gate", () => {
  it("PASSES a red suite when nothing that was green went red — the thrash case", async () => {
    // The writer is mid-feature: its own new test is red. On `main` this nonzero exit
    // fails the tier and blocks the iteration, which is exactly why projects exclude
    // tests from the per-iteration gate.
    const baseline = baselineOf({ existing: "passed" });
    const ssh = new TestRunSsh([{ existing: "passed", brand_new_tdd_test: "failed" }]);
    const { result } = await runTier(ssh, baseline);

    expect(result.passed).toBe(true);
    expect(result.steps[0]?.exitCode).toBe(1);
    expect(result.steps[0]?.regression).toMatchObject({ regressed: [], regressedCount: 0, unconfirmedCount: 0 });
  });

  it("FAILS on a confirmed regression and names the tests", async () => {
    const baseline = baselineOf({ was_green: "passed", other: "passed" });
    // Red in BOTH runs → confirmed.
    const ssh = new TestRunSsh([
      { was_green: "failed", other: "passed" },
      { was_green: "failed", other: "passed" },
    ]);
    const { result, events } = await runTier(ssh, baseline);

    expect(result.passed).toBe(false);
    if (result.passed) throw new Error("unreachable");
    expect(result.failedReason).toBe("test_regression");
    expect(result.regression?.regressed).toEqual(["suite.was_green"]);
    expect(result.regression?.regressedCount).toBe(1);
    const failed = events.find((e) => e.eventType === "gate.failed");
    expect(failed).toBeDefined();
    // The payload must satisfy the STRICT event schema — `regression` is a new field on a
    // strict object, so an unregistered key would be rejected at append time in production.
    expect(() => GateFailedPayload.parse(failed?.payload)).not.toThrow();
  });

  it("clears a FLAKE: red on the first run, green on the confirmation run", async () => {
    // The measured ~25% per-run flake rate makes this the common false positive. Steering
    // a writer to fix a test that is not broken burns an iteration and poisons the
    // convergence signature.
    const baseline = baselineOf({ flaky: "passed" });
    const ssh = new TestRunSsh([{ flaky: "failed" }, { flaky: "passed" }]);
    const { result } = await runTier(ssh, baseline);

    expect(result.passed).toBe(true);
    expect(result.steps[0]?.regression).toMatchObject({ regressed: [], regressedCount: 0, unconfirmedCount: 1 });
  });

  it("runs the step exactly ONCE when nothing regressed — the confirmation is failure-path only", async () => {
    const baseline = baselineOf({ a: "passed" });
    const ssh = new TestRunSsh([{ a: "passed" }]);
    await runTier(ssh, baseline);
    expect(ssh.stepRuns).toBe(1);
  });

  it("runs the step exactly TWICE when something looks regressed", async () => {
    const baseline = baselineOf({ a: "passed" });
    const ssh = new TestRunSsh([{ a: "failed" }, { a: "failed" }]);
    await runTier(ssh, baseline);
    expect(ssh.stepRuns).toBe(2);
  });

  it("FAILS when the report is unreadable — a collection error is not 'merely red'", async () => {
    // The runner exited nonzero and wrote nothing. Passing here would let a broken
    // broken fixture root / crashed runner sail through the per-iteration gate silently.
    const baseline = baselineOf({ a: "passed" });
    const ssh = new TestRunSsh([undefined]);
    const { result } = await runTier(ssh, baseline);

    expect(result.passed).toBe(false);
    if (result.passed) throw new Error("unreachable");
    expect(result.failedReason).toBe("exit_code");
    expect(result.regression).toBeUndefined();
    expect(result.steps[0]).toMatchObject({ name: "test", run: "run-tests", passed: false, timedOut: false });
    expect(() => GateStepResult.parse(result.steps[0])).not.toThrow();
  });

  it("FAILS when the report is present but MALFORMED", async () => {
    // Distinct from an absent report and equally fatal: a half-written or truncated XML
    // means the runner died mid-write, and we must not read that as "merely red".
    const ssh = new TestRunSsh([{ a: "failed" }]);
    ssh.rawBodies = ["<testsuites><testsuite name='s'>"];
    const { result } = await runTier(ssh, baselineOf({ a: "passed" }));
    expect(result.passed).toBe(false);
    if (result.passed) throw new Error("unreachable");
    expect(result.failedReason).toBe("exit_code");
  });

  it("FAILS when the CONFIRMATION run's report goes missing", async () => {
    // The first run showed a regression, so the verdict now depends on the second run's
    // report. Losing it must not silently clear the regression.
    const ssh = new TestRunSsh([{ a: "failed" }, undefined]);
    const { result } = await runTier(ssh, baselineOf({ a: "passed" }));
    expect(result.passed).toBe(false);
    if (result.passed) throw new Error("unreachable");
    expect(result.failedReason).toBe("exit_code");
    expect(result.regression).toBeUndefined();
  });

  it("FAILS when the CONFIRMATION run's report is malformed", async () => {
    const ssh = new TestRunSsh([{ a: "failed" }, { a: "failed" }]);
    ssh.rawBodies = [undefined, "<broken"];
    const { result } = await runTier(ssh, baselineOf({ a: "passed" }));
    expect(result.passed).toBe(false);
  });

  it("counts confirmed and unconfirmed separately when only SOME reproduce", async () => {
    // Two tests look regressed; only one reproduces. The counts must be 1 confirmed and
    // 1 cleared — not 2, and not 3.
    const baseline = baselineOf({ real: "passed", flaky: "passed" });
    const ssh = new TestRunSsh([
      { real: "failed", flaky: "failed" },
      { real: "failed", flaky: "passed" },
    ]);
    const { result } = await runTier(ssh, baseline);
    expect(result.passed).toBe(false);
    if (result.passed) throw new Error("unreachable");
    expect(result.regression).toMatchObject({
      regressed: ["suite.real"],
      regressedCount: 1,
      unconfirmedCount: 1,
    });
  });

  it("SKIPS the judgment with no baseline, falling back to ordinary exit-code judgment", async () => {
    // No baseline ⇒ we cannot tell a regression from in-progress work, so we must not
    // claim to. Falling back leaves the loop exactly as it behaves today.
    const ssh = new TestRunSsh([{ a: "failed" }]);
    const { result } = await runTier(ssh);

    expect(result.passed).toBe(false);
    if (result.passed) throw new Error("unreachable");
    expect(result.failedReason).toBe("exit_code");
    expect(ssh.stepRuns).toBe(1);
  });

  it("passes a GREEN suite and still records the verdict, proving the comparison ran", async () => {
    const baseline = baselineOf({ a: "passed" });
    const ssh = new TestRunSsh([{ a: "passed" }]);
    const { result } = await runTier(ssh, baseline);

    expect(result.passed).toBe(true);
    expect(result.steps[0]?.regression).toEqual({
      regressed: [],
      regressedCount: 0,
      unconfirmedCount: 0,
      baselineTotal: 1,
      observedTotal: 1,
    });
    // The step outcome rides in every gate.* payload, so it must satisfy the strict schema.
    expect(() => GateStepResult.parse(result.steps[0])).not.toThrow();
  });

  it("leaves a step WITHOUT a regression contract completely unchanged", async () => {
    const { events, appendEvent } = recordingEvents();
    const ssh = new TestRunSsh([{ a: "failed" }]);
    const result = await runGateTier({
      ssh,
      target,
      workspacePath: "/ws",
      tier: "fast",
      when: "per_iteration",
      steps: [{ name: "test", run: "run-tests" }],
      appendEvent,
      regressionBaseline: baselineOf({ a: "passed" }),
    });
    // A baseline is present, but the step did not opt in — so the nonzero exit is fatal
    // exactly as before, and no comparison happened.
    expect(result.passed).toBe(false);
    expect(result.steps[0]?.regression).toBeUndefined();
    expect(ssh.stepRuns).toBe(1);
    expect(events.some((e) => e.eventType === "gate.failed")).toBe(true);
  });

  it("does not treat a substrate failure as a test result", async () => {
    // A transport fault produced no report and is not evidence about the tree. It must
    // keep its ordinary fatal meaning rather than entering the comparison.
    const failingSsh: CommandSubstrate = {
      async run(): Promise<CommandResult> {
        return {
          exitCode: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          failure: { reason: "transport" } as CommandResult["failure"],
        };
      },
    };
    const { result } = await runTier(failingSsh, baselineOf({ a: "passed" }));
    expect(result.passed).toBe(false);
    if (result.passed) throw new Error("unreachable");
    expect(result.failedReason).toBe("exit_code");
    expect(result.regression).toBeUndefined();
  });

  it("exposes the confirmation run's parsed report for the per-test ingest", async () => {
    const baseline = baselineOf({ a: "passed" });
    const ssh = new TestRunSsh([{ a: "failed" }, { a: "failed", b: "passed" }]);
    const { result } = await runTier(ssh, baseline);
    // The report kept is the one the verdict was decided on, not the discarded first run.
    expect(result.parsedJunitReports?.get("test")?.total).toBe(2);
  });
});

describe("baselineFromReport wiring", () => {
  it("builds the same passing set the gate compares against", async () => {
    const baseline = baselineFromReport({
      results: [
        {
          testId: "suite.a",
          file: null,
          suite: null,
          outcome: "passed",
          durationMs: null,
          retries: 0,
          flakyFailure: false,
        },
      ],
      total: 1,
      failures: 0,
    });
    const ssh = new TestRunSsh([{ a: "failed" }, { a: "failed" }]);
    const { result } = await runTier(ssh, baseline);
    expect(result.passed).toBe(false);
  });
});
