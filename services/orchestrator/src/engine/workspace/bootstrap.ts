// P3-0006: per-repo workspace bootstrap. Runs clone the target repo into a
// runner workspace but never install its dependencies, so the cloned tree
// cannot build or test — the live acceptance-medium evidence showed the
// checker hitting `vitest: not found`. This step runs the project's install
// command over SSH in the workspace dir immediately after a successful clone
// and BEFORE the first writer iteration, so gating + intent-checking operate
// on a built tree.
import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandResult, CommandSubstrate } from "../contracts/commandSubstrate.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { withAppEnv } from "../ssh/appEnvPrelude.js";
import { runWorkspaceSshCommand } from "./ssh.js";

// The commit message used for the synthetic post-bootstrap commit. Install
// artifacts (lockfiles, node_modules, etc.) created by the bootstrap step land
// in THIS commit, off the writer's base, so the writer's diff and the pushed PR
// branch carry only the writer's real changes — never bootstrap-generated files.
export const BOOTSTRAP_COMMIT_MESSAGE = "tanren: bootstrap";

// The install command tail surfaced on a bootstrap failure. Output can be
// large; we keep only the last N characters so the typed error and the
// recovery surface carry a useful, bounded diagnostic.
const OUTPUT_TAIL_LIMIT = 4_000;

// Default install command. The branch is chosen runner-side by which manifest
// the repo actually ships: a pnpm lockfile uses pnpm, an npm lockfile uses
// `npm ci`, a bare `package.json` (no lockfile) uses `npm install`, and a repo
// with NO package manifest skips dependency bootstrap entirely (exit 0). The
// old default ran `pnpm install` unconditionally, which failed `exit 127`
// (`pnpm: command not found`) on manifest-less repos — a class the easy fixture
// falls into. npm is always present in the base runner image; pnpm is too.
//
// This is the fallback used only when the repo declares no install command: the
// run path resolves the repo's .tanren/ci.yml `bootstrap.run` (P3-0004's
// bootstrapCommand resolver, via resolveBootstrapCommand) and passes it as
// `command`; when the repo ships no .tanren/ci.yml the resolver yields undefined
// and this heuristic default applies.
// `--config.confirmModulesPurge=false`: the runner is NON-INTERACTIVE (no TTY).
// When pnpm decides it must PURGE an existing `node_modules` (e.g. one the writer
// created with a different layout/store), it interactively confirms the removal by
// default and ABORTS with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` (exit 1)
// when there is no TTY. We must NOT use the alternative (`CI=true`), because that
// also flips pnpm's default to `--frozen-lockfile` — which would defeat the
// non-frozen greenfield deps-ensure below. So we disable the purge prompt directly.
export const DEFAULT_BOOTSTRAP_COMMAND =
  "if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile --config.confirmModulesPurge=false; " +
  "elif [ -f package-lock.json ]; then npm ci; " +
  "elif [ -f package.json ]; then npm install; " +
  "else echo 'tanren: no package manifest found; skipping dependency bootstrap'; fi";

// The deps-ensure default install command — the NON-FROZEN sibling of
// DEFAULT_BOOTSTRAP_COMMAND. It is the default ONLY for the per-gate GREENFIELD
// deps-ensure (the gate callback passes it — by leaving `command` undefined — only
// when `context.greenfield` is true and no explicit `bootstrap.run` is set). A
// BROWNFIELD run's gate passes the FROZEN DEFAULT_BOOTSTRAP_COMMAND instead, so an
// existing committed lockfile is never silently mutated; see buildDefaultGate.
//
// Why non-frozen for greenfield (vs the cold-bootstrap default's
// `--frozen-lockfile`): the deps-ensure path runs AFTER a writer iteration that
// just authored/extended the manifest. A writer that adds a devDep (e.g. `vitest`)
// without perfectly regenerating `pnpm-lock.yaml` produces a manifest⇆lockfile
// mismatch — a `--frozen-lockfile` install would then HARD-FAIL ("lockfile out of
// date") instead of installing the new binary, and the gate would die on
// `vitest: not found`. A non-frozen install reconciles the lockfile and installs
// the binary, so the writer's devDeps are actually present at the gate. pnpm
// itself is the idempotency authority: when the manifest/lockfile already agree
// this is a cheap no-op. An explicit `.tanren/ci.yml` `bootstrap.run` (or an
// `input.bootstrapCommand` override) still wins over this default. pnpm/npm are
// chosen by the SAME manifest probe the cold bootstrap uses (a pnpm
// lockfile/workspace ⇒ pnpm, else npm install).
// `--config.confirmModulesPurge=false`: same non-interactive-runner reason as
// DEFAULT_BOOTSTRAP_COMMAND. This path runs the MOST often (every gate, after each
// writer iteration), so a writer that rewrites the manifest such that pnpm wants to
// purge `node_modules` would otherwise abort with the no-TTY error and fail the run.
export const DEPS_ENSURE_DEFAULT_COMMAND =
  "if [ -f pnpm-lock.yaml ] || [ -f pnpm-workspace.yaml ]; then pnpm install --config.confirmModulesPurge=false; " +
  "elif [ -f package.json ]; then npm install; " +
  "else echo 'tanren: no package manifest found; skipping dependency bootstrap'; fi";

