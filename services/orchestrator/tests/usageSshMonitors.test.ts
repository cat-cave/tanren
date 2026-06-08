import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import {
  SshCcusageAccountant,
  SshCodexbarUsageMonitor,
  buildCcusageCommand,
  buildCodexbarUsageCommand,
} from "../src/engine/usage/sshMonitors.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

const codexHome = "/home/tanren/.tanren/runs/run_usage_1/codex-home";

const codexbarJson = JSON.stringify([
  {
    provider: "codex",
    source: "codex-cli",
    usage: {
      accountEmail: "operator@example.com",
      primary: {
        usedPercent: 0,
        resetsAt: "2026-05-28T08:37:21Z",
        windowMinutes: 300,
        resetDescription: "tomorrow",
      },
      secondary: {
        usedPercent: 100,
        resetsAt: "2026-05-30T20:19:33Z",
        windowMinutes: 10080,
        resetDescription: "May 30",
      },
      tertiary: null,
      updatedAt: "2026-05-28T03:41:23Z",
    },
    credits: { events: [], remaining: 0, updatedAt: "2026-05-28T03:41:23Z" },
  },
]);

const ccusageJson = JSON.stringify({
  daily: [],
  totals: {
    inputTokens: 10,
    outputTokens: 2,
    cachedInputTokens: 1,
    reasoningOutputTokens: 0,
    totalTokens: 13,
    costUSD: 0,
  },
});

class ScriptedSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  constructor(private readonly result: CommandResult) {}
  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    return this.result;
  }
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

describe("command builders", () => {
  it("builds the codexbar command with quoted CODEX_HOME and provider", () => {
    expect(buildCodexbarUsageCommand({ provider: "codex", codexHome })).toBe(
      `CODEX_HOME='${codexHome}' codexbar usage --provider 'codex' --source cli --format json`,
    );
  });

  it("builds the ccusage command with quoted CODEX_HOME and cli", () => {
    expect(buildCcusageCommand({ cli: "codex", codexHome })).toBe(`CODEX_HOME='${codexHome}' ccusage 'codex' --json`);
  });
});

// A monitor/accountant read is DISCRIMINATED: `{ ok }` (parsed, or null for a
// clean-but-empty read) vs `{ failed }` (LOUD — timeout / SSH / nonzero / malformed).
function okRead<T>(read: { ok: T } | { failed: unknown }): T {
  if (!("ok" in read)) {
    throw new Error(`expected an ok read, got ${JSON.stringify(read)}`);
  }
  return read.ok;
}

