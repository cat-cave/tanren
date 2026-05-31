import { describe, expect, it } from "vitest";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import { auditAnswerSchema, checkAnswerSchema, planAnswerSchema } from "../src/engine/providers/answererSchemas.js";
import { createFakeWriter, fakeAuditor, fakeChecker, fakePlanner } from "./fakeAdapters.fixtures.js";

describe("fake provider adapters", () => {
  it("prove the writer and answerer contracts can complete with real git metadata", async () => {
    const sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const diff = "diff --git a/HELLO.md b/HELLO.md\n+hello world\n";
    const fakeWriter = createFakeWriter({
      ssh: new ScriptedSsh([
        { exitCode: 0, stdout: "", stderr: "", timedOut: false },
        { exitCode: 0, stdout: diff, stderr: "", timedOut: false },
        { exitCode: 0, stdout: `${sha}\thello world\n`, stderr: "", timedOut: false },
      ]),
      target,
    });

    const plan = await fakePlanner.runAnswerer({
      prompt: "plan",
      timeoutMs: 100,
      outputSchema: planAnswerSchema,
    });
    const writer = await fakeWriter.runWriter({
      prompt: "write",
      workspace: "/workspace",
      timeoutMs: 100,
    });
    const check = await fakeChecker.runAnswerer({
      prompt: writer.diff,
      timeoutMs: 100,
      outputSchema: checkAnswerSchema,
    });
    const audit = await fakeAuditor.runAnswerer({
      prompt: JSON.stringify(plan),
      timeoutMs: 100,
      outputSchema: auditAnswerSchema,
    });

    expect(plan.subtasks).toHaveLength(1);
    expect(writer.exitReason).toBe("completed");
    expect(writer.diff).toBe(diff);
    expect(writer.commits).toEqual([{ sha, message: "hello world" }]);
    expect(check.done).toBe(true);
    expect(audit.verified).toBe(true);
  });
});

const target: SshTarget = {
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

class ScriptedSsh implements SshSubstrate {
  constructor(private readonly results: SshCommandResult[]) {}

  async run(_target: SshTarget, _command: SshCommand): Promise<SshCommandResult> {
    const result = this.results.shift();
    if (result === undefined) {
      throw new Error("unexpected SSH command");
    }
    return result;
  }
}
