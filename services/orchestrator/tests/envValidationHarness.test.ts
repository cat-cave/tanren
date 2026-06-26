import { describe, expect, it } from "vitest";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { sshRunnerHandle } from "../src/engine/contracts/allocator.js";
import { runEnvValidationHarness } from "../src/engine/environments/creation/envValidationHarness.js";
import { environmentValidates } from "../src/engine/environments/creation/envValidationProof.js";
import { buildEnvNegativeControlPlan } from "../src/engine/environments/creation/envNegativeControls.js";

// Environment management (env-management.md §4 + §7 P4) — the ENV-IMAGE validation
// harness: POSITIVE smoke (every declared tool resolves to its locked version) +
// NEGATIVE controls (an undeclared tool is absent + a forbidden version unresolvable).
// An UN-ISOLATED image (a leaked baseline tool) FAILS validation.

const TARGET: RunnerHandle = sshRunnerHandle({
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:fake",
  identitySecretRef: "ref",
});

// A programmable fake substrate: a matcher → result list. Each `run` finds the first
// matcher whose predicate matches the command string and returns its result; an
// unmatched command is a LOUD test failure (so the test declares every probe shape).
type Matcher = { when: (cmd: string) => boolean; result: Partial<CommandResult> };

function fakeSubstrate(matchers: Matcher[]): { ssh: CommandSubstrate; calls: string[] } {
  const calls: string[] = [];
  const ssh: CommandSubstrate = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async run(_handle: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
      calls.push(command.command);
      const m = matchers.find((x) => x.when(command.command));
      if (m === undefined) {
        throw new Error(`fakeSubstrate: no matcher for command: ${command.command}`);
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...m.result };
    },
  };
  return { ssh, calls };
}

const NOW = (): Date => new Date("2026-06-12T00:00:00.000Z");

