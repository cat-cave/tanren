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
//     prefixes them with `eval "$(mise activate bash)"`, guarded on a `mise.toml`
//     being present in the cwd (so a project that declared no toolchain is unaffected
//     — the activation is a no-op).
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

// The mise activation prelude. `mise activate bash` emits the shell hook that prepends
// the project's mise shims to PATH for the rest of the command; we `eval` it so a bare
// `node`/`pnpm` resolves to the declared version. GUARDED: it only activates when a
// `mise.toml` exists in the cwd, so a project that declared NO toolchain (no mise.toml
// materialized) runs exactly as before (the activation is skipped, a pure no-op).
// `MISE_YES=1` keeps any mise sub-action non-interactive. The whole prelude is one
// `if … fi; ` statement chained before the real command with `;` (NOT `&&`): a project
// with no mise.toml must still run its command — the guard is a skip, not a gate.
function miseActivationPrelude(): string {
  return (
    `if [ -f ${quoteSshShellArg(MISE_CONFIG_REL_PATH)} ]; then ` +
    `export MISE_YES=1; eval "$(mise activate bash)"; fi; `
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
    `export MISE_YES=1; mise trust ${quoteSshShellArg(MISE_CONFIG_REL_PATH)} && mise install; ` +
    `else echo ${quoteSshShellArg("tanren: no mise.toml - skipping mise install (project declared no toolchain)")}; fi`
  );
}
