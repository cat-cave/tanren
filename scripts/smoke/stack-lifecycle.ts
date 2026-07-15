import { createHash } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sanitizeAmbientEnvironment, probeBindings, type StackContext } from "./stack-context.js";
import { isSmokeStage, type SmokeStage } from "./stack-gates.js";
import { ProcessGroupRegistry } from "./stack-process.js";
import { assertProbeBindings } from "./stack-provenance.js";
import { runCommand, type CommandEvidence, type HttpEvidence, type RuntimeBinding } from "./stack-runtime.js";

export { assertArtifactPathSafe, validateSmokePaths } from "./stack-paths.js";

// cspell:ignore opsu

export interface CandidateIdentity {
  root: string;
  head: string;
  tree: string;
  porcelain: string;
  env: NodeJS.ProcessEnv;
}

export async function readCandidateIdentity(
  cwd: string,
  ambient: NodeJS.ProcessEnv,
  groups?: ProcessGroupRegistry,
  signal?: AbortSignal,
): Promise<CandidateIdentity> {
  const env = sanitizeAmbientEnvironment(ambient);
  const invoke = async (root: string, args: string[]) =>
    (
      await runCommand("git", ["-C", root, ...args], {
        cwd,
        env,
        capture: true,
        quiet: true,
        signal,
        onGroup: groups === undefined ? undefined : (pgid, state) => groups.record(pgid, state),
      })
    ).stdout.trim();
  const root = await invoke(cwd, ["rev-parse", "--show-toplevel"]);
  const head = await invoke(root, ["rev-parse", "HEAD^{commit}"]);
  const [tree, porcelain, finalHead] = await Promise.all([
    invoke(root, ["rev-parse", `${head}^{tree}`]),
    invoke(root, ["status", "--porcelain", "--untracked-files=all"]),
    invoke(root, ["rev-parse", "HEAD^{commit}"]),
  ]);
  if (finalHead !== head) throw new Error(`candidate HEAD moved during identity capture: ${head} -> ${finalHead}`);
  return { root, head, tree, porcelain, env };
}

export interface StageEvidence {
  name: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "passed" | "failed" | "aborted" | "skipped";
  command?: { executable: string; args: string[] };
  error?: string;
}

/**
 * Distinct typed evidence for the bootstrap dependency install. The install
 * runs BEFORE any of the 56 production stages exist (it prepares the clean
 * source the coordinator imports), so it cannot borrow the stage-scoped
 * `recordCommand`/active-stage path. This ledger entry survives into
 * `PreparedSmokeRun` and the final/partial receipt as `bootstrap.install`,
 * outside the production-stage list. Never records env/secrets — only sanitized
 * executable/argv/cwd, the owned process-group start+exit, and terminal status.
 */
export interface BootstrapInstallEvidence {
  command: { executable: string; args: string[]; cwd: string };
  startedAt: string;
  finishedAt?: string;
  pgid?: number;
  groupStarted: boolean;
  groupExited: boolean;
  status: "running" | "passed" | "failed";
  error?: string;
}

export type TerminalCommitPhase = "open" | "preparing" | "committed";

export class LifecycleLedger {
  readonly abortController: AbortController;
  readonly stages: StageEvidence[] = [];
  readonly processGroups = new ProcessGroupRegistry();
  private active: StageEvidence | undefined;
  private injectedFailure: SmokeStage | undefined;
  private readonly requestedFailure: string | undefined;
  private failureConfigurationValidated = false;
  private injectedFailureObserved = false;
  private terminalPhase: TerminalCommitPhase = "open";
  private committedReceipt: string | undefined;
  private committedExitCode: number | undefined;
  private bootstrapInstall: BootstrapInstallEvidence | undefined;

  constructor(injectedFailure?: string, abortController = new AbortController()) {
    this.abortController = abortController;
    this.requestedFailure = injectedFailure === "" ? undefined : injectedFailure;
  }

  private validateFailureConfiguration(): void {
    if (this.failureConfigurationValidated) return;
    this.failureConfigurationValidated = true;
    if (this.requestedFailure !== undefined && !isSmokeStage(this.requestedFailure)) {
      throw new Error(`unknown smoke failure stage ${JSON.stringify(this.requestedFailure)}`);
    }
    this.injectedFailure = this.requestedFailure;
  }

