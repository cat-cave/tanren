import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { progressCycleReached } from "./stack-progress.js";

export interface CommandEvidence {
  command: string;
  args: readonly string[];
  cwd: string;
  pgid?: number;
}

export interface CommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  capture?: boolean;
  quiet?: boolean;
  signal?: AbortSignal;
  onSpawn?: (evidence: CommandEvidence) => void;
  onGroup?: (pgid: number, state: "started" | "exited") => void;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

/** True when kill(pgid, 0) / kill(-pgid, 0) reports ESRCH. */
export function processGroupAbsent(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    try {
      process.kill(pgid, signal);
    } catch {
      // Already gone.
    }
    return;
  }
  try {
    process.kill(-pgid, signal);
  } catch {
    // Exact group may already have exited.
  }
}

/**
 * Bounded TERM → KILL fence for one process group. After the leader exits (or is
 * signalled), prove the negative PGID is ESRCH; escalate only while members remain.
 */
export async function fenceProcessGroup(pgid: number, signal?: AbortSignal): Promise<void> {
  if (processGroupAbsent(pgid)) return;
  signalProcessGroup(pgid, "SIGTERM");
  if (!signal?.aborted) await delay(25);
  if (processGroupAbsent(pgid)) return;
  signalProcessGroup(pgid, "SIGKILL");
  const signatures: string[] = [];
  for (;;) {
    await delay(25);
    if (processGroupAbsent(pgid)) return;
    signatures.push(`pgid:${pgid}:present-after-kill`);
    if (progressCycleReached(signatures)) {
      throw new Error(`process group ${pgid} survived TERM/KILL convergence fence`);
    }
  }
}

/** Track every owned PGID and fence survivors after leaders exit. */
export class ProcessGroupRegistry {
  private readonly groups = new Set<number>();

  record(pgid: number, state: "started" | "exited"): void {
    if (state === "started") this.groups.add(pgid);
    else this.groups.delete(pgid);
  }

  active(): number[] {
    return [...this.groups];
  }

  async fenceAll(signal?: AbortSignal): Promise<void> {
    const remaining: number[] = [];
    const tracked = Array.from(this.groups);
    for (const pgid of tracked) {
      try {
        await fenceProcessGroup(pgid, signal);
        this.groups.delete(pgid);
      } catch {
        if (processGroupAbsent(pgid)) this.groups.delete(pgid);
        else remaining.push(pgid);
      }
    }
    for (const pgid of remaining) {
      if (processGroupAbsent(pgid)) this.groups.delete(pgid);
      else {
        throw new Error(
          `cleanup leaked process groups: ${remaining.filter((id) => !processGroupAbsent(id)).join(",")}`,
        );
      }
    }
    const survivors = this.active().filter((pgid) => !processGroupAbsent(pgid));
    if (survivors.length > 0) throw new Error(`cleanup leaked process groups: ${survivors.join(",")}`);
    this.groups.clear();
  }

  assertEmpty(): void {
    const survivors = this.active().filter((pgid) => !processGroupAbsent(pgid));
    if (survivors.length > 0) throw new Error(`cleanup leaked process groups: ${survivors.join(",")}`);
  }
}

export function runCommand(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  const evidence: CommandEvidence = { command, args: [...args], cwd: options.cwd };
  options.onSpawn?.(evidence);
  if (!options.quiet) process.stdout.write(`$ ${command} ${args.join(" ")}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env,
      shell: false,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let termination: { kind: "abort"; done: Promise<void> } | undefined;
    const pgid = child.pid;
    if (pgid !== undefined) {
      evidence.pgid = pgid;
      options.onGroup?.(pgid, "started");
    }
    const terminate = () => {
      if (termination !== undefined || pgid === undefined) return;
      termination = {
        kind: "abort",
        done: fenceProcessGroup(pgid, options.signal).catch(() => {
          // Fence failure is reported via survivor checks after close.
        }),
      };
    };
    const onAbort = () => terminate();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) terminate();
    const release = () => options.signal?.removeEventListener("abort", onAbort);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const finish = async (handler: () => void) => {
      if (settled) return;
      settled = true;
      release();
      await termination?.done;
      if (pgid !== undefined) {
        if (!processGroupAbsent(pgid)) {
          try {
            await fenceProcessGroup(pgid);
          } catch {
            // Surfaced below if the group still lives.
          }
        }
        if (!processGroupAbsent(pgid)) {
          reject(new Error(`process group ${pgid} survived after leader exit`));
          return;
        }
        // Negative PGID must return ESRCH after leader+fence.
        if (!processGroupAbsent(pgid)) {
          reject(new Error(`kill(-${pgid}) did not return ESRCH after fence`));
          return;
        }
        options.onGroup?.(pgid, "exited");
      }
      handler();
    };
    child.once("error", (error) => {
      void finish(() => reject(error));
    });
    child.once("close", (code, signalName) => {
      void finish(() => {
        const result = {
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        };
        if (termination?.kind === "abort") {
          reject(new Error(`${command} ${args.join(" ")} aborted: ${String(options.signal?.reason)}`));
        } else if (code === 0) resolve(result);
        else {
          const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
          reject(new Error(`${command} ${args.join(" ")} failed (${signalName ?? String(code)}): ${detail}`));
        }
      });
    });
  });
}