describe("SshCodexbarUsageMonitor", () => {
  it("runs codexbar over SSH and parses the window state", async () => {
    const ssh = new ScriptedSsh(ok(codexbarJson));
    const monitor = new SshCodexbarUsageMonitor(ssh);
    const read = await monitor.readWindowState({
      provider: "codex",
      codexHome,
      target,
      timeoutMs: 5000,
    });
    expect(ssh.commands[0]?.command).toContain("codexbar usage --provider 'codex'");
    expect(ssh.commands[0]?.command).toContain(`CODEX_HOME='${codexHome}'`);
    const usage = okRead(read);
    expect(usage?.windows.map((window) => window.slot)).toEqual(["primary", "secondary"]);
    expect(usage?.creditsRemaining).toBe(0);
  });

  it("returns a LOUD `{ failed }` read on a non-zero exit + a note (never throws)", async () => {
    const notes: string[] = [];
    const ssh = new ScriptedSsh({ exitCode: 1, stdout: "", stderr: "boom", timedOut: false });
    const monitor = new SshCodexbarUsageMonitor(ssh, (message) => notes.push(message));
    const read = await monitor.readWindowState({ provider: "codex", codexHome, target, timeoutMs: 5000 });
    expect(read).toEqual({
      failed: { tool: "codexbar", target: "codex", reason: "nonzero_exit", exitCode: 1, detail: "boom" },
    });
    expect(notes[0]).toContain("codexbar read failed");
    expect(notes[0]).toContain("usage.read_failed");
  });

  it("returns a LOUD `{ failed }` read on timeout", async () => {
    const ssh = new ScriptedSsh({ exitCode: null, stdout: "", stderr: "", timedOut: true });
    const monitor = new SshCodexbarUsageMonitor(ssh, () => {});
    const read = await monitor.readWindowState({ provider: "codex", codexHome, target, timeoutMs: 5000 });
    expect(read).toEqual({
      failed: { tool: "codexbar", target: "codex", reason: "timeout", exitCode: null, detail: "" },
    });
  });

  it("on a CLEAN exit with MALFORMED non-empty output, fails LOUD (distinct from empty)", async () => {
    const notes: string[] = [];
    const ssh = new ScriptedSsh(ok("not json at all"));
    const monitor = new SshCodexbarUsageMonitor(ssh, (m) => notes.push(m));
    const read = await monitor.readWindowState({ provider: "codex", codexHome, target, timeoutMs: 5000 });
    expect(read).toMatchObject({ failed: { reason: "malformed_output", exitCode: 0 } });
    expect(notes[0]).toContain("usage.read_failed");
  });

  it("on a clean exit with the EMPTY `[]` envelope, is a quiet `{ ok: null }` (legitimate-empty)", async () => {
    const notes: string[] = [];
    const ssh = new ScriptedSsh(ok("[]"));
    const monitor = new SshCodexbarUsageMonitor(ssh, (m) => notes.push(m));
    const read = await monitor.readWindowState({ provider: "codex", codexHome, target, timeoutMs: 5000 });
    expect(read).toEqual({ ok: null });
    // legitimate-empty stays QUIET — no read-failed note.
    expect(notes).toEqual([]);
  });
});

describe("SshCcusageAccountant", () => {
  it("runs ccusage over SSH and parses the accounting", async () => {
    const ssh = new ScriptedSsh(ok(ccusageJson));
    const accountant = new SshCcusageAccountant(ssh);
    const read = await accountant.readAccounting({
      cli: "codex",
      codexHome,
      target,
      timeoutMs: 5000,
    });
    expect(ssh.commands[0]?.command).toContain("ccusage 'codex' --json");
    const accounting = okRead(read);
    expect(accounting?.cli).toBe("codex");
    expect(accounting?.costUsd).toBeNull();
    expect(accounting?.totals.totalTokens).toBe(13);
  });

  it("returns a LOUD `{ failed }` read on an ssh failure (never throws)", async () => {
    const ssh = new ScriptedSsh({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      failure: { kind: "ssh_failed", target: "runner", message: "down" },
    });
    const accountant = new SshCcusageAccountant(ssh, () => {});
    const read = await accountant.readAccounting({ cli: "codex", codexHome, target, timeoutMs: 5000 });
    expect(read).toEqual({
      failed: { tool: "ccusage", target: "codex", reason: "ssh_failure", exitCode: 0, detail: "down" },
    });
  });

  it("on a CLEAN exit with MALFORMED non-empty ccusage output, fails LOUD (not zero usage)", async () => {
    const notes: string[] = [];
    const ssh = new ScriptedSsh(ok(JSON.stringify({ unexpected: true })));
    const accountant = new SshCcusageAccountant(ssh, (m) => notes.push(m));
    const read = await accountant.readAccounting({ cli: "codex", codexHome, target, timeoutMs: 5000 });
    expect(read).toMatchObject({ failed: { reason: "malformed_output" } });
    expect(notes[0]).toContain("usage.read_failed");
  });

  it("on a clean exit with EMPTY ccusage stdout, is a quiet `{ ok: null }` (legitimate-empty)", async () => {
    const notes: string[] = [];
    const ssh = new ScriptedSsh(ok("   "));
    const accountant = new SshCcusageAccountant(ssh, (m) => notes.push(m));
    const read = await accountant.readAccounting({ cli: "codex", codexHome, target, timeoutMs: 5000 });
    expect(read).toEqual({ ok: null });
    expect(notes).toEqual([]);
  });
});