  async run<T>(
    name: SmokeStage,
    operation: () => T | Promise<T>,
    options: { allowWhenAborted?: boolean } = {},
  ): Promise<T> {
    if (this.terminalPhase === "committed") throw new Error("lifecycle already terminal-committed");
    if (this.active !== undefined) throw new Error(`lifecycle stage ${this.active.name} is still active`);
    const stage: StageEvidence = { name, startedAt: new Date().toISOString(), status: "running" };
    this.active = stage;
    this.stages.push(stage);
    try {
      if (this.abortController.signal.aborted && !options.allowWhenAborted) {
        throw this.abortController.signal.reason;
      }
      this.validateFailureConfiguration();
      if (this.injectedFailure === name) {
        this.injectedFailureObserved = true;
        throw new Error(`injected smoke failure at ${name}`);
      }
      const result = await operation();
      if (stage.status === "running") stage.status = "passed";
      return result;
    } catch (error) {
      stage.status = this.abortController.signal.aborted && !options.allowWhenAborted ? "aborted" : "failed";
      stage.error = safeError(error);
      throw error;
    } finally {
      stage.finishedAt = new Date().toISOString();
      this.active = undefined;
    }
  }

  recordCommand(evidence: CommandEvidence): void {
    if (this.active === undefined) return;
    this.active.command = { executable: evidence.command, args: redactArgs(evidence.args) };
  }

  recordGroup(pgid: number, state: "started" | "exited"): void {
    this.processGroups.record(pgid, state);
  }

  beginBootstrapInstall(command: { executable: string; args: string[]; cwd: string }): void {
    this.bootstrapInstall = {
      command: { executable: command.executable, args: redactArgs(command.args), cwd: command.cwd },
      startedAt: new Date().toISOString(),
      groupStarted: false,
      groupExited: false,
      status: "running",
    };
  }

  recordBootstrapInstallSpawn(evidence: CommandEvidence): void {
    if (this.bootstrapInstall === undefined) return;
    this.bootstrapInstall.command = {
      executable: evidence.command,
      args: redactArgs(evidence.args),
      cwd: evidence.cwd,
    };
    if (evidence.pgid !== undefined) this.bootstrapInstall.pgid = evidence.pgid;
  }

  recordBootstrapInstallGroup(pgid: number, state: "started" | "exited"): void {
    this.processGroups.record(pgid, state);
    if (this.bootstrapInstall === undefined) return;
    if (state === "started") {
      this.bootstrapInstall.pgid = pgid;
      this.bootstrapInstall.groupStarted = true;
    } else {
      this.bootstrapInstall.groupExited = true;
    }
  }

  completeBootstrapInstall(status: "passed" | "failed", error?: unknown): void {
    if (this.bootstrapInstall === undefined) return;
    this.bootstrapInstall.status = status;
    this.bootstrapInstall.finishedAt = new Date().toISOString();
    if (error !== undefined) this.bootstrapInstall.error = safeError(error);
  }

  bootstrapInstallEvidence(): BootstrapInstallEvidence | undefined {
    return this.bootstrapInstall;
  }

  completeActiveForReceipt(status: "passed" | "failed", error?: unknown): void {
    if (this.active === undefined) return;
    this.active.status = status;
    this.active.finishedAt = new Date().toISOString();
    if (error !== undefined) this.active.error = safeError(error);
  }

  activeGroups(): number[] {
    return this.processGroups.active();
  }

  abort(signal: string): void {
    if (!this.abortController.signal.aborted) this.abortController.abort(new Error(`smoke interrupted by ${signal}`));
  }

  assertFailureInjectionObserved(pending?: SmokeStage): void {
    this.validateFailureConfiguration();
    if (this.injectedFailure !== undefined && this.injectedFailure !== pending && !this.injectedFailureObserved) {
      throw new Error(`requested smoke failure stage ${this.injectedFailure} was not executed`);
    }
  }

  beginTerminalPrepare(): void {
    if (this.terminalPhase === "committed") throw new Error("terminal receipt already committed");
    this.terminalPhase = "preparing";
  }

  commitTerminal(receiptJson: string, exitCode: number): void {
    if (this.terminalPhase === "committed") {
      if (this.committedReceipt !== receiptJson || this.committedExitCode !== exitCode) {
        throw new Error("terminal commit contradiction: receipt/exit already sealed with different values");
      }
      return;
    }
    if (this.terminalPhase !== "preparing") throw new Error("terminal commit requires a prepared receipt");
    this.terminalPhase = "committed";
    this.committedReceipt = receiptJson;
    this.committedExitCode = exitCode;
  }

  terminalState(): { phase: TerminalCommitPhase; receipt?: string; exitCode?: number } {
    return {
      phase: this.terminalPhase,
      ...(this.committedReceipt === undefined ? {} : { receipt: this.committedReceipt }),
      ...(this.committedExitCode === undefined ? {} : { exitCode: this.committedExitCode }),
    };
  }
}

