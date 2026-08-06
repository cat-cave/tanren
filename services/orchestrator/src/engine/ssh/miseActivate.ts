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

// The script the runner image writes to publish its SHARED mise data + cache dirs
// (runner/Dockerfile: `printf 'export MISE_DATA_DIR=…\nexport MISE_CACHE_DIR=…\n' >
// /etc/profile.d/tanren-mise-shared-dir.sh`). The image OWNS this path and its contents;
// the engine only sources it.
const MISE_SHARED_DIR_PROFILE_SCRIPT = "/etc/profile.d/tanren-mise-shared-dir.sh";

// Make the runner image's WARM mise baseline actually reachable, for every mise
// invocation the engine makes.
//
// The image bakes a warm baseline into a shared, world-readable dir and publishes its
// location three ways (runner/Dockerfile): the `TANREN_MISE_*` image ENV, the
// `/etc/profile.d` script above, and an append to `~/.bashrc`. NONE of them reach us:
//
//   - We run commands over a NON-LOGIN, NON-INTERACTIVE `ssh exec` (ssh2Substrate →
//     `client.exec`), which sources neither `/etc/profile.d` nor — past Debian's early
//     non-interactive return — `~/.bashrc`.
//   - The image ENV belongs to the sshd DAEMON's process environment. sshd builds a
//     fresh environment for the session and does NOT forward arbitrary daemon variables;
//     the runner's sshd_config sets no `SetEnv`, `AcceptEnv` or `PermitUserEnvironment`,
//     and the entrypoint writes no `/etc/environment`. So `$TANREN_MISE_DATA_DIR` is
//     EMPTY in the session, even though a container-exec probe (which DOES inherit the
//     image ENV) shows it set — a trap when reproducing this by hand.
//
// So `MISE_DATA_DIR` arrives unset and mise silently resolves its own `$HOME` defaults:
//
//   $ ssh runner 'mise doctor'          # the exec the engine actually performs
//   dirs:
//     data:  ~/.local/share/mise        # cold — re-downloaded every run
//     cache: ~/.cache/mise
//
// The whole warm-baseline mechanism is inert: every run re-downloads a toolchain the
// image already ships, into a dir shared by every concurrent run on that runner and
// pinned by nobody.
//
// The fix uses the one publication route that survives a non-login exec: SOURCE the
// image's own script. GUARDED on it being readable, so a runner that publishes no shared
// dir (a bare `manual_ssh` host, a non-Tanren image) keeps mise's defaults exactly as
// before — the engine never invents a path the substrate did not offer. Written as
// `if … fi` rather than `[ -r … ] && .` because the provision command runs under
// `set -e`, where a false `&&` chain would abort the whole command.
//
// Both mise seams below share this prelude ON PURPOSE: `mise install` must write where
// `mise activate --shims` will later read. Pinning one without the other would install
// the toolchain into a dir the activation does not look in.
const MISE_SHARED_DIR_PRELUDE = `if [ -r ${MISE_SHARED_DIR_PROFILE_SCRIPT} ]; then . ${MISE_SHARED_DIR_PROFILE_SCRIPT}; fi; `;

/** The shared-dir prelude, exported for the agreement + guard assertions in the tests. */
export function miseSharedDirPrelude(): string {
  return MISE_SHARED_DIR_PRELUDE;
}

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
    `export MISE_YES=1; ${MISE_SHARED_DIR_PRELUDE}eval "$(mise activate bash --shims)"; fi; `
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
    `export MISE_YES=1; ${MISE_SHARED_DIR_PRELUDE}` +
    `mise trust ${quoteSshShellArg(MISE_CONFIG_REL_PATH)} && mise install; ` +
    `else echo ${quoteSshShellArg("tanren: no mise.toml - skipping mise install (project declared no toolchain)")}; fi`
  );
}
