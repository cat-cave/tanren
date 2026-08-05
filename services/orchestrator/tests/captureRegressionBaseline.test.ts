// BASELINE CAPTURE: the once-per-run measurement of what was green BEFORE the writer.
// Its correctness is what the whole regression contract rests on, and its FAILURE
// behaviour matters just as much — every failure path must degrade to "no baseline"
// (which makes the per-iteration judgment skip) rather than bricking the run.
import { describe, expect, it } from "vitest";
import { CiConfigV1 } from "../src/engine/ci/index.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { captureRegressionBaseline } from "../src/engine/workflow/gate/captureRegressionBaseline.js";

const target: RunnerHandle = { backend: "ssh" };

function configWith(step?: Record<string, unknown>) {
  return CiConfigV1.parse({
    version: 1,
    tiers: {
      fast: [step ?? { name: "lint", run: "just lint" }],
      slow: [{ name: "t", run: "just test", junitReport: "r.xml" }],
      merge: [{ name: "m", run: "just test", junitReport: "r.xml" }],
    },
    when: { fast: ["per_iteration"], slow: ["pre_audit"], merge: ["pre_merge"] },
  });
}

const declared = { name: "baseline-suite", run: "just test", regression: { reportPath: "reports/junit.xml" } };

class Ssh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  constructor(
    private readonly reportBody: string | undefined,
    private readonly stepResult: Partial<CommandResult> = {},
  ) {}
  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    const base = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    if (command.command.includes("cat ")) {
      return { ...base, stdout: this.reportBody ?? "__TANREN_FILE_ABSENT__" };
    }
    return { ...base, ...this.stepResult };
  }
}

const twoPassing =
  '<?xml version="1.0"?><testsuites><testsuite name="s">' +
  '<testcase classname="s" name="a"/><testcase classname="s" name="b"/>' +
  '<testcase classname="s" name="c"><failure message="x"/></testcase>' +
  "</testsuite></testsuites>";

describe("captureRegressionBaseline", () => {
  it("captures the PASSING test ids from the declared step's report", async () => {
    const ssh = new Ssh(twoPassing);
    const result = await captureRegressionBaseline({
      ssh,
      target,
      workspacePath: "/ws",
      config: configWith(declared),
    });
    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") throw new Error("unreachable");
    expect([...result.baseline.passing].sort()).toEqual(["s.a", "s.b"]);
    // `total` is the whole report — the scale figure the writer's steering quotes.
    expect(result.baseline.total).toBe(3);
  });

  it("runs NOTHING when the project declares no regression step — the zero-cost opt-out", async () => {
    const ssh = new Ssh(twoPassing);
    const result = await captureRegressionBaseline({
      ssh,
      target,
      workspacePath: "/ws",
      config: configWith(),
    });
    expect(result.kind).toBe("not_declared");
    expect(ssh.commands).toHaveLength(0);
  });

  it("IGNORES the step's exit code — a base tree with failing tests still yields a baseline", async () => {
    // Measured reality: the repo this was designed against has three pre-existing
    // failures. Refusing to build a baseline unless the base is perfectly green would
    // disable the contract on exactly the codebases that need it.
    const ssh = new Ssh(twoPassing, { exitCode: 1 });
    const result = await captureRegressionBaseline({
      ssh,
      target,
      workspacePath: "/ws",
      config: configWith(declared),
    });
    expect(result.kind).toBe("captured");
  });

  it("fails cleanly when the substrate could not run the step", async () => {
    const ssh = new Ssh(twoPassing, { failure: { reason: "transport" } as CommandResult["failure"] });
    const result = await captureRegressionBaseline({
      ssh,
      target,
      workspacePath: "/ws",
      config: configWith(declared),
    });
    expect(result).toEqual({ kind: "failed", reason: "step_failed" });
  });

  it("fails cleanly when the step STALLED (the watchdog found no signs of life)", async () => {
    // A stall is not a test result. Treating it as one would build a baseline out of a
    // half-written report and then judge every later iteration against it.
    const ssh = new Ssh(twoPassing, { stalled: true });
    const result = await captureRegressionBaseline({
      ssh,
      target,
      workspacePath: "/ws",
      config: configWith(declared),
    });
    expect(result).toEqual({ kind: "failed", reason: "step_failed" });
  });

  it("does NOT treat a completed step as stalled", async () => {
    const ssh = new Ssh(twoPassing, { stalled: false });
    const result = await captureRegressionBaseline({
      ssh,
      target,
      workspacePath: "/ws",
      config: configWith(declared),
    });
    expect(result.kind).toBe("captured");
  });

  it("fails cleanly when the step wrote no report", async () => {
    const result = await captureRegressionBaseline({
      ssh: new Ssh(undefined),
      target,
      workspacePath: "/ws",
      config: configWith(declared),
    });
    expect(result).toEqual({ kind: "failed", reason: "report_missing" });
  });

  it("fails cleanly on an unparseable report instead of throwing", async () => {
    const result = await captureRegressionBaseline({
      ssh: new Ssh("<not-junit>"),
      target,
      workspacePath: "/ws",
      config: configWith(declared),
    });
    expect(result).toEqual({ kind: "failed", reason: "report_unparseable" });
  });

  it("reports NO baseline when nothing passed, rather than a vacuous empty one", async () => {
    // A baseline with nothing green can never detect a regression. Calling that "captured"
    // would make the contract look like it is protecting a run it provably is not — and
    // this is the greenfield-scaffold and broken-fixture-root shape.
    const allRed =
      '<?xml version="1.0"?><testsuites><testsuite name="s">' +
      '<testcase classname="s" name="a"><failure message="x"/></testcase>' +
      "</testsuite></testsuites>";
    const result = await captureRegressionBaseline({
      ssh: new Ssh(allRed),
      target,
      workspacePath: "/ws",
      config: configWith(declared),
    });
    expect(result).toEqual({ kind: "failed", reason: "no_passing_tests" });
  });

  it("runs the declared step's own command in the workspace", async () => {
    const ssh = new Ssh(twoPassing);
    await captureRegressionBaseline({ ssh, target, workspacePath: "/ws", config: configWith(declared) });
    const stepCommand = ssh.commands[0];
    expect(stepCommand?.command).toContain("just test");
    expect(stepCommand?.cwd).toBe("/ws");
  });

  it("looks the step up at per_iteration only — defence in depth", async () => {
    // The schema now REFUSES a regression contract outside `per_iteration`, so this config
    // cannot come from a real `.tanren/ci.yml` (hence the cast past validation). The lookup
    // stays narrow regardless: the baseline serves the per-iteration judgment, and capturing
    // one from a step the gate will never judge that way would spend a suite run for nothing.
    const preAuditOnly = {
      version: 1,
      tiers: {
        fast: [{ name: "lint", run: "just lint" }],
        slow: [{ name: "t", run: "just test", junitReport: "r.xml", regression: { reportPath: "r.xml" } }],
        merge: [{ name: "m", run: "just test", junitReport: "r.xml" }],
      },
      when: { fast: ["per_iteration"], slow: ["pre_audit"], merge: ["pre_merge"] },
    } as unknown as CiConfigV1;
    const ssh = new Ssh(twoPassing);
    const result = await captureRegressionBaseline({ ssh, target, workspacePath: "/ws", config: preAuditOnly });
    expect(result.kind).toBe("not_declared");
    expect(ssh.commands).toHaveLength(0);
  });
});
