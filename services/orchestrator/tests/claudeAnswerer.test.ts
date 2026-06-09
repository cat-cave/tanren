import { describe, expect, it } from "vitest";
import { AnswererSchemaValidationError } from "../src/engine/providers/codex.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { checkAnswerSchema, type CheckAnswer } from "../src/engine/providers/answererSchemas.js";
import {
  buildAnswererPrompt,
  buildClaudeAnswererCommand,
  ClaudeUsageLimitError,
  createClaudeAnswerer,
  extractClaudeFinalText,
  parseClaudeAnswererOutput,
} from "../src/engine/providers/claude.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

const authJson = JSON.stringify({ claudeAiOauth: { accessToken: "secret-access-token" } });

const answer = JSON.stringify({
  done: true,
  reason: "The diff satisfies the criteria.",
  suggested_fixes: null,
});

describe("Claude Answerer adapter", () => {
  it("runs read-only (plan mode), seeds the schema into the prompt, and parses the result text", async () => {
    const resultLine = JSON.stringify({ type: "result", result: answer });
    const ssh = new ScriptedSsh([ok(""), ok(""), ok(`${resultLine}\n`)]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/claude/dev", value: authJson });

    const answerer = createClaudeAnswerer<CheckAnswer>({
      secrets,
      ssh,
      target,
      credentialRef: "credential/claude/dev",
      runId: "run_claude_answerer_1",
    });
    const result = await answerer.runAnswerer({
      prompt: "judge this diff",
      timeoutMs: 1000,
      outputSchema: checkAnswerSchema,
    });

    expect(ssh.commands[0]?.command.command).toContain("/run_claude_answerer_1/claude-home");
    expect(ssh.commands[2]?.command.command).toContain("--permission-mode plan");
    expect(ssh.commands[2]?.command.command).not.toContain("acceptEdits");
    expect(ssh.commands[2]?.command.stdin).toContain("judge this diff");
    expect(ssh.commands[2]?.command.stdin).toContain(checkAnswerSchema.name);
    expect(result.done).toBe(true);
  });

  it("raises ClaudeUsageLimitError when the account hits its usage limit", async () => {
    const limit = JSON.stringify({
      type: "result",
      result: "You hit your usage limit. Try again at 8 PM.",
    });
    const ssh = new ScriptedSsh([ok(""), ok(""), ok(`${limit}\n`)]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/claude/dev", value: authJson });

    const answerer = createClaudeAnswerer<CheckAnswer>({
      secrets,
      ssh,
      target,
      credentialRef: "credential/claude/dev",
      runId: "run_claude_answerer_limit",
    });
    await expect(
      answerer.runAnswerer({ prompt: "judge", timeoutMs: 1000, outputSchema: checkAnswerSchema }),
    ).rejects.toBeInstanceOf(ClaudeUsageLimitError);
  });

  it("repairs a malformed-then-valid answer in ONE bounded re-call (no stage throw)", async () => {
    // First exec returns invalid JSON; the schema-repair pass re-asks ONCE and the
    // second exec returns a valid CheckAnswer — runAnswerer resolves, no throw.
    const bad = JSON.stringify({ type: "result", result: "not json at all {" });
    const good = JSON.stringify({ type: "result", result: answer });
    const ssh = new ScriptedSsh([ok(""), ok(""), ok(`${bad}\n`), ok(`${good}\n`)]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/claude/dev", value: authJson });

    const answerer = createClaudeAnswerer<CheckAnswer>({
      secrets,
      ssh,
      target,
      credentialRef: "credential/claude/dev",
      runId: "run_claude_repair",
    });
    const result = await answerer.runAnswerer({
      prompt: "judge this diff",
      timeoutMs: 1000,
      outputSchema: checkAnswerSchema,
    });
    expect(result.done).toBe(true);
    // Exactly ONE repair re-call: the materialize + mkdir + 2 execs = 4 commands.
    const execInputs = ssh.commands.map((c) => c.command.stdin).filter((s): s is string => typeof s === "string");
    const repairStdin = execInputs.at(-1) ?? "";
    expect(repairStdin).toContain("FAILED SCHEMA VALIDATION");
    expect(repairStdin).toContain("judge this diff");
    expect(ssh.commands).toHaveLength(4);
  });

  it("fails LOUD when the repair re-call still misses the schema (bounded to one pass)", async () => {
    const bad = JSON.stringify({ type: "result", result: "still not json {" });
    const ssh = new ScriptedSsh([ok(""), ok(""), ok(`${bad}\n`), ok(`${bad}\n`)]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/claude/dev", value: authJson });

    const answerer = createClaudeAnswerer<CheckAnswer>({
      secrets,
      ssh,
      target,
      credentialRef: "credential/claude/dev",
      runId: "run_claude_repair_fail",
    });
    await expect(
      answerer.runAnswerer({ prompt: "judge", timeoutMs: 1000, outputSchema: checkAnswerSchema }),
    ).rejects.toBeInstanceOf(AnswererSchemaValidationError);
    // Only ONE repair attempt — no infinite loop (materialize + mkdir + 2 execs).
    expect(ssh.commands).toHaveLength(4);
  });

  it("keeps answerer command read-only and parses fenced JSON", () => {
    const command = buildClaudeAnswererCommand({
      configDir: "/home/tanren/claude",
      workspace: "/tmp/answerer",
    });
    expect(command).toContain("--permission-mode plan");
    expect(command).not.toContain("acceptEdits");

    const parsed = parseClaudeAnswererOutput("```json\n" + answer + "\n```", checkAnswerSchema);
    expect(parsed.done).toBe(true);
  });

  it("turns invalid JSON and nonconforming output into hard schema failures", () => {
    expect(() => parseClaudeAnswererOutput("{", checkAnswerSchema)).toThrow(AnswererSchemaValidationError);
    expect(() => parseClaudeAnswererOutput(JSON.stringify({ done: true }), checkAnswerSchema)).toThrow(
      AnswererSchemaValidationError,
    );
  });

  it("extracts the final result text, falling back to the last assistant block", () => {
    const stream = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "first" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "second" }] },
      }),
    ].join("\n");
    expect(extractClaudeFinalText(stream)).toBe("second");
    expect(extractClaudeFinalText(JSON.stringify({ type: "result", result: "final" }))).toBe("final");
  });

  it("builds an answerer prompt that names the schema and forbids markdown fences", () => {
    const prompt = buildAnswererPrompt("do x", "tanren.check_answer.v1", { type: "object" });
    expect(prompt).toContain("tanren.check_answer.v1");
    expect(prompt).toContain("ONLY a single JSON object");
  });
});

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

class ScriptedSsh implements CommandSubstrate {
  readonly commands: Array<{ target: RunnerHandle; command: RunnerCommand }> = [];

  constructor(private readonly results: CommandResult[]) {}

  async run(sshTarget: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push({ target: sshTarget, command });
    const result = this.results.shift();
    if (result === undefined) {
      throw new Error(`unexpected SSH command: ${command.command}`);
    }
    return result;
  }
}