export interface BootstrapWorkspaceInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  // The install command, run in the workspace dir over SSH. Defaults to
  // DEFAULT_BOOTSTRAP_COMMAND when omitted.
  command?: string;
  // Plane B (P-APP-ENV-0): the PROJECT's dev+test app env, materialized into the
  // EXECUTED command's environment ONLY (an `export K='v'; …` prelude built at
  // THIS substrate boundary). It is DELIBERATELY kept off the `command` field —
  // the original command (never the prelude) is what flows into
  // WorkspaceBootstrapError / bootstrapFailureMessage / any log, so a bootstrap
  // failure can never leak an app-secret VALUE into the error message or the
  // `workspace.failed` / `run.failed` event payloads. Distinct from Tanren's own
  // provider creds. Undefined ⇒ no app env (command unchanged).
  appEnv?: Record<string, string>;
  timeoutMs: number;
}

// A typed, observable bootstrap failure. Carries the exit code and a bounded
// tail of the combined install output so the halting run outcome and the
// P2B-0008 recovery surface have a concrete diagnostic to show.
export class WorkspaceBootstrapError extends Error {
  override readonly name = "WorkspaceBootstrapError";

  constructor(
    readonly workspacePath: string,
    readonly command: string,
    readonly exitCode: number | null,
    readonly outputTail: string,
    readonly timedOut: boolean,
  ) {
    super(bootstrapFailureMessage(command, exitCode, outputTail, timedOut));
  }
}

// Installs the target repo's dependencies in the cloned workspace over SSH.
// Returns the raw SSH result on success; throws WorkspaceBootstrapError on a
// nonzero exit, timeout, or substrate failure.
export async function bootstrapWorkspace(input: BootstrapWorkspaceInput): Promise<CommandResult> {
  const command = input.command ?? DEFAULT_BOOTSTRAP_COMMAND;
  // SUBSTRATE BOUNDARY: the app-env prelude is prepended ONLY to the string handed
  // to `ssh.run` — never to `command`, which is the value that flows into the
  // error message / log below. So a bootstrap failure surfaces the ORIGINAL
  // command (prelude-free), and no app-secret value can reach the emitted
  // `workspace.failed` / `run.failed` events. Mirrors the gate path, which keeps
  // the original `step.run` in `gate.*` events.
  const result = await input.ssh.run(input.target, {
    command: withAppEnv(command, input.appEnv),
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
  });

  const succeeded = result.failure === undefined && !result.timedOut && result.exitCode === 0;
  if (!succeeded) {
    throw new WorkspaceBootstrapError(
      input.workspacePath,
      command,
      result.exitCode,
      tailOf(combinedOutput(result)),
      result.timedOut,
    );
  }
  return result;
}

// The sentinel the guarded install prints on the NO-OP path (manifest absent, or
// deps already installed). It rides on stdout so the caller can distinguish a
// real install run from a skip without a second round-trip — used to cache the
// "deps installed" flag so the next gate's ensure call is a pure no-op.
const DEPS_NOOP_SENTINEL = "tanren: deps-ensure no-op";
// The sentinel the guarded install prints right before it runs the install
// command, so the caller can observe (and the diagnostic can reflect) that the
// install path was actually taken.
const DEPS_INSTALL_SENTINEL = "tanren: deps-ensure installing";

export interface EnsureWorkspaceDepsInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  // The install command run in the workspace dir over SSH whenever a manifest
  // exists. Defaults to DEPS_ENSURE_DEFAULT_COMMAND — the NON-FROZEN
  // pnpm/npm-detecting install — so a writer that added a devDep without a
  // perfectly-regenerated lockfile still gets its binary installed before the gate.
  // The caller (buildDefaultGate) PASSES an explicit `command` for the cases where
  // the non-frozen default is wrong: a BROWNFIELD run gets the FROZEN
  // DEFAULT_BOOTSTRAP_COMMAND (so a committed lockfile is never mutated), and an
  // explicit `.tanren/ci.yml` `bootstrap.run` / `input.bootstrapCommand` is passed
  // verbatim. So this default applies ONLY to the genuine greenfield case.
  command?: string;
  // Plane B (P-APP-ENV-0): same substrate-boundary handling as bootstrapWorkspace
  // — the `export K='v'; …` prelude is prepended to the EXECUTED command ONLY, never
  // to `command`, so a failure surfaces the ORIGINAL command (prelude-free) and no
  // app-secret value can reach the error message / events. Undefined ⇒ no app env.
  appEnv?: Record<string, string>;
  timeoutMs: number;
}

// The outcome of an ensure call: whether the guarded install actually RAN the
// install command (a manifest was present) or was a no-op (no manifest yet). The
// install runs whenever a manifest exists — pnpm/npm is the idempotency authority,
// so re-running on an already-installed tree is a cheap no-op — which is what lets
// a writer-added devDep (authored AFTER an earlier partial install created
// node_modules) actually get installed before the gate. `installed` therefore
// reports "the install command ran", NOT "node_modules now exists for the first
// time"; the greenfield caller re-runs ensure each gate (the manifest mutates
// between iterations) rather than latching on this flag.
export interface EnsureWorkspaceDepsResult {
  installed: boolean;
}

// A typed, observable deps-install failure, mirroring WorkspaceBootstrapError.
// Carries the exit code and a bounded output tail so a halting run outcome has a
// concrete diagnostic. The ORIGINAL command (never the app-env prelude) is what
// flows into the message, so no app-secret value can leak into an event payload.
export class WorkspaceDepsInstallError extends Error {
  override readonly name = "WorkspaceDepsInstallError";

  constructor(
    readonly workspacePath: string,
    readonly command: string,
    readonly exitCode: number | null,
    readonly outputTail: string,
    readonly timedOut: boolean,
  ) {
    super(depsInstallFailureMessage(command, exitCode, outputTail, timedOut));
  }
}

