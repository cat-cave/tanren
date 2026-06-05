// The FILE SUBSTRATE seam — the backend-neutral boundary at which the
// orchestrator moves a FILE into (or out of) an allocated runner. It is the file
// sibling of {@link CommandSubstrate}: where the command substrate runs a
// command, the file substrate transfers bytes. Today every file the engine puts
// onto a runner rides over a command heredoc (`cat > path` over the SSH command
// substrate) — workspace seeding and the per-CLI credential materializers all do
// this implicitly. This seam NAMES that operation so a backend with a NATIVE file
// API (Sprites/Daytona workspace writes, a Fly Machines volume put) implements
// `put`/`get`/`writeFile` directly instead of smuggling files through a shell.
//
// The one concrete impl today is {@link CommandFileSubstrate} (engine/ssh/
// commandFileSubstrate.ts) — it satisfies this seam over the command substrate's
// heredoc, so the behavior is byte-for-byte what the materializers/bootstrap did
// inline before. A new backend slots in as a new `FileSubstrate` impl, NOT a
// refactor of the callers.
import type { Failure } from "../failure.js";
import type { RunnerHandle } from "./allocator.js";

// One file to write into a runner. `content` is the exact bytes (UTF-8 string);
// `mode` is the octal POSIX permission (e.g. 0o600 for a secret) the substrate
// must apply atomically with the write — a secret file is never momentarily
// world-readable. The content is never logged by the substrate.
export interface FileWrite {
  path: string;
  content: string;
  // Octal POSIX mode (default 0o600 — files this seam writes are usually secrets).
  mode?: number;
  timeoutMs: number;
}

// The outcome of a file transfer. Like {@link CommandResult}, a transport failure
// is reported IN-BAND via `failure` rather than thrown, so callers branch on the
// result shape uniformly across backends.
export interface FileTransferResult {
  ok: boolean;
  failure?: Failure;
}

// A file read out of a runner.
export interface FileRead {
  path: string;
  timeoutMs: number;
}

export interface FileReadResult {
  ok: boolean;
  // The file's bytes (UTF-8) when `ok`; undefined on failure.
  content?: string;
  failure?: Failure;
}

// THE seam. `writeFile` is the primary operation (credential materialization +
// workspace seeding); `put`/`get` are the byte-stream forms a native backend can
// implement more directly. SSH backs all three through one heredoc impl today.
export interface FileSubstrate {
  // Write `content` to `file.path` in the runner, applying `mode` atomically.
  writeFile(handle: RunnerHandle, file: FileWrite): Promise<FileTransferResult>;
  // Put raw bytes at a path (alias of writeFile for the stream-oriented caller).
  put(handle: RunnerHandle, file: FileWrite): Promise<FileTransferResult>;
  // Read a file's bytes back out of the runner.
  get(handle: RunnerHandle, file: FileRead): Promise<FileReadResult>;
}

// A no-op FileSubstrate for unit paths that don't assert on file contents. TEST
// FIXTURE ONLY — never the live path.
export class FakeFileSubstrate implements FileSubstrate {
  async writeFile(_handle: RunnerHandle, _file: FileWrite): Promise<FileTransferResult> {
    return { ok: true };
  }
  async put(_handle: RunnerHandle, file: FileWrite): Promise<FileTransferResult> {
    return this.writeFile(_handle, file);
  }
  async get(_handle: RunnerHandle, _file: FileRead): Promise<FileReadResult> {
    return { ok: true, content: "" };
  }
}
