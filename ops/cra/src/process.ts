import { spawn } from "node:child_process";

export interface CommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly timeoutMs?: number;
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type CommandExecutor = (request: CommandRequest) => Promise<CommandResult>;

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export const execute: CommandExecutor = async (request) =>
  await new Promise((resolve, reject) => {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: request.env ?? process.env,
      stdio: "pipe",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (typeof request.timeoutMs === "number") {
      timer = setTimeout(() => {
        // arch-allow: timeout-class CRA-04 requires a hard wall-clock ceiling for untrusted PR commands.
        timedOut = true;
        child.kill("SIGKILL");
      }, request.timeoutMs);
    }

    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer !== undefined) clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`command timed out after ${request.timeoutMs}ms: ${request.command}`));
        return;
      }
      if (outputBytes > MAX_OUTPUT_BYTES) {
        reject(new Error(`command exceeded ${MAX_OUTPUT_BYTES} output bytes: ${request.command}`));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
    if (request.input === undefined) child.stdin.end();
    else child.stdin.end(request.input);
  });

export async function executeChecked(executor: CommandExecutor, request: CommandRequest): Promise<CommandResult> {
  const result = await executor(request);
  if (result.exitCode === 0) return result;
  throw new Error(
    `${request.command} exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim() || "no output"}`,
  );
}
