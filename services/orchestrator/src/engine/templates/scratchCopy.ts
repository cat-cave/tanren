// SCRATCH-COPY lifecycle for the negative-control pass. A negative control MUTATES the
// tree (plants a defect), so it must NEVER run over the real template workspace —
// otherwise a planted type error could leak into a published template, or a crashed
// run could leave the template dirty. Instead each control runs over a fresh COPY of
// the template under a scratch dir, and the copy is ALWAYS removed afterward (even on
// failure). All operations go over the same `CommandSubstrate` the gate runner uses —
// no new transport.
//
// The copy is a plain `cp -a` of the bootstrapped workspace (so installed deps /
// `node_modules` come along — re-bootstrapping per control would be slow and could
// itself fail for reasons unrelated to the planted defect). The defect files are then
// written into the copy with `mkdir -p` + a heredoc-free `printf` so arbitrary content
// (including quotes) round-trips safely.

import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { outputOnlyWatchdog } from "../ssh/activityWatchdog.js";
import type { InjectedDefectFile } from "./negativeControls.js";

// A scratch copy could not be created / written / removed. LOUD by doctrine: a control
// that cannot establish its isolated copy is an error, never a silent skip that lets a
// gate "pass" untested.
export class ScratchCopyError extends Error {
  constructor(detail: string) {
    super(`template negative-control scratch copy failed: ${detail}`);
    this.name = "ScratchCopyError";
  }
}

export interface ScratchCopyDeps {
  ssh: CommandSubstrate;
  target: RunnerHandle;
}

// Make a fresh copy of `sourcePath` at `scratchPath` (parent created). The scratch
// path is caller-chosen (the harness derives a per-control path under the workspace's
// own scratch root so it is reaper-protected + torn down with the run). Throws
// ScratchCopyError on any failure.
export async function createScratchCopy(deps: ScratchCopyDeps, sourcePath: string, scratchPath: string): Promise<void> {
  const src = quoteSshShellArg(sourcePath);
  const dst = quoteSshShellArg(scratchPath);
  const parent = quoteSshShellArg(parentDir(scratchPath));
  // rm any stale copy first (idempotent), then cp -a the whole tree.
  const command = `rm -rf ${dst} && mkdir -p ${parent} && cp -a ${src} ${dst}`;
  const result = await deps.ssh.run(deps.target, { command, watchdog: outputOnlyWatchdog() });
  assertOk(result, `creating scratch copy at ${scratchPath}`);
}

// Write the planted-defect files into the scratch copy. Each file's parent dir is
// created; content is delivered via base64 to a `base64 -d` so any bytes (quotes,
// backticks, newlines) round-trip with no shell-escaping hazard. Throws on failure.
export async function writeDefectFiles(
  deps: ScratchCopyDeps,
  scratchPath: string,
  files: ReadonlyArray<InjectedDefectFile>,
): Promise<void> {
  for (const file of files) {
    const abs = joinPath(scratchPath, file.path);
    const dir = quoteSshShellArg(parentDir(abs));
    const dest = quoteSshShellArg(abs);
    const b64 = Buffer.from(file.content, "utf8").toString("base64");
    const command = `mkdir -p ${dir} && printf %s ${quoteSshShellArg(b64)} | base64 -d > ${dest}`;
    const result = await deps.ssh.run(deps.target, { command, watchdog: outputOnlyWatchdog() });
    assertOk(result, `writing defect file ${file.path}`);
  }
}

// Remove the scratch copy. Best-effort by design: a failed teardown must not mask the
// control's verdict, but it IS surfaced (returned) so the caller can narrate a leak.
// Never throws.
export async function removeScratchCopy(deps: ScratchCopyDeps, scratchPath: string): Promise<{ removed: boolean }> {
  const result = await deps.ssh.run(deps.target, {
    command: `rm -rf ${quoteSshShellArg(scratchPath)}`,
    watchdog: outputOnlyWatchdog(),
  });
  return { removed: result.failure === undefined && result.stalled !== true && result.exitCode === 0 };
}

function assertOk(
  result: { exitCode: number | null; stalled?: boolean; stderr: string; failure?: unknown },
  doing: string,
): void {
  if (result.failure !== undefined) {
    throw new ScratchCopyError(`${doing}: substrate failure`);
  }
  if (result.stalled === true) {
    throw new ScratchCopyError(`${doing}: stalled (no sign of life)`);
  }
  if (result.exitCode !== 0) {
    throw new ScratchCopyError(`${doing}: nonzero exit ${String(result.exitCode)} ${result.stderr.trim()}`.trim());
  }
}

function parentDir(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

function joinPath(base: string, rel: string): string {
  return `${base.replace(/\/+$/u, "")}/${rel.replace(/^\/+/u, "")}`;
}