export class OnceFinalizer {
  private result: Promise<void> | undefined;
  runs = 0;

  run(operation: () => void | Promise<void>): Promise<void> {
    this.result ??= (async () => {
      this.runs += 1;
      await operation();
    })();
    return this.result;
  }
}

function redactSensitiveText(raw: string): string {
  return raw
    .replaceAll(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/gu, "<redacted-private-key>")
    .replaceAll(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+@/giu, "$1<redacted>@")
    .replaceAll(/(bearer\s+|token[=:]\s*|password[=:]\s*|secret[=:]\s*|key[=:]\s*)[^\s]+/giu, "$1<redacted>")
    .replaceAll(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[opsu]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/gu,
      "<redacted-credential>",
    );
}

function redactArgs(args: readonly string[]): string[] {
  return args.map((arg) => redactSensitiveText(arg));
}

export function safeError(error: unknown): string {
  return redactSensitiveText(String(error instanceof Error ? error.message : error)).slice(0, 8_192);
}

export async function allocateRuntimeRoot(runtimeDir: string): Promise<void> {
  await mkdir(dirname(runtimeDir), { recursive: true, mode: 0o700 });
  await mkdir(runtimeDir, { recursive: false, mode: 0o700 });
}

export async function fingerprintFile(path: string): Promise<string> {
  return `SHA256:${createHash("sha256")
    .update(await readFile(path))
    .digest("base64url")}`;
}

export function fingerprintText(value: string): string {
  return `SHA256:${createHash("sha256").update(value).digest("base64url")}`;
}

export class ExecutedBindings {
  private readonly targets = new Map<string, string>();

  record(name: string, target: string): void {
    const previous = this.targets.get(name);
    if (previous !== undefined && previous !== target) {
      throw new Error(`${name} execution target changed from ${previous} to ${target}`);
    }
    this.targets.set(name, target);
  }

  recordHttp(name: string, evidence: HttpEvidence): void {
    this.record(name, evidence.finalUrl);
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.targets);
  }

  assertComplete(context: StackContext): void {
    assertProbeBindings(context, this.snapshot());
  }

  expected(context: StackContext): Record<string, string> {
    return probeBindings(context);
  }
}

export interface RuntimeIdentity {
  provider: RuntimeBinding["provider"];
  executable: string;
  socket: string;
  clientVersion: string;
  serverVersion: string;
  serverIdentity: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function firstString(records: Record<string, unknown>[], names: string[]): string {
  for (const record of records) {
    for (const name of names)
      if (typeof record[name] === "string" && record[name] !== "") return record[name] as string;
  }
  return "unknown";
}

export async function inspectRuntimeIdentity(
  runtime: RuntimeBinding,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  onSpawn: (evidence: CommandEvidence) => void,
  onGroup?: (pgid: number, state: "started" | "exited") => void,
): Promise<RuntimeIdentity> {
  const options = { cwd, env, signal, capture: true, quiet: true, onSpawn, onGroup };
  const [versionResult, infoResult] = await Promise.all([
    runCommand(runtime.executable, ["version", "--format", "json"], options),
    runCommand(runtime.executable, ["info", "--format", "json"], options),
  ]);
  let version: Record<string, unknown>;
  try {
    version = asRecord(JSON.parse(versionResult.stdout) as unknown);
  } catch {
    throw new Error(`${runtime.provider} version did not return JSON`);
  }
  const client = asRecord(version["Client"] ?? version["client"]);
  const server = asRecord(version["Server"] ?? version["server"]);
  return {
    provider: runtime.provider,
    executable: runtime.executable,
    socket: runtime.socket,
    clientVersion: firstString([client, version], ["Version", "version"]),
    serverVersion: firstString([server, version], ["Version", "version"]),
    serverIdentity: createHash("sha256").update(infoResult.stdout.trim()).digest("hex"),
  };
}

export function sanitizeComposeLogs(raw: string): string {
  return redactSensitiveText(raw).slice(-128_000);
}

export function decodeTerminalCliStatus(stdout: string, expectedRunId: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("CLI status did not emit one JSON document");
  }
  const root = asRecord(payload);
  const run = asRecord(root["run"]);
  if (run["run_id"] !== expectedRunId) {
    throw new Error(`CLI status returned run ${String(run["run_id"])}, expected ${expectedRunId}`);
  }
  const status = run["status"];
  if (typeof status !== "string" || !new Set(["halted", "completed", "failed", "cancelled"]).has(status)) {
    throw new Error(`CLI status for ${expectedRunId} was not terminal: ${String(status)}`);
  }
  return status;
}

export async function writeFileAtomic(path: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { mode, flag: "wx" });
  try {
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
