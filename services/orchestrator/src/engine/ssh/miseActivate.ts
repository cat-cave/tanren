// Mise activation helper (environment-management.md §3 Layer 2): make the project's
// `mise`-provisioned toolchain ACTIVE for the project's OWN command execution, so a
// bare `node`/`pnpm`/etc in the project's bootstrap/gate command resolves to the
// version the project DECLARED in its `mise.toml` (provisioned at workspace-prep via
// `mise install`), rather than the runner's harness node.
//
// THE TWO-PATH SEPARATION (the crux of P0b/c):
//   - PROJECT-COMMAND path — the project's bootstrap + gate tiers (and the build/
//     deploy commands that run through the gate). These run the project's DECLARED
//     shell, which may call a bare `pnpm`/`node`/`python`. They MUST be mise-activated
//     so those resolve to the project's declared toolchain. `withMiseActivation`
//     prefixes them with `eval "$(mise activate bash --shims)"` (the documented
//     non-interactive / CI activation — see `miseActivationPrelude` for WHY hook-mode
//     is wrong here), guarded on a `mise.toml` being present in the cwd (so a project
//     that declared no toolchain is unaffected — the activation is a no-op).
//   - HARNESS / answerer path — `codex` (writer + Checker/Auditor). It runs on the
//     runner's OWN isolated node (P0a installs the harness node on the system PATH and
//     does NOT globally activate mise). This module is NEVER applied there: the codex
//     exec path (engine/providers/codex.ts) builds its command directly and stays on
//     the harness node, untouched by the project's toolchain.
//   - PROJECT-HOOK path — a Tanren-issued `git commit` that leaves the repo's hook path
//     LIVE (`withProjectHookToolchain`). The git binary is the harness's, but the hook
//     it fires is the PROJECT's code, so the hook needs the PROJECT's toolchain. See
//     that function for the full rationale; it is the same activation, invoked for a
//     third reason, and it does NOT put the project's toolchain on the harness path —
//     the codex exec that produced the changes has already exited by then.
//
// SECURITY: like the app-env prelude, the activation is prepended ONLY to the EXECUTED
// command string handed to the SSH substrate — never to a logged/emitted command (gate
// `step.run`, the bootstrap error's `command`), so the original command still flows
// into every event. The prelude contains no secret material.

import { quoteSshShellArg } from "./command.js";

// The conventional path of the project's `mise.toml` (mirrors
// SKELETON_MISE_CONFIG_PATH; kept local so this ssh helper has no scaffold dep). The
// guard tests for THIS file in the command's cwd before activating.
const MISE_CONFIG_REL_PATH = "mise.toml";

// The mise activation prelude. It uses the `--shims` mode of `mise activate`, which
// emits a plain, POSIX `export PATH="…/shims:$PATH"` that IMMEDIATELY puts the project's
// mise shims on PATH for the rest of the `bash -c`/`sh -c` command (the shims dispatch
// to the per-dir active version resolved from `mise.toml`); we `eval` it so a bare
// `node`/`pnpm` resolves to the declared version.
//
// WHY NOT plain `eval "$(mise activate bash)"` (the hook mode): that emits an
// INTERACTIVE shell hook (a `mise()` shim function + a `_mise_hook` precmd/chpwd hook)
// whose PATH update fires only on an interactive prompt or a `cd` — NOT immediately for
// the non-interactive `bash -c "<prelude>; <command>"` we run over SSH, so a bare
// `pnpm` would not be found (the observed failure: `mise install` provisions
// node+pnpm fine, then `pnpm install` dies with `sh: pnpm: not found`, exit 127). The
// hook-mode output is also full of bash-only syntax (`__MISE_FLAGS=()` arrays,
// `declare -f`, `[[ … ]]`), so under a non-bash project shell (e.g. a `just` recipe run
// via `sh`/dash, the actual live failure shell) it `eval`s to a syntax error and never
// touches PATH at all. The `--shims` export is POSIX-clean and is inherited by child
// shells, so the toolchain survives into `just`/`sh -c` sub-invocations too.
//
// GUARDED: it only activates when a `mise.toml` exists in the cwd, so a project that
// declared NO toolchain (no mise.toml materialized) runs exactly as before (the
// activation is skipped, a pure no-op). `MISE_YES=1` keeps any mise sub-action
// non-interactive. The whole prelude is one `if … fi; ` statement chained before the
// real command with `;` (NOT `&&`): a project with no mise.toml must still run its
// command — the guard is a skip, not a gate.
function miseActivationPrelude(): string {
  return (
    `if [ -f ${quoteSshShellArg(MISE_CONFIG_REL_PATH)} ]; then ` +
    `export MISE_YES=1; eval "$(mise activate bash --shims)"; fi; `
  );
}

