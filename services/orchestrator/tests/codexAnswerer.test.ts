import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { checkAnswerSchema, type CheckAnswer } from "../src/engine/providers/answererSchemas.js";
import {
  AnswererSchemaValidationError,
  buildCodexAnswererExecCommand,
  CodexUsageLimitError,
  createCodexAnswerer,
  parseStructuredAnswererOutput,
} from "../src/engine/providers/codex.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

const authJson = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    access_token: "secret-access-token",
    refresh_token: "secret-refresh-token",
  },
});

describe("Codex Answerer adapter", () => {
  it("constructs read-only codex exec with per-run CODEX_HOME, output schema, and stdin prompt", async () => {
    const answer = JSON.stringify({
      done: true,
      reason: "The writer diff satisfies the fixture criteria.",
      suggested_fixes: null,
    });
    const ssh = new ScriptedSsh([ok(""), ok(""), ok(""), ok('{"type":"done"}\n'), ok(authJson), ok(answer)]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/codex/dev", value: authJson });

    const answerer = createCodexAnswerer<CheckAnswer>({
      secrets,
      ssh,
      target,
      credentialRef: "credential/codex/dev",
      runId: "run_answerer_1",
    });
    const result = await answerer.runAnswerer({
      prompt: "judge this diff",
      timeoutMs: 1000,
      outputSchema: checkAnswerSchema,
    });

    expect(ssh.commands[0]?.command.command).toContain("/run_answerer_1/codex-home");
    expect(ssh.commands[2]?.command.command).toContain("cat >");
    expect(ssh.commands[2]?.command.stdin).toBe(JSON.stringify(checkAnswerSchema.jsonSchema));
    expect(ssh.commands[3]?.command.command).toBe(
      "CODEX_HOME='/home/tanren/.tanren/runs/run_answerer_1/codex-home' codex exec --sandbox read-only --json --ignore-user-config --ignore-rules --skip-git-repo-check --cd '/home/tanren/.tanren/runs/run_answerer_1/tanren.check_answer.v1' --output-schema '/home/tanren/.tanren/runs/run_answerer_1/codex-home/tanren.check_answer.v1.schema.json' --output-last-message '/home/tanren/.tanren/runs/run_answerer_1/codex-home/tanren.check_answer.v1.response.json' -",
    );
    expect(ssh.commands[3]?.command.command).not.toContain("workspace-write");
    expect(ssh.commands[3]?.command.stdin).toBe("judge this diff");
    expect(result.done).toBe(true);
  });

  it("surfaces the call's per-call token usage via lastTokenUsage (for REAL notional accounting)", async () => {
    const answer = JSON.stringify({ done: true, reason: "ok", suggested_fixes: null });
    // A codex `--json` token-count event (input includes cached, output includes reasoning).
    const tokenEvent = JSON.stringify({
      type: "token_count",
      input_tokens: 1000,
      cached_input_tokens: 200,
      output_tokens: 300,
      reasoning_output_tokens: 50,
    });
    const ssh = new ScriptedSsh([ok(""), ok(""), ok(""), ok(`${tokenEvent}\n`), ok(authJson), ok(answer)]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/codex/dev", value: authJson });
    const answerer = createCodexAnswerer<CheckAnswer>({
      secrets,
      ssh,
      target,
      credentialRef: "credential/codex/dev",
      runId: "run_tok",
    });
    // No usage before the first call.
    expect(answerer.lastTokenUsage?.()).toBeUndefined();
    await answerer.runAnswerer({ prompt: "judge", timeoutMs: 1000, outputSchema: checkAnswerSchema });
    // De-overlapped disjoint buckets: input 1000-200=800, output 300-50=250.
    expect(answerer.lastTokenUsage?.()).toMatchObject({
      inputTokens: 800,
      cachedInputTokens: 200,
      outputTokens: 250,
      reasoningOutputTokens: 50,
    });
  });

  it("fails LOUD when the workspace mkdir is denied (no swallowed os-error-2)", async () => {
    // The per-run scratch base is /home/tanren/.tanren/runs (tanren-writable), NOT /tmp.
    // If that mkdir is ever denied, prep must throw — not let codex --cd into a missing dir.
    const ssh = new FailOnMatchSsh(/mkdir -p.*tanren\.check_answer/u, [ok(""), ok(""), ok(""), ok(authJson)]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/codex/dev", value: authJson });
    const answerer = createCodexAnswerer<CheckAnswer>({
      secrets,
      ssh,
      target,
      credentialRef: "credential/codex/dev",
      runId: "run_answerer_1",
    });
    await expect(
      answerer.runAnswerer({ prompt: "judge this diff", timeoutMs: 1000, outputSchema: checkAnswerSchema }),
    ).rejects.toThrow(/workspace prep failed/u);
  });

  it("keeps answerer command construction read-only and schema-driven", () => {
    const command = buildCodexAnswererExecCommand({
      codexHome: "/home/tanren/codex",
      workspace: "/tmp/answerer",
      schemaPath: "/home/tanren/codex/check.schema.json",
      outputPath: "/home/tanren/codex/check.response.json",
    });

    expect(command).toContain("--sandbox read-only");
    expect(command).toContain("--output-schema '/home/tanren/codex/check.schema.json'");
    expect(command).toContain("--output-last-message '/home/tanren/codex/check.response.json'");
    expect(command).not.toContain("--sandbox workspace-write");
    expect(command).not.toContain("--add-dir");
  });

  it("raises CodexUsageLimitError (not a generic failure) when the account hits its usage limit", async () => {
    const usageLimitStdout = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit. try again at May 30th, 2026 8:19 PM."}}',
    ].join("\n");
    const ssh = new ScriptedSsh([ok(""), ok(""), ok(""), ok(usageLimitStdout), ok(authJson)]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/codex/dev", value: authJson });

    const answerer = createCodexAnswerer<CheckAnswer>({
      secrets,
      ssh,
      target,
      credentialRef: "credential/codex/dev",
      runId: "run_answerer_limit",
    });

    await expect(
      answerer.runAnswerer({ prompt: "judge", timeoutMs: 1000, outputSchema: checkAnswerSchema }),
    ).rejects.toBeInstanceOf(CodexUsageLimitError);
  });

  it("repairs a malformed-then-valid answer in ONE bounded re-call (no stage throw, no synthetic P0)", async () => {
    // First exec → invalid JSON in the response file; the schema-repair pass re-asks
    // ONCE and the second response file is a valid CheckAnswer — runAnswerer resolves.
    const valid = JSON.stringify({ done: true, reason: "ok", suggested_fixes: null });
    // Command sequence: materialize (mkdir + write) + schema write, then per runOnce
    // the exec stdout, the auth.json write-back read, and the response-file cat. The
    // FIRST response is invalid JSON → ONE repair re-call → the SECOND is valid.
    const ssh = new ScriptedSsh([
      ok(""),
      ok(""),
      ok(""),
      ok('{"type":"done"}\n'),
      ok(authJson),
      ok("not valid json {"),
      ok('{"type":"done"}\n'),
      ok(authJson),
      ok(valid),
    ]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/codex/dev", value: authJson });

    const answerer = createCodexAnswerer<CheckAnswer>({
      secrets,
      ssh,
      target,
      credentialRef: "credential/codex/dev",
      runId: "run_codex_repair",
    });
    const result = await answerer.runAnswerer({
      prompt: "judge this diff",
      timeoutMs: 1000,
      outputSchema: checkAnswerSchema,
    });
    expect(result.done).toBe(true);
    // The repair exec re-sends the original prompt + the schema error + a re-emit ask.
    const execInputs = ssh.commands.map((c) => c.command.stdin).filter((s): s is string => typeof s === "string");
    const repairStdin = execInputs.at(-1) ?? "";
    expect(repairStdin).toContain("FAILED SCHEMA VALIDATION");
    expect(repairStdin).toContain("judge this diff");
  });

  it("turns invalid JSON and nonconforming output into hard schema failures", () => {
    expect(() => parseStructuredAnswererOutput("{", checkAnswerSchema)).toThrow(AnswererSchemaValidationError);
    expect(() =>
      parseStructuredAnswererOutput(
        JSON.stringify({ done: true, reason: "missing suggested fixes" }),
        checkAnswerSchema,
      ),
    ).toThrow(AnswererSchemaValidationError);
  });

  it("does not leak auth secrets through commands or answerer results", async () => {
    const ssh = new ScriptedSsh([
      ok(""),
      ok(""),
      ok(""),
      ok("{}\n"),
      ok(authJson),
      ok(
        JSON.stringify({
          done: false,
          reason: "No criteria were satisfied.",
          suggested_fixes: ["Provide a diff that adds ok."],
        }),
      ),
    ]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/codex/dev", value: authJson });

    const answerer = createCodexAnswerer<CheckAnswer>({
      secrets,
      ssh,
      target,
      credentialRef: "credential/codex/dev",
      runId: "run_secret",
    });
    const result = await answerer.runAnswerer({
      prompt: "judge",
      timeoutMs: 1000,
      outputSchema: checkAnswerSchema,
    });
    const commandText = ssh.commands.map((item) => item.command.command).join("\n");

    expect(commandText).not.toContain("secret-access-token");
    expect(commandText).not.toContain("secret-refresh-token");
    expect(JSON.stringify(result)).not.toContain("secret-access-token");
    expect(JSON.stringify(result)).not.toContain("secret-refresh-token");
  });
});

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

// A CommandSubstrate that fails any command matching `match` (default exit 1), ok
// otherwise — used to prove a denied workspace mkdir is a LOUD failure, not swallowed.
class FailOnMatchSsh implements CommandSubstrate {
  readonly commands: Array<{ target: RunnerHandle; command: RunnerCommand }> = [];
  constructor(
    private readonly match: RegExp,
    private readonly okResults: CommandResult[],
  ) {}
  async run(sshTarget: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push({ target: sshTarget, command });
    if (this.match.test(command.command)) {
      return { exitCode: 1, stdout: "", stderr: "mkdir: cannot create directory: Permission denied", timedOut: false };
    }
    return this.okResults.shift() ?? ok("");
  }
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
