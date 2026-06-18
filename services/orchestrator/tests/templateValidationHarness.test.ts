// Tests for the template VALIDATION HARNESS — the "meaningful, not green-by-accident"
// proof. They drive runValidationHarness against a SCRIPTED command substrate (no live
// runner): a fake that models bootstrap/tiers/build over the clean template AND the
// scratch-copy negative-control runs, so we can assert the v29 no-op-typecheck failure
// mode is CAUGHT (a typecheck that passes WITH a planted type error → `unproven` →
// template FAILS validation), a real typecheck → `proven`, mutation-not-declared →
// `n/a`, and positive-all-pass → proven.
import { describe, expect, it } from "vitest";
import { type CiConfigV1, DEFAULT_CI_CONFIG, resolveCiConfig } from "../src/engine/ci/index.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import {
  buildNegativeControlPlan,
  type NegativeControl,
  runValidationHarness,
  type TemplateAuditor,
  templateValidates,
  type ValidationHarnessInput,
} from "../src/engine/templates/index.js";

const target: RunnerHandle = { backend: "ssh" } as RunnerHandle;
const WORKSPACE = "/ws/template";
const SCRATCH_ROOT = "/ws/template/.git/tanren-tmp/nc";
const FIXED_NOW = () => new Date("2026-06-09T12:00:00.000Z");

// A gate's per-capability behavior over a scratch copy: does the planted defect make
// the gate FAIL? "real" ⇒ the gate catches it (fails) ⇒ proven. "noop" ⇒ the gate
// passes despite the defect (the v29 failure mode) ⇒ unproven. "timeout" ⇒ the gate
// could NOT run over the scratch copy (a flaky runner) — INDETERMINATE, never a
// meaningful catch ⇒ a LOUD unproven (VALIDATION INTEGRITY, Fix 1).
type GateMode = "real" | "noop" | "timeout";

interface ScriptOptions {
  // Whether the clean-template positive controls (bootstrap/tiers/build) pass.
  positivePass?: boolean;
  // Per-capability gate behavior over the planted scratch copy.
  typecheck?: GateMode;
  lint?: GateMode;
  test?: GateMode;
  mutation?: GateMode;
}