/**
 * Prepend the mise-activation prelude to a PROJECT command so a bare `node`/`pnpm`/etc
 * resolves to the project's `mise.toml`-declared toolchain. Self-guarding: when the
 * workspace ships no `mise.toml` (the project declared no toolchain) the activation is
 * skipped and the command runs unchanged. Apply ONLY to the project-command paths
 * (bootstrap + gate tiers + build/deploy-through-gate) — NEVER to the codex/harness path.
 */
export function withMiseActivation(command: string): string {
  return `${miseActivationPrelude()}${command}`;
}

/**
 * Prepend the SAME activation to a Tanren-issued git command that runs the PROJECT's
 * commit hooks. Distinct from {@link withMiseActivation} only in WHY, and named so every
 * call site states which of the module's paths it is on.
 *
 * THE RULE: if Tanren issues a git command that leaves the repo's hook path live, that
 * command executes the project's code and must therefore carry the project's toolchain.
 * A `git commit` is not "a git command" from the hook's point of view — it is the
 * project's `.husky/pre-commit` (or lefthook, or a bare `.git/hooks/pre-commit`) running
 * `pnpm`/`node`/`bundle`. Those resolve against PATH, and the runner ships NO project
 * toolchain by design (runner/Dockerfile: mise is a binary on PATH, never globally
 * activated), so a commit shell without it has exactly the harness node and nothing
 * else. MEASURED on a live runner, in the exact shell `buildSshExecCommand` produces:
 *
 *   PATH=/usr/local/bin:/usr/bin:/bin:/usr/games
 *   pnpm: NOT-FOUND
 *   .husky/pre-commit: 2: pnpm: not found   →   husky - pre-commit script failed
 *
 * …while the same shell with this prelude resolves the provisioned
 * `…/mise/installs/pnpm/<version>/pnpm` and the hook RUNS AND PASSES. The toolchain was
 * never missing — `miseProvisionCommand` installed it at workspace-prep; it simply was
 * not on PATH for this subprocess, because `runWorkspaceSshCommand` adds no prelude and
 * the activation was wired at exactly three call sites, none of them a commit.
 *
 * WHY ACTIVATE RATHER THAN BYPASS THE HOOKS. A `git commit` CAN be taken off the repo's
 * hooks with `-c core.hooksPath=/dev/null`, and for a commit that is purely Tanren's own
 * bookkeeping — one that never reaches the PR — that is the right call. These commits are
 * NOT that: they carry content into the PR a reviewer will read, so suppressing their
 * hooks would be a silent policy change (Tanren deciding the project's pre-commit gate
 * does not apply to Tanren-authored content). The project's hook is also CORRECT: it
 * legitimately needs the toolchain. A hook that runs and passes is evidence; a hook that
 * was skipped is not. So we satisfy the hook instead of silencing it.
 *
 * SCOPE. Commit-time hooks only (pre-commit / prepare-commit-msg / commit-msg), which is
 * what the whole activation is guarded and proven for. `pre-push` hooks on the workspace
 * push paths are the same class of exposure and are deliberately NOT changed here: no
 * push-hook failure has been observed, and those commands carry auth material on stdin,
 * so they are left for a change that can prove itself the way this one does.
 */
export function withProjectHookToolchain(command: string): string {
  return withMiseActivation(command);
}

// The mise PROVISIONING commands run at workspace-prep, BEFORE the project's bootstrap,
// when a `mise.toml` is present: `mise trust` (mise's config-trust security gate — the
// config is Tanren-materialized + trusted) then `mise install` (download the declared
// toolchain into the `tanren` user space). LOUD on failure: the caller runs these with
// `set -e` so a failed install HALTS the run (no silent skip), per the no-silent-fallback
// doctrine. GUARDED on the mise.toml being present so a no-toolchain project is a no-op.
// `MISE_YES=1` makes trust/install non-interactive.
export function miseProvisionCommand(): string {
  return (
    `if [ -f ${quoteSshShellArg(MISE_CONFIG_REL_PATH)} ]; then ` +
    `export MISE_YES=1; mise trust ${quoteSshShellArg(MISE_CONFIG_REL_PATH)} && mise install; ` +
    `else echo ${quoteSshShellArg("tanren: no mise.toml - skipping mise install (project declared no toolchain)")}; fi`
  );
}
