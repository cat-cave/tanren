// batchNodeGate — the §3 batch integration-node gate closure. Proves the
// fail-closed gate-config boundary: an INVALID `.tanren/ci.yml` on the integrated
// workspace (built-repo data) is a gate FAIL VERDICT (never a throw-to-infra-hold that
// would hot-loop the retry timer on a permanent config error, and never a pass). A
// VALID config runs the pre_merge tiers as before. No live runner: an interpreting SSH
// fake drives the small command vocabulary the closure issues.
import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import type { LiveJjWorkspace } from "../src/engine/providers/liveJjWorkspace.js";
import { batchNodeGate } from "../src/engine/merge/batchNodeGate.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

// Interprets the command vocabulary batchNodeGate issues: the `.tanren/ci.yml` read
// (returns `ciYaml` or empty), the local-ignore seed + deps-ensure (no-op ok), and the
// pre_merge tier steps (pnpm ... → ok). An invalid `ciYaml` drives the config boundary.
class Ssh implements CommandSubstrate {
  constructor(private readonly ciYaml?: string) {}
  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    const ok = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    if (command.command.includes(".tanren/ci.yml")) {
      return this.ciYaml === undefined ? ok : { ...ok, stdout: this.ciYaml };
    }
    return ok;
  }
}

// The closure reads the substrate from `deps.ssh`; `live` only supplies the runner
// target + workspace path it runs the gate ON.
function live(): LiveJjWorkspace {
  return { target, workspacePath: "/workspace/runs/run_batch/repo" } as unknown as LiveJjWorkspace;
}

function gateDeps(ssh: CommandSubstrate) {
  return {
    ssh,
    eventStore: new FakeEventStore(),
    governancePosture: "open" as const,
    integrationRef: "tanren-batch-local",
    projectId: "project_b",
    tailSpecId: "spec_tail",
    timeoutMs: 100,
  };
}

describe("batchNodeGate — invalid .tanren/ci.yml is a fail VERDICT (not a throw)", () => {
  const INVALID_CI_YAML = "version: 1\ntiers:\n  fast:\n    name: lint\n    run: pnpm lint\n";

  it("returns a fail verdict naming the invalid config (no throw-to-infra-hold, never a pass)", async () => {
    const gate = batchNodeGate(gateDeps(new Ssh(INVALID_CI_YAML)));

    const { verdict, passed } = await gate(live());

    expect(passed).toBe(false);
    expect(verdict.result).toBe("fail");
    if (verdict.result !== "fail") throw new Error("unreachable");
    expect(verdict.message).toContain(".tanren/ci.yml");
    expect(verdict.message).toContain("invalid tanren-ci.yml");
  });

  it("a VALID config still runs the pre_merge tiers and passes a green tree", async () => {
    const validYaml = [
      "version: 1",
      "tiers:",
      "  fast:",
      "    - name: lint",
      "      run: pnpm lint",
      "  slow:",
      "    - name: build",
      "      run: pnpm build",
      "when:",
      "  fast:",
      "    - pre_merge",
      "  slow:",
      "    - pre_merge",
      "",
    ].join("\n");
    const gate = batchNodeGate(gateDeps(new Ssh(validYaml)));

    const { verdict, passed } = await gate(live());

    expect(passed).toBe(true);
    expect(verdict.result).toBe("pass");
  });
});
