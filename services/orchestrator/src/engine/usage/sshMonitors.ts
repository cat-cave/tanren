import type { SshTarget } from "../contracts/allocator.js";
import type { SshCommandResult, SshSubstrate } from "../contracts/sshSubstrate.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { parseCcusageAccounting } from "./ccusageParser.js";
import { parseCodexbarUsage } from "./codexbarParser.js";
import type { CcusageAccounting, UsageAccountant, UsageMonitor, WindowUsage } from "./contracts.js";

// A best-effort log sink for "no data" notes. These monitors NEVER throw for a
// missing/empty result — that is an allowed state — but a non-zero exit or a
// timeout is worth a note so an operator can tell the tool apart from genuine
// absence of data.
export type UsageNote = (message: string) => void;

const defaultNote: UsageNote = (message) => {
  console.warn(`[usage-monitor] ${message}`);
};

// SshCodexbarUsageMonitor runs codexbar in the runner over the SSH substrate
// against the per-run materialized CODEX_HOME — the same path agent workloads
// use, honoring the no-host-process-spawn rule.
export class SshCodexbarUsageMonitor implements UsageMonitor {
  constructor(
    private readonly ssh: SshSubstrate,
    private readonly note: UsageNote = defaultNote
  ) {}

  async readWindowState(input: {
    provider: string;
    codexHome: string;
    target: SshTarget;
    timeoutMs: number;
  }): Promise<WindowUsage | null> {
    const command = buildCodexbarUsageCommand({ provider: input.provider, codexHome: input.codexHome });
    const result = await this.ssh.run(input.target, { command, timeoutMs: input.timeoutMs });
    if (!usableResult(result, "codexbar", input.provider, this.note)) {
      return null;
    }
    return parseCodexbarUsage(result.stdout, input.provider);
  }
}

// SshCcusageAccountant runs `ccusage <cli> --json` in the runner over SSH
// against the per-run materialized CODEX_HOME.
export class SshCcusageAccountant implements UsageAccountant {
  constructor(
    private readonly ssh: SshSubstrate,
    private readonly note: UsageNote = defaultNote
  ) {}

  async readAccounting(input: {
    cli: string;
    codexHome: string;
    target: SshTarget;
    timeoutMs: number;
  }): Promise<CcusageAccounting | null> {
    const command = buildCcusageCommand({ cli: input.cli, codexHome: input.codexHome });
    const result = await this.ssh.run(input.target, { command, timeoutMs: input.timeoutMs });
    if (!usableResult(result, "ccusage", input.cli, this.note)) {
      return null;
    }
    return parseCcusageAccounting(result.stdout, input.cli);
  }
}

// `CODEX_HOME=<q> codexbar usage --provider <q> --source cli --format json`
export function buildCodexbarUsageCommand(input: { provider: string; codexHome: string }): string {
  return [
    `CODEX_HOME=${quoteSshShellArg(input.codexHome)}`,
    "codexbar usage",
    "--provider",
    quoteSshShellArg(input.provider),
    "--source cli",
    "--format json"
  ].join(" ");
}

// `CODEX_HOME=<q> ccusage <cli> --json`
export function buildCcusageCommand(input: { cli: string; codexHome: string }): string {
  return [`CODEX_HOME=${quoteSshShellArg(input.codexHome)}`, "ccusage", quoteSshShellArg(input.cli), "--json"].join(" ");
}

// A non-zero exit, a timeout, or an SSH failure is "no data" (return null) plus
// a logged note — never an exception. A clean exit hands stdout to the parser,
// which itself tolerates empty / error-envelope output.
function usableResult(result: SshCommandResult, tool: string, target: string, note: UsageNote): boolean {
  if (result.timedOut) {
    note(`${tool} timed out for ${target}; treating as no data`);
    return false;
  }
  if (result.failure !== undefined) {
    note(`${tool} ssh failure for ${target}; treating as no data`);
    return false;
  }
  if (result.exitCode !== 0) {
    note(`${tool} exited ${result.exitCode ?? "unknown"} for ${target}; treating as no data`);
    return false;
  }
  return true;
}
