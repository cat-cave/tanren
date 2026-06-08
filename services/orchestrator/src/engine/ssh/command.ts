import type { RunnerCommand } from "../contracts/commandSubstrate.js";

export function quoteSshShellArg(value: string): string {
  if (value.includes("\0")) {
    throw new Error("ssh command argument contains a null byte");
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// The per-workspace scratch dir, RELATIVE to the command's cwd (the run's repo
// tree). Every cwd-scoped command runs with `TMPDIR` pointed here.
//
// WHY (the root-cause fix for the scaffold vitest failure v23 + v24 both hit):
// vitest derives its per-project SSR transform dir as `join(os.tmpdir(), nanoid())`
// — HARDCODED to `os.tmpdir()`, NOT influenced by any `cacheDir` / `vitest.config.ts`
// setting (verified against vitest 3.2.4's cli-api chunk). It then `mkdirSync(<that>/
// ssr)` and writes transformed modules there. On the shared runner that path is
// `/tmp`, which is shared across concurrent runs and can be swept out from under a
// live run — producing the auditor's "unhandled ENOENT while creating a temp `ssr`
// directory". pnpm's tempy-based temp resolution ENOENTs the same way when `/tmp`
// churns. The ONLY lever for vitest's `tmpDir` is the `TMPDIR` env var, so we point
// it at a dir INSIDE the run's own workspace: writable (tanren-owned), run-scoped
// (no cross-run `/tmp` collision), reaper-protected (an active run's tree is never
// reaped), and torn down cleanly with the run dir. This is the deterministic,
// non-`/tmp` scratch path the whole toolchain (vitest SSR, v8-compile-cache, pnpm)
// needs.
//
// It lives under `.git/` so a `git add -A` (the bootstrap/writer commit) never stages
// it — `.git/` is inherently untracked — without depending on a `.gitignore`/exclude
// entry being present.
export const WORKSPACE_TMPDIR_REL_PATH = ".git/tanren-tmp";

// Prefix that makes a cwd-scoped command run with a workspace-local `TMPDIR`. The
// `mkdir -p` is inline (idempotent, cheap) so the dir always exists before the
// command's tooling resolves `os.tmpdir()`. Emitted ONLY when a cwd is present:
// a cwd-less command (a reaper `find`, a host probe) has no workspace to anchor to
// and keeps the OS default.
function workspaceTmpdirPrefix(): string {
  return `export TMPDIR="$PWD/${WORKSPACE_TMPDIR_REL_PATH}"; mkdir -p "$TMPDIR"; `;
}

export function buildSshExecCommand(command: RunnerCommand): string {
  if (command.cwd === undefined || command.cwd === "") {
    return command.command;
  }
  return `cd ${quoteSshShellArg(command.cwd)} && ${workspaceTmpdirPrefix()}${command.command}`;
}
