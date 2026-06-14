// `jj config set <NAME> <VALUE>` parses <VALUE> as a TOML expression, so the identity
// values the live merge path feeds it (a GitHub App `[bot]` login / its noreply email)
// must be handed to jj as TOML-quoted basic strings — a bare `[bot]` is a TOML parse
// error that deterministically infra-blocks every merge. These tests pin {@link toTomlString}
// (the TOML-value encoder) and assert the openWorkspace command builder emits a TOML-quoted
// value for a `[bot]` identity.

import { describe, expect, it } from "vitest";
import { sshRunnerHandle, type RunnerHandle } from "../src/engine/contracts/allocator.js";
import { FakeCommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import type { CommandResult, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { JjWorkspaceVcsCore, type JjCommitIdentity } from "../src/engine/providers/jjWorkspaceVcsCore.js";
import { toTomlString } from "../src/engine/providers/jjConfigValue.js";

describe("toTomlString (jj config set <VALUE> is parsed as TOML)", () => {
  it("wraps a plain value in TOML double-quotes verbatim", () => {
    expect(toTomlString("Tanren")).toBe('"Tanren"');
    expect(toTomlString("tanren@local")).toBe('"tanren@local"');
  });

  it("makes a `[bot]` login a valid TOML string (the root-cause case)", () => {
    // Bare `tanren-cat-cave-validation[bot]` is a TOML parse error (the `[` opens an array).
    expect(toTomlString("tanren-cat-cave-validation[bot]")).toBe('"tanren-cat-cave-validation[bot]"');
    expect(toTomlString("290060348+tanren-cat-cave-validation[bot]@users.noreply.github.com")).toBe(
      '"290060348+tanren-cat-cave-validation[bot]@users.noreply.github.com"',
    );
  });

  it("escapes embedded double-quotes and backslashes per TOML basic-string rules", () => {
    expect(toTomlString('a"b')).toBe('"a\\"b"');
    expect(toTomlString("a\\b")).toBe('"a\\\\b"');
    expect(toTomlString('a"\\b')).toBe('"a\\"\\\\b"');
  });

  it("escapes the TOML-named control characters and \\uXXXX-escapes the rest", () => {
    expect(toTomlString("a\tb\nc\rd")).toBe('"a\\tb\\nc\\rd"');
    expect(toTomlString("a\bb\fc")).toBe('"a\\bb\\fc"');
    // U+0001 has no named escape → short \uXXXX form (upper-case hex, 4 digits).
    expect(toTomlString("ab")).toBe('"a\\u0001b"');
    expect(toTomlString("ab")).toBe('"a\\u007Fb"');
  });

  it("passes printable Unicode through verbatim", () => {
    expect(toTomlString("café-é")).toBe('"café-é"');
  });
});

/** Records every command the workspace mechanism runs so the test reads the identity config. */
class RecordingSubstrate extends FakeCommandSubstrate {
  readonly commands: string[] = [];
  override async run(handle: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command.command);
    return super.run(handle, command);
  }
}

describe("openWorkspace command builder TOML-quotes the jj identity value", () => {
  it("emits a TOML-quoted `[bot]` identity (no TOML parse error on a real runner)", async () => {
    const ssh = new RecordingSubstrate();
    const target: RunnerHandle = sshRunnerHandle({
      host: "runner",
      port: 22,
      username: "tanren",
      hostKeyFingerprint: "SHA256:fake",
      identitySecretRef: "secret/runner/identity",
    });
    const botIdentity: JjCommitIdentity = {
      name: "tanren-cat-cave-validation[bot]",
      email: "290060348+tanren-cat-cave-validation[bot]@users.noreply.github.com",
    };
    const core = new JjWorkspaceVcsCore({ substrate: ssh, target, timeoutMs: 1000, commitIdentity: botIdentity });
    await core.openWorkspace({ repoUrl: "/fixture/repo", baseBranch: "main", path: "/ws/repo" });

    const nameCmd = ssh.commands.find((c) => c.includes("jj config set --repo user.name"));
    const emailCmd = ssh.commands.find((c) => c.includes("jj config set --repo user.email"));
    expect(nameCmd).toBeDefined();
    expect(emailCmd).toBeDefined();
    // The VALUE is the TOML basic string `"..."` (jj's TOML parser layer) inside the shell
    // single-quotes (the shell layer). The bare `[bot]` form would be a TOML parse error.
    expect(nameCmd).toContain(`jj config set --repo user.name '${toTomlString(botIdentity.name)}'`);
    expect(nameCmd).toContain(`'"tanren-cat-cave-validation[bot]"'`);
    expect(emailCmd).toContain(`jj config set --repo user.email '${toTomlString(botIdentity.email)}'`);
  });
});
