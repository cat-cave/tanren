import { describe, expect, it } from "vitest";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import { checkAnswerSchema, type CheckAnswer } from "../src/engine/providers/answererSchemas.js";
import {
  AnswererSchemaValidationError,
  buildCodexAnswererExecCommand,
  createCodexAnswerer,
  parseStructuredAnswererOutput
} from "../src/engine/providers/codex.js";

const target: SshTarget = {
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity"
};

const authJson = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    access_token: "secret-access-token",
    refresh_token: "secret-refresh-token"
  }
});

describe("Codex Answerer adapter", () => {
  it("constructs read-only codex exec with per-run CODEX_HOME, output schema, and stdin prompt", async () => {
    const answer = JSON.stringify({
      done: true,
      reason: "The writer diff satisfies the fixture criteria.",
      suggested_fixes: null
    });
    const ssh = new ScriptedSsh([ok(""), ok(""), ok(""), ok("{\"type\":\"done\"}\n"), ok(authJson), ok(answer)]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/codex/dev", value: authJson });

    const answerer = createCodexAnswerer<CheckAnswer>({
      secrets,
      ssh,
      target,
      credentialRef: "credential/codex/dev",
      runId: "run_answerer_1"
    });
    const result = await answerer.runAnswerer({
      prompt: "judge this diff",
      timeoutMs: 1000,
      outputSchema: checkAnswerSchema
    });

    expect(ssh.commands[0]?.command.command).toContain("/run_answerer_1/codex-home");
    expect(ssh.commands[2]?.command.command).toContain("cat >");
    expect(ssh.commands[2]?.command.stdin).toBe(JSON.stringify(checkAnswerSchema.jsonSchema));
    expect(ssh.commands[3]?.command.command).toBe(
      "CODEX_HOME='/home/tanren/.tanren/runs/run_answerer_1/codex-home' codex exec --sandbox read-only --json --ignore-user-config --ignore-rules --skip-git-repo-check --cd '/tmp/tanren-answerer-runs/run_answerer_1/tanren.check_answer.v1' --output-schema '/home/tanren/.tanren/runs/run_answerer_1/codex-home/tanren.check_answer.v1.schema.json' --output-last-message '/home/tanren/.tanren/runs/run_answerer_1/codex-home/tanren.check_answer.v1.response.json' -"
    );
    expect(ssh.commands[3]?.command.command).not.toContain("workspace-write");
    expect(ssh.commands[3]?.command.stdin).toBe("judge this diff");
    expect(result.done).toBe(true);
  });

  it("keeps answerer command construction read-only and schema-driven", () => {
    const command = buildCodexAnswererExecCommand({
      codexHome: "/home/tanren/codex",
      workspace: "/tmp/answerer",
      schemaPath: "/home/tanren/codex/check.schema.json",
      outputPath: "/home/tanren/codex/check.response.json"
    });

    expect(command).toContain("--sandbox read-only");
    expect(command).toContain("--output-schema '/home/tanren/codex/check.schema.json'");
    expect(command).toContain("--output-last-message '/home/tanren/codex/check.response.json'");
    expect(command).not.toContain("--sandbox workspace-write");
    expect(command).not.toContain("--add-dir");
  });

  it("turns invalid JSON and nonconforming output into hard schema failures", () => {
    expect(() => parseStructuredAnswererOutput("{", checkAnswerSchema)).toThrow(AnswererSchemaValidationError);
    expect(() =>
      parseStructuredAnswererOutput(
        JSON.stringify({ done: true, reason: "missing suggested fixes" }),
        checkAnswerSchema
      )
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
          suggested_fixes: ["Provide a diff that adds ok."]
        })
      )
    ]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/codex/dev", value: authJson });

    const answerer = createCodexAnswerer<CheckAnswer>({
      secrets,
      ssh,
      target,
      credentialRef: "credential/codex/dev",
      runId: "run_secret"
    });
    const result = await answerer.runAnswerer({ prompt: "judge", timeoutMs: 1000, outputSchema: checkAnswerSchema });
    const commandText = ssh.commands.map((item) => item.command.command).join("\n");

    expect(commandText).not.toContain("secret-access-token");
    expect(commandText).not.toContain("secret-refresh-token");
    expect(JSON.stringify(result)).not.toContain("secret-access-token");
    expect(JSON.stringify(result)).not.toContain("secret-refresh-token");
  });
});

function ok(stdout: string): SshCommandResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

class ScriptedSsh implements SshSubstrate {
  readonly commands: Array<{ target: SshTarget; command: SshCommand }> = [];

  constructor(private readonly results: SshCommandResult[]) {}

  async run(sshTarget: SshTarget, command: SshCommand): Promise<SshCommandResult> {
    this.commands.push({ target: sshTarget, command });
    const result = this.results.shift();
    if (result === undefined) {
      throw new Error(`unexpected SSH command: ${command.command}`);
    }
    return result;
  }
}
