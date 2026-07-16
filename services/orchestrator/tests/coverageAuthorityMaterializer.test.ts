import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import {
  CoverageAuthorityMaterializationError,
  deriveChangedSourceTargets,
} from "../src/engine/runtimeVerification/coverageAuthorityMaterializer.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:test",
  identitySecretRef: "runner/test",
};
const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);

class RecordingSubstrate implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];

  constructor(private readonly stdout: string) {}

  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    return { exitCode: 0, stdout: this.stdout, stderr: "" };
  }
}

function workspace(ssh: CommandSubstrate) {
  return { ssh, target, workspacePath: "/workspace/repo" };
}

describe("coverage authority production target derivation", () => {
  it("derives canonical source targets from one exact NUL-framed base-to-head diff", async () => {
    const ssh = new RecordingSubstrate("src/z.ts\0src/a b.ts\0src/z.ts\0");
    await expect(deriveChangedSourceTargets(workspace(ssh), BASE_SHA, HEAD_SHA)).resolves.toEqual([
      { kind: "source", targetRef: "src/a b.ts" },
      { kind: "source", targetRef: "src/z.ts" },
    ]);
    expect(ssh.commands).toHaveLength(1);
    expect(ssh.commands[0]?.cwd).toBe("/workspace/repo");
    expect(ssh.commands[0]?.command).toContain("git diff --no-renames --name-only -z");
    expect(ssh.commands[0]?.command).toContain(BASE_SHA);
    expect(ssh.commands[0]?.command).toContain(HEAD_SHA);
  });

  it("fails before command execution for a non-canonical base or head identity", async () => {
    const ssh = new RecordingSubstrate("");
    await expect(deriveChangedSourceTargets(workspace(ssh), "main", HEAD_SHA)).rejects.toBeInstanceOf(
      CoverageAuthorityMaterializationError,
    );
    await expect(deriveChangedSourceTargets(workspace(ssh), BASE_SHA, "HEAD")).rejects.toBeInstanceOf(
      CoverageAuthorityMaterializationError,
    );
    expect(ssh.commands).toHaveLength(0);
  });

  it("rejects truncated framing and non-repository-relative targets", async () => {
    await expect(
      deriveChangedSourceTargets(workspace(new RecordingSubstrate("src/a.ts")), BASE_SHA, HEAD_SHA),
    ).rejects.toThrow("not NUL-terminated");
    await expect(
      deriveChangedSourceTargets(workspace(new RecordingSubstrate("../escape.ts\0")), BASE_SHA, HEAD_SHA),
    ).rejects.toThrow("invalid repository-relative");
  });
});
