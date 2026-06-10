// buildDefaultGate — the native JUnit ingest's DECLARED-contract discrimination (Loop 4).
//
// NO-SILENT-FALLBACK: the native JUnit ingest must DISCRIMINATE "no tier declared a junit
// report" (a clean QUIET skip) from "a tier DECLARED a `junitReport` but the runner produced
// none" (LOUD + DURABLE). STACK-AGNOSTIC: "JUnit expected" is decided from the EXPLICIT
// `junitReport:` contract field on a step — the COMMAND (`just tier-2`) never mentions the
// path, so a substring sniff would miss it; the DECLARED field is the sole signal. The LOUD
// case persists a durable `ci.junit_missing` event PLUS a structured `console.error`
// (non-merge-gating — visibility). Extracted from buildDefaultGate.test.ts (the 500-line cap).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { buildDefaultGate } from "../src/engine/workflow/plannerRunAdapters.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

const workspacePath = "/workspace/runs/run_greenfield/repo";

function context(): PlannerRunContext {
  return {
    runId: "run_greenfield",
    specId: "spec_greenfield",
    projectId: "project_greenfield",
    repoUrl: "https://github.com/cat-cave/greenfield",
    targetBranch: "main",
    runBranch: "tanren/greenfield",
    specTitle: "monorepo scaffold",
    specDescription: "stand up the toolchain",
    acceptanceCriteria: ["the pipeline is green"],
    runnerImage: "ghcr.io/cat-cave/tanren-runner:test",
    identitySecretRef: "runner/test/identity",
    githubCredentialRef: "credential/github/dev",
    greenfield: true,
  };
}

// A virtual workspace whose tree is already prepared (the gate steps pass); the JUnit read
// always reports the absent marker so a tier that DECLARES a junitReport surfaces the LOUD
// missing-report path. STACK-AGNOSTIC: the gate steps defer to `just tier-N`.
class InterpretingSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  constructor(private readonly ciConfigYaml: string) {}
  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    const cmd = command.command;
    const ok = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    if (cmd.includes(".tanren/ci.yml") && cmd.includes("cat ")) return { ...ok, stdout: this.ciConfigYaml };
    // The native JUnit read — always absent (the virtual workspace writes no report).
    if (cmd.includes("__TANREN_JUNIT_ABSENT__")) return { ...ok, stdout: "__TANREN_JUNIT_ABSENT__\n" };
    if (cmd === "git rev-parse HEAD") return { ...ok, stdout: `${"c".repeat(40)}\n` };
    if (cmd.includes("deps-ensure")) return { ...ok, stdout: "tanren: deps-ensure no-op" };
    if (cmd.startsWith("just tier-")) return ok;
    return ok;
  }
}

// A fuller input than the base gateInput: a fake pool + an org so the best-effort ingest runs.
function ingestInput(ssh: CommandSubstrate): RunPlannerLoopInput {
  const fakePool = { query: async () => ({ rows: [], rowCount: 0 }) };
  return {
    ssh,
    context: { ...context(), orgId: "org_1" },
    timeoutMs: 100,
    pool: fakePool,
  } as unknown as RunPlannerLoopInput;
}

// A repo config whose SLOW tier DECLARES a junitReport path — so pre_audit expects a report
// (expectReport=true). The `run` does NOT mention the path; the DECLARED field is the signal.
const JUNIT_WRITING_CONFIG = `version: 1
bootstrap:
  run: just bootstrap
tiers:
  fast:
    - name: tier-1
      run: just tier-1
  slow:
    - name: tier-2
      run: just tier-2
      junitReport: reports/junit.xml
when:
  fast:
    - per_iteration
  slow:
    - pre_audit
    - pre_merge
`;

describe("buildDefaultGate — native JUnit ingest (declared-but-missing is LOUD + DURABLE)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("pre_audit (a tier DECLARED a junitReport) + absent report → a LOUD console.error + durable ci.junit_missing", async () => {
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    const events = new FakeEventStore();
    const gate = buildDefaultGate(
      ingestInput(new InterpretingSsh(JUNIT_WRITING_CONFIG)),
      target,
      workspacePath,
      events,
    );

    const outcome = await gate({ when: "pre_audit" });

    expect(outcome.passed).toBe(true);
    const loud = errs.mock.calls.map((c) => String(c[0])).find((m) => m.includes("native JUnit report EXPECTED"));
    expect(loud).toBeDefined();
    // The signal names the reason (absent) + the tier + the declared path — no silent degrade.
    expect(loud).toContain("absent");
    expect(loud).toContain("tier=slow");
    expect(loud).toContain("path=reports/junit.xml");
    // DURABLE: a `ci.junit_missing` event is persisted carrying the tier/path/reason.
    const missing = events.events.find((e) => e.eventType === "ci.junit_missing");
    expect(missing).toBeDefined();
    expect(missing!.payload).toMatchObject({ tier: "slow", reportPath: "reports/junit.xml", reason: "absent" });
  });

  it("per_iteration (no tier declared a junitReport) + absent report → QUIET (no loud signal, no event)", async () => {
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    const events = new FakeEventStore();
    const gate = buildDefaultGate(
      ingestInput(new InterpretingSsh(JUNIT_WRITING_CONFIG)),
      target,
      workspacePath,
      events,
    );

    const outcome = await gate({ when: "per_iteration" });

    expect(outcome.passed).toBe(true);
    // The fast tier DECLARES no junitReport ⇒ no loud "expected but missing" log...
    expect(errs.mock.calls.map((c) => String(c[0])).some((m) => m.includes("native JUnit report EXPECTED"))).toBe(
      false,
    );
    // ...and no durable ci.junit_missing event — a clean skip, never an error.
    expect(events.events.some((e) => e.eventType === "ci.junit_missing")).toBe(false);
  });

  it("a config with NO junitReport declaration → clean skip even when a report-path string appears in a `run`", async () => {
    // STACK-AGNOSTIC + no command sniff: a step whose `run` happens to mention the path string
    // but does NOT set `junitReport` is NOT treated as junit-producing — the DECLARED field is
    // the sole signal. So pre_audit here is a clean QUIET skip.
    const NO_DECLARATION_CONFIG = `version: 1
bootstrap:
  run: just bootstrap
tiers:
  fast:
    - name: tier-1
      run: just tier-1
  slow:
    - name: tier-2
      run: just tier-2 --note reports/junit.xml
when:
  fast:
    - per_iteration
  slow:
    - pre_audit
    - pre_merge
`;
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    const events = new FakeEventStore();
    const gate = buildDefaultGate(
      ingestInput(new InterpretingSsh(NO_DECLARATION_CONFIG)),
      target,
      workspacePath,
      events,
    );

    const outcome = await gate({ when: "pre_audit" });

    expect(outcome.passed).toBe(true);
    expect(errs.mock.calls.map((c) => String(c[0])).some((m) => m.includes("native JUnit report EXPECTED"))).toBe(
      false,
    );
    expect(events.events.some((e) => e.eventType === "ci.junit_missing")).toBe(false);
  });
});