// Idempotently ensures the workspace's dependencies are installed before a gate
// runs. This closes the greenfield gap: prepareRunWorkspace bootstraps ONCE, right
// after clone — but a greenfield clone HEAD ships no manifest, so the cold
// bootstrap skips install; the writer THEN authors `package.json`, and a
// per-iteration gate would run `pnpm lint` against a workspace whose deps were
// never installed (`turbo: not found` / `vitest: not found`).
//
// INSTALL-TRIGGER (the P0 fix): the guarded install runs the resolved install
// command whenever a manifest EXISTS (`package.json` / `pnpm-workspace.yaml`) —
// it does NOT also require `node_modules` to be absent. The old `[ ! -d
// node_modules ]` guard meant that once ANY partial install created
// node_modules, a LATER writer-added devDep (e.g. `vitest`) was never installed,
// so the gate died on `vitest: not found`. Letting the install run on every gate
// (with pnpm/npm as the idempotency authority — a no-op install is cheap) means
// the writer's freshly-added devDeps are always present at the gate. When no
// manifest exists yet (greenfield clone HEAD, pre-writer) it is still a pure
// no-op (exit 0). The default command (DEPS_ENSURE_DEFAULT_COMMAND) is NON-FROZEN
// so a greenfield manifest⇆lockfile mismatch installs rather than hard-failing; the
// caller passes an explicit `command` where that is wrong — the FROZEN
// DEFAULT_BOOTSTRAP_COMMAND for a brownfield run (a committed lockfile is never
// mutated) and any `.tanren/ci.yml` `bootstrap.run` verbatim. Safe to call before
// every gate.
//
// On a nonzero exit / timeout / substrate failure it throws WorkspaceDepsInstallError
// (mirroring bootstrapWorkspace) so the failure halts the run loudly with a typed,
// bounded diagnostic — never a silent skip.
export async function ensureWorkspaceDepsInstalled(
  input: EnsureWorkspaceDepsInput,
): Promise<EnsureWorkspaceDepsResult> {
  const command = input.command ?? DEPS_ENSURE_DEFAULT_COMMAND;
  // The guard runs entirely runner-side in ONE round-trip: if a manifest exists,
  // print the install sentinel then run the install; otherwise print the no-op
  // sentinel and exit 0. The install runs whenever a manifest is present (no
  // node_modules gate) so a writer-added devDep installs even when an earlier
  // partial install already created node_modules — pnpm/npm is the idempotency
  // authority, so a redundant install is a cheap no-op. `set -e` is intentionally
  // NOT used at the top — the `if`/`else` already controls flow and the install
  // command itself surfaces its own nonzero exit as the command's exit code.
  const guarded =
    `if [ -f package.json ] || [ -f pnpm-workspace.yaml ]; then ` +
    `echo ${quoteSshShellArg(DEPS_INSTALL_SENTINEL)}; ${command}; ` +
    `else echo ${quoteSshShellArg(DEPS_NOOP_SENTINEL)}; fi`;
  // SUBSTRATE BOUNDARY: the app-env prelude is prepended to the EXECUTED guard
  // ONLY, never to `command` (the value carried into the error below), so a
  // failed install surfaces the ORIGINAL install command and no app-secret value
  // reaches WorkspaceDepsInstallError or the run's event payloads.
  const result = await input.ssh.run(input.target, {
    command: withAppEnv(guarded, input.appEnv),
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
  });

  const succeeded = result.failure === undefined && !result.timedOut && result.exitCode === 0;
  if (!succeeded) {
    throw new WorkspaceDepsInstallError(
      input.workspacePath,
      command,
      result.exitCode,
      tailOf(combinedOutput(result)),
      result.timedOut,
    );
  }
  // The install branch echoes DEPS_INSTALL_SENTINEL before running; its presence
  // on stdout tells the caller the install path was taken (vs the no-op skip), so
  // it can cache "deps installed" and skip the stat round-trip on the next gate.
  return { installed: result.stdout.includes(DEPS_INSTALL_SENTINEL) };
}

function depsInstallFailureMessage(
  command: string,
  exitCode: number | null,
  outputTail: string,
  timedOut: boolean,
): string {
  const reason = timedOut ? "timed out" : `exited ${exitCode ?? "unknown"}`;
  const tail = outputTail === "" ? "" : `: ${outputTail}`;
  return `workspace deps install (${command}) ${reason}${tail}`;
}

// The paths added to the workspace's LOCAL git ignore (`.git/info/exclude`)
// right after clone. This is a per-checkout ignore (NOT a committed `.gitignore`)
// so a later `git add -A` — the bootstrap commit and every writer commit — NEVER
// sweeps an install/build tree into the repo, regardless of whether the cloned
// repo ships a `.gitignore`. This is the durable fix for the 46MB checker-prompt
// failure: a prior gate's `pnpm install` left `node_modules/` in the tree, and
// `git add -A` committed it, ballooning the writer diff past the model's input
// limit. The greenfield scaffold ALSO mandates a committed `.gitignore` (so the
// produced repo is correct); this exclude is the workspace-side belt-and-braces.
export const WORKSPACE_LOCAL_IGNORE_PATHS = ["node_modules/", "dist/"] as const;

export interface SeedWorkspaceLocalIgnoreInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  timeoutMs: number;
}