describe("runEnvValidationHarness — positive smoke + isolation negative controls", () => {
  const toolchain = [{ name: "node", version: "18" }];

  it("an ISOLATED, WORKING env PASSES (smoke green, both controls proven)", async () => {
    const plan = buildEnvNegativeControlPlan(toolchain);
    const { ssh } = fakeSubstrate([
      // POSITIVE smoke: `mise exec -- node --version` exits 0.
      { when: (c) => c.includes("mise exec -- 'node' --version"), result: { exitCode: 0, stdout: "v18.20.4" } },
      // POSITIVE smoke version check: `mise ls --installed node` shows node resolved to 18.x.
      {
        when: (c) => c.includes("mise ls --installed 'node'"),
        result: { exitCode: 0, stdout: "node  18.20.4  ~/mise.toml" },
      },
      // NEGATIVE control 1: the undeclared baseline tool is ABSENT.
      {
        when: (c) => c.includes(`mise which '${plan.undeclaredTool.tool}'`),
        result: { exitCode: 0, stdout: "ABSENT" },
      },
      // NEGATIVE control 2: the forbidden version is ABSENT (mise rejects it).
      { when: (c) => c.includes("mise exec 'node@"), result: { exitCode: 0, stdout: "ABSENT" } },
    ]);
    const proof = await runEnvValidationHarness({
      ssh,
      target: TARGET,
      workspacePath: "/ws",
      toolchain,
      now: NOW,
      timeoutMs: 1000,
    });
    expect(proof.positiveSmokePassed).toBe(true);
    expect(proof.negativeControls.undeclaredToolAbsent).toBe("proven");
    expect(proof.negativeControls.forbiddenVersionAbsent).toBe("proven");
    expect(environmentValidates(proof)).toBe(true);
    expect(proof.validatedAt).toBe("2026-06-12T00:00:00.000Z");
  });

  it("a LEAKED env (an undeclared baseline tool RESOLVES) FAILS validation (control 1 unproven)", async () => {
    const plan = buildEnvNegativeControlPlan(toolchain);
    const { ssh } = fakeSubstrate([
      { when: (c) => c.includes("mise exec -- 'node' --version"), result: { exitCode: 0, stdout: "v18.20.4" } },
      {
        when: (c) => c.includes("mise ls --installed 'node'"),
        result: { exitCode: 0, stdout: "node  18.20.4  ~/mise.toml" },
      },
      // The undeclared baseline tool RESOLVED — the golden base leaked.
      {
        when: (c) => c.includes(`mise which '${plan.undeclaredTool.tool}'`),
        result: { exitCode: 0, stdout: "RESOLVED" },
      },
      { when: (c) => c.includes("mise exec 'node@"), result: { exitCode: 0, stdout: "ABSENT" } },
    ]);
    const proof = await runEnvValidationHarness({
      ssh,
      target: TARGET,
      workspacePath: "/ws",
      toolchain,
      now: NOW,
      timeoutMs: 1000,
    });
    expect(proof.negativeControls.undeclaredToolAbsent).toBe("unproven");
    expect(environmentValidates(proof)).toBe(false);
  });

  it("a VERSION-LEAKY env (the forbidden version RESOLVES) FAILS validation (control 2 unproven)", async () => {
    const plan = buildEnvNegativeControlPlan(toolchain);
    const { ssh } = fakeSubstrate([
      { when: (c) => c.includes("mise exec -- 'node' --version"), result: { exitCode: 0, stdout: "v18.20.4" } },
      {
        when: (c) => c.includes("mise ls --installed 'node'"),
        result: { exitCode: 0, stdout: "node  18.20.4  ~/mise.toml" },
      },
      {
        when: (c) => c.includes(`mise which '${plan.undeclaredTool.tool}'`),
        result: { exitCode: 0, stdout: "ABSENT" },
      },
      // The forbidden version RESOLVED — the env is version-leaky.
      { when: (c) => c.includes("mise exec 'node@"), result: { exitCode: 0, stdout: "RESOLVED" } },
    ]);
    const proof = await runEnvValidationHarness({
      ssh,
      target: TARGET,
      workspacePath: "/ws",
      toolchain,
      now: NOW,
      timeoutMs: 1000,
    });
    expect(proof.negativeControls.forbiddenVersionAbsent).toBe("unproven");
    expect(environmentValidates(proof)).toBe(false);
  });

  it("a tool that does NOT resolve (smoke exec fails) FAILS the positive smoke", async () => {
    const plan = buildEnvNegativeControlPlan(toolchain);
    const { ssh } = fakeSubstrate([
      // The declared tool's `--version` exits non-zero → the env did not bake it.
      { when: (c) => c.includes("mise exec -- 'node' --version"), result: { exitCode: 1 } },
      {
        when: (c) => c.includes(`mise which '${plan.undeclaredTool.tool}'`),
        result: { exitCode: 0, stdout: "ABSENT" },
      },
      { when: (c) => c.includes("mise exec 'node@"), result: { exitCode: 0, stdout: "ABSENT" } },
    ]);
    const proof = await runEnvValidationHarness({
      ssh,
      target: TARGET,
      workspacePath: "/ws",
      toolchain,
      now: NOW,
      timeoutMs: 1000,
    });
    expect(proof.positiveSmokePassed).toBe(false);
    expect(environmentValidates(proof)).toBe(false);
  });

  it("a WRONG resolved version (smoke ran but resolved a different version) FAILS the smoke", async () => {
    const plan = buildEnvNegativeControlPlan(toolchain);
    const { ssh } = fakeSubstrate([
      { when: (c) => c.includes("mise exec -- 'node' --version"), result: { exitCode: 0, stdout: "v20.0.0" } },
      // mise resolved node 20.x, NOT the locked 18 → the env baked the wrong version.
      {
        when: (c) => c.includes("mise ls --installed 'node'"),
        result: { exitCode: 0, stdout: "node  20.0.0  ~/mise.toml" },
      },
      {
        when: (c) => c.includes(`mise which '${plan.undeclaredTool.tool}'`),
        result: { exitCode: 0, stdout: "ABSENT" },
      },
      { when: (c) => c.includes("mise exec 'node@"), result: { exitCode: 0, stdout: "ABSENT" } },
    ]);
    const proof = await runEnvValidationHarness({
      ssh,
      target: TARGET,
      workspacePath: "/ws",
      toolchain,
      now: NOW,
      timeoutMs: 1000,
    });
    expect(proof.positiveSmokePassed).toBe(false);
  });
});

describe("buildEnvNegativeControlPlan — derives isolation probes from the toolchain", () => {
  it("probes an undeclared BASELINE tool when the project declares fewer baseline tools", () => {
    const plan = buildEnvNegativeControlPlan([{ name: "node", version: "18" }]);
    // node is declared, so the undeclared probe picks a baseline tool the project did
    // NOT declare (pnpm/python/go/ruby) — a real golden-base-leak risk.
    expect(["pnpm", "python", "go", "ruby"]).toContain(plan.undeclaredTool.tool);
    expect(plan.forbiddenVersion.tool).toBe("node");
    expect(plan.forbiddenVersion.forbiddenVersion).toBe("0.18");
  });

  it("falls back to the absent SENTINEL when the project declares every baseline tool", () => {
    const plan = buildEnvNegativeControlPlan([
      { name: "node", version: "24" },
      { name: "pnpm", version: "11" },
      { name: "python", version: "3.14" },
      { name: "go", version: "1.26" },
      { name: "ruby", version: "3.4" },
      { name: "rust", version: "1.80" },
    ]);
    // No baseline tool is left undeclared → the sentinel (a tool no env should resolve).
    expect(plan.undeclaredTool.tool).toBe("cobol");
  });
});
