// The one concrete {@link FileSubstrate} today: file transfer OVER the command
// substrate. Every file the engine puts onto a runner has always ridden a command
// heredoc (`cat > path` with the bytes fed on stdin); this impl is that operation,
// named. It composes a {@link CommandSubstrate} — so on SSH it is the same
// `cat`-over-ssh transfer the credential materializers / workspace bootstrap did
// inline, byte-for-byte. A backend with a native file API implements FileSubstrate
// directly instead of going through this composition.
//
// Secrets: `content` is fed on STDIN, never interpolated into the command string,
// so a file's bytes never reach a log or an event payload. The mode is applied in
// the SAME command (`umask` + `chmod`) so a secret file is never momentarily
// world-readable.
import type {
  FileRead,
  FileReadResult,
  FileSubstrate,
  FileTransferResult,
  FileWrite,
} from "../contracts/fileSubstrate.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { RunnerHandle } from "../contracts/allocator.js";
import { defineFailure } from "../failure.js";
import { quoteSshShellArg } from "./command.js";
import { outputOnlyWatchdog } from "./activityWatchdog.js";

const DEFAULT_MODE = 0o600;

export class CommandFileSubstrate implements FileSubstrate {
  constructor(private readonly commands: CommandSubstrate) {}

  async writeFile(handle: RunnerHandle, file: FileWrite): Promise<FileTransferResult> {
    const mode = file.mode ?? DEFAULT_MODE;
    const quotedPath = quoteSshShellArg(file.path);
    const quotedDir = quoteSshShellArg(parentDir(file.path));
    const octal = mode.toString(8).padStart(3, "0");
    // `umask 077` then `mkdir -p` the parent, write via heredoc-on-stdin, then
    // chmod to the requested mode — all in one command so the file is never
    // momentarily group/world-readable. The content rides stdin, never the cmd.
    const command = ["umask 077", `mkdir -p ${quotedDir}`, `cat > ${quotedPath}`, `chmod ${octal} ${quotedPath}`].join(
      " && ",
    );
    const result = await this.commands.run(handle, {
      command,
      stdin: file.content,
      // INFRA file write (a chmod-600 heredoc): output-driven only. No wall-clock
      // kill — a genuine silent death surfaces a recoverable stall.
      watchdog: outputOnlyWatchdog(),
    });
    if (result.failure !== undefined) {
      return { ok: false, failure: result.failure };
    }
    if (result.exitCode !== 0) {
      return {
        ok: false,
        failure: defineFailure({
          kind: "ssh_failed",
          target: file.path,
          message: `file write failed with exit code ${result.exitCode ?? "unknown"}`,
        }),
      };
    }
    return { ok: true };
  }

  // `put` is the stream-oriented alias of writeFile — same transfer.
  async put(handle: RunnerHandle, file: FileWrite): Promise<FileTransferResult> {
    return this.writeFile(handle, file);
  }

  async get(handle: RunnerHandle, file: FileRead): Promise<FileReadResult> {
    const result = await this.commands.run(handle, {
      command: `cat ${quoteSshShellArg(file.path)}`,
      // INFRA file read: output-driven only; a silent death surfaces a stall.
      watchdog: outputOnlyWatchdog(),
    });
    if (result.failure !== undefined) {
      return { ok: false, failure: result.failure };
    }
    if (result.exitCode !== 0) {
      return {
        ok: false,
        failure: defineFailure({
          kind: "ssh_failed",
          target: file.path,
          message: `file read failed with exit code ${result.exitCode ?? "unknown"}`,
        }),
      };
    }
    return { ok: true, content: result.stdout };
  }
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) {
    return idx === 0 ? "/" : ".";
  }
  return path.slice(0, idx);
}