// Appends WORKSPACE_LOCAL_IGNORE_PATHS to the cloned repo's `.git/info/exclude`
// (idempotently — duplicate lines there are harmless and git de-dupes the match).
// Runs over SSH in the workspace dir. Must be called AFTER the clone and BEFORE
// the first install/commit so no `git add -A` can ever stage node_modules/dist.
export async function seedWorkspaceLocalIgnore(input: SeedWorkspaceLocalIgnoreInput): Promise<void> {
  const lines = WORKSPACE_LOCAL_IGNORE_PATHS.map((p) => quoteSshShellArg(p)).join(" ");
  await runWorkspaceSshCommand(input.ssh, input.target, {
    label: "seed workspace local git ignore",
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
    // `git rev-parse --git-path info/exclude` resolves the exclude file for the
    // checkout (worktree-safe) and `mkdir -p` ensures its dir exists before we
    // append. printf one path per line.
    command: [
      "set -eu",
      'exclude="$(git rev-parse --git-path info/exclude)"',
      'mkdir -p "$(dirname "$exclude")"',
      `printf '%s\\n' ${lines} >> "$exclude"`,
    ].join("\n"),
  });
}

export interface CommitBootstrapStateInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  timeoutMs: number;
}

// Commits whatever the bootstrap step produced (lockfiles, node_modules, any
// generated tree) as ONE synthetic commit on the workspace branch, and returns
// its sha. This commit becomes the writer's diff base (run baseSha), so the
// writer iterations — which diff vs this sha — see only their own changes, not
// bootstrap artifacts.
//
// `--allow-empty` so the no-manifest / artifact-free case still yields a real
// commit, keeping the run base a concrete sha and the later PR-branch cleanup
// (drop-the-bootstrap-commit rebase) symmetric in every case.
export async function commitBootstrapState(input: CommitBootstrapStateInput): Promise<string> {
  const result = await runWorkspaceSshCommand(input.ssh, input.target, {
    label: "commit bootstrap state",
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
    command: [
      "set -eu",
      "git add -A",
      // -q so the commit summary stays off stdout; git rev-parse is then the
      // only stdout-producing step and its output is the bootstrap commit sha.
      "GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' " +
        `git commit -q --allow-empty -m ${quoteSshShellArg(BOOTSTRAP_COMMIT_MESSAGE)}`,
      "git rev-parse HEAD",
    ].join(" && "),
  });
  const sha = result.stdout.trim();
  // "" only on a fake SSH that yields no output (unit paths drive the loop with
  // fake writers that ignore baseSha), mirroring prepareWorkspace. The real
  // runner always returns a 40-hex sha.
  if (sha !== "" && !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(`bootstrap commit returned invalid sha: ${sha}`);
  }
  return sha;
}

// Resolve the workspace HEAD commit sha over SSH — the commit the native gate is
// verifying when it runs. The native `gate.verdict` is anchored on this sha (the
// headSha CI-intelligence reduces). Returns "" on a fake SSH that yields no output
// (unit paths), in which case the caller emits no verdict; a real runner always
// returns a 40-hex sha and a malformed value is a LOUD throw (never a guessed sha).
export async function resolveWorkspaceHeadSha(input: {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  timeoutMs: number;
}): Promise<string> {
  const result = await runWorkspaceSshCommand(input.ssh, input.target, {
    label: "resolve workspace head sha",
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
    command: "git rev-parse HEAD",
  });
  const sha = result.stdout.trim();
  if (sha !== "" && !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(`workspace head resolution returned invalid sha: ${sha}`);
  }
  return sha;
}

function combinedOutput(result: CommandResult): string {
  if (result.failure !== undefined) {
    const detail = "message" in result.failure ? result.failure.message : result.failure.reason;
    return [result.stdout, result.stderr, detail].filter((part) => part !== undefined && part !== "").join("\n");
  }
  return [result.stdout, result.stderr].filter((part) => part !== "").join("\n");
}

function tailOf(output: string): string {
  if (output.length <= OUTPUT_TAIL_LIMIT) {
    return output;
  }
  return output.slice(output.length - OUTPUT_TAIL_LIMIT);
}

function bootstrapFailureMessage(
  command: string,
  exitCode: number | null,
  outputTail: string,
  timedOut: boolean,
): string {
  const reason = timedOut ? "timed out" : `exited ${exitCode ?? "unknown"}`;
  const tail = outputTail === "" ? "" : `: ${outputTail}`;
  return `workspace bootstrap (${command}) ${reason}${tail}`;
}

// Kept exported so callers that want to build the workspace-dir-scoped command
// string themselves (e.g. for logging) stay consistent with what we run.
export function bootstrapCommandForLog(workspacePath: string, command: string): string {
  return `cd ${quoteSshShellArg(workspacePath)} && ${command}`;
}
