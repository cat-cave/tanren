import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandResult, CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { CostResolver } from "../contracts/costResolver.js";
import type { Failure } from "../failure.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { parseCcusageAccounting } from "./ccusageParser.js";
import { parseCodexbarUsageResult } from "./codexbarParser.js";
import type {
  AccountingRead,
  UsageAccountant,
  UsageMeter,
  UsageMonitor,
  UsageReadFailure,
  WindowRead,
} from "./contracts.js";

// A best-effort log sink for read-failure notes. A timeout / SSH transport
// failure / non-zero exit / malformed output is a LOUD `{ failed }` read result
// (NOT a silent "no data"); the note is the operator-facing line that names the
// tool apart from a genuine absence of data. A clean-but-empty read is quiet.
export type UsageNote = (message: string) => void;

const defaultNote: UsageNote = (message) => {
  console.warn(`[usage-monitor] ${message}`);
};

// SshCodexbarUsageMonitor runs codexbar in the runner over the SSH substrate
// against the per-run materialized CODEX_HOME — the same path agent workloads
// use, honoring the no-host-process-spawn rule.
export class SshCodexbarUsageMonitor implements UsageMonitor {
  constructor(
    private readonly ssh: CommandSubstrate,
    private readonly note: UsageNote = defaultNote,
  ) {}

  async readWindowState(input: {
    provider: string;
    codexHome: string;
    target: RunnerHandle;
    timeoutMs: number;
  }): Promise<WindowRead> {
    const command = buildCodexbarUsageCommand({
      provider: input.provider,
      codexHome: input.codexHome,
    });
    const result = await this.ssh.run(input.target, { command, timeoutMs: input.timeoutMs });
    const transport = transportFailure(result, "codexbar", input.provider);
    if (transport !== null) {
      this.note(noteFor(transport));
      return { failed: transport };
    }
    // Clean exit: hand stdout to the discriminated parser — malformed NON-empty
    // output is a loud read failure, not a silent "no window data".
    const parsed = parseCodexbarUsageResult(result.stdout, input.provider);
    if ("failed" in parsed) {
      const failure: UsageReadFailure = {
        tool: "codexbar",
        target: input.provider,
        reason: "malformed_output",
        exitCode: result.exitCode,
        detail: parsed.failed.detail,
      };
      this.note(noteFor(failure));
      return { failed: failure };
    }
    return { ok: parsed.ok };
  }
}

// SshCcusageAccountant runs `ccusage <cli> --json` in the runner over SSH
// against the per-run materialized CODEX_HOME.
export class SshCcusageAccountant implements UsageAccountant {
  constructor(
    private readonly ssh: CommandSubstrate,
    private readonly note: UsageNote = defaultNote,
  ) {}

  async readAccounting(input: {
    cli: string;
    codexHome: string;
    target: RunnerHandle;
    timeoutMs: number;
  }): Promise<AccountingRead> {
    const command = buildCcusageCommand({ cli: input.cli, codexHome: input.codexHome });
    const result = await this.ssh.run(input.target, { command, timeoutMs: input.timeoutMs });
    const transport = transportFailure(result, "ccusage", input.cli);
    if (transport !== null) {
      this.note(noteFor(transport));
      return { failed: transport };
    }
    // Clean exit: malformed NON-empty ccusage output is a loud read failure (the
    // strict parser discriminates it from a legitimate empty report).
    const parsed = parseCcusageAccounting(result.stdout, input.cli);
    if ("failed" in parsed) {
      const failure: UsageReadFailure = {
        tool: "ccusage",
        target: input.cli,
        reason: "malformed_output",
        exitCode: result.exitCode,
        detail: parsed.failed.detail,
      };
      this.note(noteFor(failure));
      return { failed: failure };
    }
    return { ok: parsed.ok };
  }
}

// The one concrete {@link UsageMeter} today: it bundles the SSH-backed window
// monitor + ccusage accountant (both over the command substrate) with the run's
// CostResolver into the single named metering seam. It does not change any read —
// it NAMES the three reads as one slottable meter so a future native-metering
// backend can replace all three at once.
export class SshUsageMeter implements UsageMeter {
  readonly monitor: UsageMonitor;
  readonly accountant: UsageAccountant;
  constructor(
    ssh: CommandSubstrate,
    readonly costResolver: CostResolver,
    note?: UsageNote,
  ) {
    this.monitor = new SshCodexbarUsageMonitor(ssh, note);
    this.accountant = new SshCcusageAccountant(ssh, note);
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
    "--format json",
  ].join(" ");
}

// `CODEX_HOME=<q> ccusage <cli> --json`
export function buildCcusageCommand(input: { cli: string; codexHome: string }): string {
  return [`CODEX_HOME=${quoteSshShellArg(input.codexHome)}`, "ccusage", quoteSshShellArg(input.cli), "--json"].join(
    " ",
  );
}

// A non-zero exit, a timeout, or an SSH transport failure is a LOUD read failure
// ({@link UsageReadFailure}) — NEVER silent "no data". A clean exit returns null
// (hand stdout to the parser, which itself discriminates empty from malformed).
function transportFailure(
  result: CommandResult,
  tool: UsageReadFailure["tool"],
  target: string,
): UsageReadFailure | null {
  if (result.timedOut) {
    return { tool, target, reason: "timeout", exitCode: result.exitCode, detail: stderrTail(result.stderr) };
  }
  if (result.failure !== undefined) {
    return { tool, target, reason: "ssh_failure", exitCode: result.exitCode, detail: failureDetail(result.failure) };
  }
  if (result.exitCode !== 0) {
    return { tool, target, reason: "nonzero_exit", exitCode: result.exitCode, detail: stderrTail(result.stderr) };
  }
  return null;
}

// The operator-facing note for a read failure — names the tool, target, and
// failure class so it is distinguishable from a genuine absence of data.
function noteFor(failure: UsageReadFailure): string {
  const exit = failure.exitCode === null ? "unknown" : String(failure.exitCode);
  return `${failure.tool} read failed for ${failure.target} (${failure.reason}, exit ${exit}); recording usage.read_failed (NOT no-data)`;
}

// A secret-free, bounded, whitespace-collapsed stderr tail for the diagnostic.
function stderrTail(stderr: string): string {
  return stderr.slice(-500).replaceAll(/\s+/gu, " ").trim();
}

// The human-readable detail of a transport {@link Failure}. Every variant carries
// a `message` EXCEPT `cancelled` (a `reason`); narrow to keep the detail honest.
function failureDetail(failure: Failure): string {
  return failure.kind === "cancelled" ? failure.reason : failure.message;
}