// A scripted substrate. It tracks which scratch dirs have had a defect planted (via the
// base64 write), then scripts the tier/step commands run over those dirs per the chosen
// GateMode. Commands over the CLEAN workspace obey `positivePass`.
class ScriptedSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  // scratchDir → the capability whose defect was planted there (derived from the dir name).
  private readonly planted = new Map<string, string>();

  constructor(private readonly opts: ScriptOptions) {}

  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    const cwd = command.cwd ?? "";
    const cmd = command.command;

    // A scratch copy is made with `cp -a … <scratchPath>`; a defect write pipes base64
    // into a file UNDER the scratch path. The scratch dir name carries the capability
    // (`nc-<i>-<capability>`), so we record which capability's defect lives where.
    if (cmd.includes("base64 -d")) {
      const dir = this.scratchDirOf(cmd);
      if (dir !== undefined) {
        this.planted.set(dir, capabilityOfScratchDir(dir));
      }
      return ok();
    }
    if (cmd.startsWith("rm -rf") || cmd.includes("cp -a")) {
      return ok();
    }

    // A gate/step command run over a PLANTED scratch dir: behavior per the GateMode.
    const plantedCapability = this.planted.get(cwd);
    if (plantedCapability !== undefined) {
      return this.scriptPlantedGate(plantedCapability);
    }

    // Otherwise it's a clean-template positive control (bootstrap/tier/build).
    return (this.opts.positivePass ?? true) ? ok() : fail();
  }

  private scriptPlantedGate(capability: string): CommandResult {
    const mode: GateMode | undefined =
      capability === "typecheck"
        ? this.opts.typecheck
        : capability === "lint"
          ? this.opts.lint
          : capability === "test"
            ? this.opts.test
            : capability === "mutation"
              ? this.opts.mutation
              : undefined;
    // "real" ⇒ the gate catches the defect (fails). "timeout" ⇒ the gate could NOT run
    // (a flaky runner) — INDETERMINATE, NOT a catch. "noop" / unset ⇒ the gate passes
    // despite the defect (the no-op gate — proves `unproven`).
    if (mode === "timeout") return stalledResult();
    return mode === "real" ? fail() : ok();
  }

  private scratchDirOf(command: string): string | undefined {
    // The write target is `… > '<scratchPath>/<rel-path>'`; the scratch dir is the
    // prefix `<root>/nc-<i>-<capability>`. Match from the root (no leading quote) so
    // it equals the cwd the gate later runs with.
    const match = command.match(/(\/[^'"\s]*\/nc-\d+-[a-z]+)/u);
    return match?.[1];
  }
}

function capabilityOfScratchDir(dir: string): string {
  return dir.match(/nc-\d+-([a-z]+)$/u)?.[1] ?? "";
}

function ok(): CommandResult {
  return { exitCode: 0, stdout: "", stderr: "" };
}
function fail(): CommandResult {
  return { exitCode: 1, stdout: "", stderr: "gate caught the defect" };
}
// A flaky-runner TIMEOUT over the scratch copy: the gate did NOT run to a verdict, so
// it is INDETERMINATE — never a meaningful negative-control pass (Fix 1).
function stalledResult(): CommandResult {
  return { exitCode: null, stdout: "", stderr: "", stalled: true };
}

const cleanAuditor: TemplateAuditor = {
  async openBlockingFindings() {
    return 0;
  },
};

function harnessInput(
  ssh: CommandSubstrate,
  negativeControls: ReadonlyArray<NegativeControl>,
  auditor: TemplateAuditor = cleanAuditor,
): ValidationHarnessInput {
  return {
    ssh,
    target,
    workspacePath: WORKSPACE,
    scratchRoot: SCRATCH_ROOT,
    config: DEFAULT_CI_CONFIG,
    negativeControls,
    auditor,
    validatedSha: "f".repeat(40),
    now: FIXED_NOW,
    appendEvent: async () => {},
  };
}

describe("runValidationHarness — positive controls + clean proof", () => {
  it("positive controls all pass + every declared negative control catches its defect → proven, template validates", async () => {
    const ssh = new ScriptedSsh({ positivePass: true, typecheck: "real", lint: "real", test: "real" });
    const proof = await runValidationHarness(harnessInput(ssh, buildNegativeControlPlan()));

    expect(proof.positiveControlsPassed).toBe(true);
    expect(proof.negativeControls).toEqual({
      typecheck: "proven",
      lint: "proven",
      test: "proven",
      mutation: "n/a",
    });
    expect(proof.auditorClean).toBe(true);
    expect(proof.validatedSha).toBe("f".repeat(40));
    expect(proof.validatedAt).toBe("2026-06-09T12:00:00.000Z");
    expect(templateValidates(proof)).toBe(true);
  });

  it("uses the passed-in clock for validatedAt (Date.now is not consulted)", async () => {
    const ssh = new ScriptedSsh({ positivePass: true, typecheck: "real", lint: "real", test: "real" });
    const proof = await runValidationHarness({
      ...harnessInput(ssh, buildNegativeControlPlan()),
      now: () => new Date("2030-01-02T03:04:05.000Z"),
    });
    expect(proof.validatedAt).toBe("2030-01-02T03:04:05.000Z");
  });
});

describe("runValidationHarness — the v29 no-op-typecheck failure mode (the killer test)", () => {
  it("a no-op typecheck (passes WITH the planted type error) → typecheck: unproven → template FAILS validation", async () => {
    // typecheck is "noop": the gate PASSES even though the planted type error is present
    // (exactly the v29 tsc-over-empty-files bug). lint + test are real.
    const ssh = new ScriptedSsh({ positivePass: true, typecheck: "noop", lint: "real", test: "real" });
    const proof = await runValidationHarness(harnessInput(ssh, buildNegativeControlPlan()));

    // Positive controls are green-by-accident on a clean tree — the negative control
    // is the only thing that exposes the no-op typecheck.
    expect(proof.positiveControlsPassed).toBe(true);
    expect(proof.negativeControls.typecheck).toBe("unproven");
    expect(proof.negativeControls.lint).toBe("proven");
    expect(proof.negativeControls.test).toBe("proven");
    // A declared-but-unproven control FAILS validation — the v29 broken gate cannot publish.
    expect(templateValidates(proof)).toBe(false);
  });

  it("a real typecheck (fails on the planted type error) → typecheck: proven", async () => {
    const ssh = new ScriptedSsh({ positivePass: true, typecheck: "real", lint: "real", test: "real" });
    const proof = await runValidationHarness(harnessInput(ssh, buildNegativeControlPlan()));
    expect(proof.negativeControls.typecheck).toBe("proven");
  });
});

describe("runValidationHarness — negative-control TIMEOUT is never 'proven' (Fix 1 — validation integrity)", () => {
  it("a TIER negative control whose gate TIMES OUT over the scratch copy → unproven, NOT proven", async () => {
    // The gate could not RUN to a verdict (a flaky runner timeout) — that is NOT the
    // gate catching the defect, so it must be a LOUD unproven, never a meaningful pass.
    // Positive controls are clean (the timeout is ONLY on the planted scratch run).
    const ssh = new ScriptedSsh({ positivePass: true, typecheck: "timeout", lint: "real", test: "real" });
    const proof = await runValidationHarness(harnessInput(ssh, buildNegativeControlPlan()));

    expect(proof.negativeControls.typecheck).toBe("unproven");
    // A declared-but-unproven control FAILS validation — an infra timeout can never
    // publish a template with a gate that may be a no-op.
    expect(templateValidates(proof)).toBe(false);
  });

  it("a STEP negative control (mutation) whose command TIMES OUT → unproven, NOT proven", async () => {
    const ssh = new ScriptedSsh({
      positivePass: true,
      typecheck: "real",
      lint: "real",
      test: "real",
      mutation: "timeout",
    });
    const plan = buildNegativeControlPlan({ mutationStep: "just mutation" });
    const proof = await runValidationHarness(harnessInput(ssh, plan));

    expect(proof.negativeControls.mutation).toBe("unproven");
    expect(templateValidates(proof)).toBe(false);
  });

  it("positive controls still pass while a negative-control timeout is unproven (the timeout is the negative-control's, not the build's)", async () => {
    const ssh = new ScriptedSsh({ positivePass: true, typecheck: "timeout", lint: "real", test: "real" });
    const proof = await runValidationHarness(harnessInput(ssh, buildNegativeControlPlan()));
    // The positive controls (clean tree) are unaffected — only the planted scratch run
    // timed out — yet validation still FAILS on the indeterminate negative control.
    expect(proof.positiveControlsPassed).toBe(true);
    expect(proof.negativeControls.typecheck).toBe("unproven");
    expect(templateValidates(proof)).toBe(false);
  });
});

describe("runValidationHarness — mutation capability declaration", () => {
  it("mutation NOT declared → n/a (does not block validation)", async () => {
    const ssh = new ScriptedSsh({ positivePass: true, typecheck: "real", lint: "real", test: "real" });
    const proof = await runValidationHarness(harnessInput(ssh, buildNegativeControlPlan()));
    expect(proof.negativeControls.mutation).toBe("n/a");
    expect(templateValidates(proof)).toBe(true);
  });

  it("mutation declared + kills the seeded mutant → proven", async () => {
    const ssh = new ScriptedSsh({
      positivePass: true,
      typecheck: "real",
      lint: "real",
      test: "real",
      mutation: "real",
    });
    const plan = buildNegativeControlPlan({ mutationStep: "just mutation" });
    const proof = await runValidationHarness(harnessInput(ssh, plan));
    expect(proof.negativeControls.mutation).toBe("proven");
    expect(templateValidates(proof)).toBe(true);
  });

  it("mutation declared but the seeded mutant SURVIVES (step passes) → unproven → FAILS validation", async () => {
    const ssh = new ScriptedSsh({
      positivePass: true,
      typecheck: "real",
      lint: "real",
      test: "real",
      mutation: "noop",
    });
    const plan = buildNegativeControlPlan({ mutationStep: "just mutation" });
    const proof = await runValidationHarness(harnessInput(ssh, plan));
    expect(proof.negativeControls.mutation).toBe("unproven");
    expect(templateValidates(proof)).toBe(false);
  });
});

describe("runValidationHarness — positive-control + auditor failures", () => {
  it("a failing positive control (clean build fails) → positiveControlsPassed false → FAILS validation", async () => {
    const ssh = new ScriptedSsh({ positivePass: false, typecheck: "real", lint: "real", test: "real" });
    const proof = await runValidationHarness(harnessInput(ssh, buildNegativeControlPlan()));
    expect(proof.positiveControlsPassed).toBe(false);
    expect(templateValidates(proof)).toBe(false);
  });

  it("an auditor with open P0/P1 findings → auditorClean false → FAILS validation", async () => {
    const ssh = new ScriptedSsh({ positivePass: true, typecheck: "real", lint: "real", test: "real" });
    const dirtyAuditor: TemplateAuditor = {
      async openBlockingFindings() {
        return 2;
      },
    };
    const proof = await runValidationHarness(harnessInput(ssh, buildNegativeControlPlan(), dirtyAuditor));
    expect(proof.auditorClean).toBe(false);
    expect(templateValidates(proof)).toBe(false);
  });
});

// DEPS-BEFORE-GATE (apex v35): the positive-control tiers run `just tier-N`, whose
// writer-authored recipe invokes `./node_modules/.bin/<tool>` — `command not found`
// (exit 127) until `node_modules` exists. The harness MUST `ensureWorkspaceDepsInstalled`
// (the project's `just bootstrap`) BEFORE the tiers, even when the template's
// `.tanren/ci.yml` declares no explicit `bootstrap.run` (the OLD `if (bootstrap !==
// undefined)` skip ran the tiers over an UNINSTALLED tree → the live `format + lint gate`
// tier-2 prettier-not-found failure).
describe("runValidationHarness — deps installed before the positive-control tiers (apex v35)", () => {
  // A substrate that models "the tier binary is missing until deps are installed": it
  // recognizes the deps-ensure guard (the `tanren: deps-ensure installing` sentinel) and
  // flips `prepared`; a `just tier-N` BEFORE that flips exits 127 (`./node_modules/.bin`
  // not found), after it exits 0. Bootstrap/build/cp/write all succeed.
  class DepsGatedSsh implements CommandSubstrate {
    readonly commands: RunnerCommand[] = [];
    prepared = false;
    installRuns = 0;

    async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
      this.commands.push(command);
      const cmd = command.command;
      // The deps-ensure guard (one round-trip) prepares the tree.
      if (cmd.includes("deps-ensure installing")) {
        this.prepared = true;
        this.installRuns += 1;
        return { exitCode: 0, stdout: "tanren: deps-ensure installing\nPackages: +120", stderr: "" };
      }
      // Scratch-copy / defect-write / teardown plumbing always succeeds.
      if (cmd.startsWith("rm -rf") || cmd.includes("cp -a") || cmd.includes("base64 -d")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      // A `just tier-N` run BEFORE deps are installed: the writer's recipe shells out to
      // `./node_modules/.bin/<tool>`, which is not found → exit 127 (the live failure).
      if (cmd.includes("just tier-") && !this.prepared) {
        return {
          exitCode: 127,
          stdout: "",
          stderr: "sh: 1: ./node_modules/.bin/prettier: not found",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
  }

  // A config that declares NO `bootstrap.run` — the template-contract shape that exposed
  // the bug (the harness used to SKIP the bootstrap, so the tiers ran with no node_modules).
  const NO_BOOTSTRAP_CONFIG: CiConfigV1 = resolveCiConfig(
    [
      "version: 1",
      "tiers:",
      "  fast:",
      "    - name: tier-1",
      "      run: just tier-1",
      "  slow:",
      "    - name: tier-2",
      "      run: just tier-2",
      "  merge:",
      "    - name: tier-3",
      "      run: just tier-3",
      "when:",
      "  fast:",
      "    - per_iteration",
      "  slow:",
      "    - pre_audit",
      "  merge:",
      "    - pre_merge",
    ].join("\n"),
  );

  it("installs deps BEFORE the slow/tier-2 gate even when the config declares no bootstrap.run (the bug)", async () => {
    const ssh = new DepsGatedSsh();
    const proof = await runValidationHarness({
      ...harnessInput(ssh, []),
      config: NO_BOOTSTRAP_CONFIG,
    });

    // WITHOUT the fix the harness skipped the bootstrap (no declared bootstrap.run), the
    // tiers ran over an uninstalled tree, the slow/tier-2 step exited 127, and the positive
    // controls FAILED. With the fix the deps-ensure (stack-agnostic `just bootstrap`
    // fallback) runs first, so the tiers pass.
    expect(proof.positiveControlsPassed).toBe(true);

    // The deps-ensure guard ran BEFORE the first `just tier-` (ordering is load-bearing).
    const ensureIdx = ssh.commands.findIndex((c) => c.command.includes("deps-ensure"));
    const firstTierIdx = ssh.commands.findIndex((c) => c.command.includes("just tier-"));
    expect(ensureIdx).toBeGreaterThanOrEqual(0);
    expect(firstTierIdx).toBeGreaterThan(ensureIdx);
  });

  it("is idempotent — the deps-ensure runs once, not per-tier (no redundant double-install)", async () => {
    const ssh = new DepsGatedSsh();
    await runValidationHarness({ ...harnessInput(ssh, []), config: NO_BOOTSTRAP_CONFIG });
    // The positive-control deps-ensure is a single round-trip before the three lifecycle
    // points' tiers — not one install per tier.
    expect(ssh.installRuns).toBe(1);
  });

  it("honors an EXPLICIT bootstrap.run (no stack-agnostic fallback when the config declares one)", async () => {
    const ssh = new DepsGatedSsh();
    await runValidationHarness({ ...harnessInput(ssh, []), config: DEFAULT_CI_CONFIG });
    // DEFAULT_CI_CONFIG declares `bootstrap.run: just bootstrap`; the deps-ensure guard
    // embeds it verbatim (not the `no justfile yet` default-fallback message).
    const ensure = ssh.commands.find((c) => c.command.includes("deps-ensure installing"));
    expect(ensure?.command).toContain("just bootstrap");
    expect(ensure?.command).not.toContain("no justfile yet");
  });
});

describe("runValidationHarness — scratch-copy isolation", () => {
  it("the negative-control defect is written under a scratch dir and the copy is removed (never the real workspace)", async () => {
    const ssh = new ScriptedSsh({ positivePass: true, typecheck: "real", lint: "real", test: "real" });
    await runValidationHarness(harnessInput(ssh, buildNegativeControlPlan()));

    // A `cp -a` of the workspace into the scratch root happened for each control.
    const copies = ssh.commands.filter((c) => c.command.includes("cp -a"));
    expect(copies.length).toBeGreaterThanOrEqual(3);
    expect(copies.every((c) => c.command.includes(WORKSPACE) && c.command.includes(SCRATCH_ROOT))).toBe(true);

    // Every defect write targets a path UNDER the scratch root, never the real workspace
    // root directly (the workspace is never mutated).
    const writes = ssh.commands.filter((c) => c.command.includes("base64 -d"));
    expect(writes.length).toBeGreaterThanOrEqual(3);
    expect(writes.every((c) => c.command.includes(`${SCRATCH_ROOT}`))).toBe(true);

    // Each scratch copy is torn down (rm -rf over a scratch dir).
    const removals = ssh.commands.filter(
      (c) => c.command.startsWith("rm -rf") && c.command.includes(`${SCRATCH_ROOT}/nc-`),
    );
    expect(removals.length).toBeGreaterThanOrEqual(3);
  });
});
