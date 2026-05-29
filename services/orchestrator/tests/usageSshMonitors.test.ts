import { describe, expect, it } from "vitest";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import {
  SshCcusageAccountant,
  SshCodexbarUsageMonitor,
  buildCcusageCommand,
  buildCodexbarUsageCommand,
} from "../src/engine/usage/sshMonitors.js";

const target: SshTarget = {
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

class ScriptedSsh implements SshSubstrate {
  readonly commands: SshCommand[] = [];
  constructor(private readonly result: SshCommandResult) {}
  async run(_target: SshTarget, command: SshCommand): Promise<SshCommandResult> {
    this.commands.push(command);
    return this.result;
  }
}

function ok(stdout: string): SshCommandResult {
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

describe("SshCodexbarUsageMonitor", () => {
  it("runs codexbar over SSH and parses the window state", async () => {
    const ssh = new ScriptedSsh(ok(codexbarJson));
    const monitor = new SshCodexbarUsageMonitor(ssh);
    const usage = await monitor.readWindowState({
      provider: "codex",
      codexHome,
      target,
      timeoutMs: 5000,
    });
    expect(ssh.commands[0]?.command).toContain("codexbar usage --provider 'codex'");
    expect(ssh.commands[0]?.command).toContain(`CODEX_HOME='${codexHome}'`);
    expect(usage?.windows.map((window) => window.slot)).toEqual(["primary", "secondary"]);
    expect(usage?.creditsRemaining).toBe(0);
  });

  it("returns null on a non-zero exit and logs a note (never throws)", async () => {
    const notes: string[] = [];
    const ssh = new ScriptedSsh({ exitCode: 1, stdout: "", stderr: "boom", timedOut: false });
    const monitor = new SshCodexbarUsageMonitor(ssh, (message) => notes.push(message));
    await expect(
      monitor.readWindowState({ provider: "codex", codexHome, target, timeoutMs: 5000 }),
    ).resolves.toBeNull();
    expect(notes[0]).toContain("codexbar exited 1");
  });

  it("returns null on timeout", async () => {
    const ssh = new ScriptedSsh({ exitCode: null, stdout: "", stderr: "", timedOut: true });
    const monitor = new SshCodexbarUsageMonitor(ssh, () => {});
    await expect(
      monitor.readWindowState({ provider: "codex", codexHome, target, timeoutMs: 5000 }),
    ).resolves.toBeNull();
  });
});

describe("SshCcusageAccountant", () => {
  it("runs ccusage over SSH and parses the accounting", async () => {
    const ssh = new ScriptedSsh(ok(ccusageJson));
    const accountant = new SshCcusageAccountant(ssh);
    const accounting = await accountant.readAccounting({
      cli: "codex",
      codexHome,
      target,
      timeoutMs: 5000,
    });
    expect(ssh.commands[0]?.command).toContain("ccusage 'codex' --json");
    expect(accounting?.cli).toBe("codex");
    expect(accounting?.costUsd).toBeNull();
    expect(accounting?.totals.totalTokens).toBe(13);
  });

  it("returns null on an ssh failure (never throws)", async () => {
    const ssh = new ScriptedSsh({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      failure: { kind: "ssh_failed", target: "runner", message: "down" },
    });
    const accountant = new SshCcusageAccountant(ssh, () => {});
    await expect(accountant.readAccounting({ cli: "codex", codexHome, target, timeoutMs: 5000 })).resolves.toBeNull();
  });
});
