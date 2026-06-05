// Per-run sandbox teardown primitive (layer 1 of the ≈204 GB disk-leak fix). Proves
// `removeRunWorkspaceDir` builds the `rm -rf /workspace/runs/<runId>` command for a
// safe run id, refuses (without running anything) a malformed id, and never throws —
// a non-zero exit / transport fault becomes a `{ removed: false }` outcome the caller
// logs and tolerates (it must not mask the run's own error in the run `finally`).

import { describe, expect, it } from "vitest";
import { removeRunWorkspaceDir } from "../src/engine/workspace/runWorkspaceTeardown.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";

const TARGET: RunnerHandle = { backend: "ssh" };

class RecordingSubstrate implements CommandSubstrate {
  commands: string[] = [];
  constructor(private readonly result: CommandResult) {}
  async run(_handle: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command.command);
    return this.result;
  }
}

const OK: CommandResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };

describe("removeRunWorkspaceDir", () => {
  it("removes the run's `/workspace/runs/<runId>` ROOT dir (not just …/repo)", async () => {
    const sub = new RecordingSubstrate(OK);
    const out = await removeRunWorkspaceDir(sub, TARGET, "run_abc-123");
    expect(out).toEqual({ removed: true });
    expect(sub.commands).toEqual(["rm -rf '/workspace/runs/run_abc-123'"]);
  });

  it("refuses a malformed run id WITHOUT running any command", async () => {
    const sub = new RecordingSubstrate(OK);
    const out = await removeRunWorkspaceDir(sub, TARGET, "run_../escape");
    expect(out.removed).toBe(false);
    expect(out.reason).toContain("unsafe run id");
    expect(sub.commands).toEqual([]);
  });

  it("reports (does not throw) a non-zero rm exit", async () => {
    const sub = new RecordingSubstrate({ exitCode: 1, stdout: "", stderr: "rm: permission denied", timedOut: false });
    const out = await removeRunWorkspaceDir(sub, TARGET, "run_x");
    expect(out.removed).toBe(false);
    expect(out.reason).toContain("permission denied");
  });

  it("reports (does not throw) an in-band transport failure", async () => {
    const sub = new RecordingSubstrate({
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      failure: { kind: "ssh_failed", target: "runner", message: "connection refused" },
    });
    const out = await removeRunWorkspaceDir(sub, TARGET, "run_x");
    expect(out.removed).toBe(false);
    expect(out.reason).toContain("connection refused");
  });

  it("swallows a thrown transport error into a false outcome", async () => {
    const throwing: CommandSubstrate = {
      async run() {
        throw new Error("socket exploded");
      },
    };
    const out = await removeRunWorkspaceDir(throwing, TARGET, "run_x");
    expect(out.removed).toBe(false);
    expect(out.reason).toContain("socket exploded");
  });
});
