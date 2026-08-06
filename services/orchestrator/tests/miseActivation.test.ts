// env P0b/c — the project-command-vs-harness two-path separation for mise.
//
// The crux of wiring point 5: the PROJECT's gate/bootstrap commands run mise-ACTIVATED
// (so a bare `node`/`pnpm` resolves to the project's `mise.toml`-declared toolchain),
// while the HARNESS path (codex writer + answerer) is NEVER mise-activated (it keeps
// the runner's isolated node, per P0a). These tests pin both halves:
//   - `withMiseActivation` prefixes the project command with a guarded NON-INTERACTIVE
//     `mise activate bash --shims` (NOT the interactive hook mode — see below), and BOTH
//     of its guarded branches FAIL CLOSED when the activation exits nonzero;
//   - `miseProvisionCommand` is a guarded `mise trust && mise install`;
//   - the codex exec command builders contain NO mise activation (the harness path).

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MISE_LOCK_SLICE_SECONDS,
  MISE_LOCK_WAIT_SECONDS,
  MISE_SHARED_LOCK_FILE,
  miseProvisionCommand,
  miseRunScope,
  miseSharedDirPrelude,
  withMiseActivation,
} from "../src/engine/ssh/miseActivate.js";
import { buildCodexAnswererExecCommand, buildCodexExecCommand } from "../src/engine/providers/codexExecCommand.js";

// Two concurrent runs on the ONE static runner container, as the SAME unix user — the
// posture the whole per-run-scope change exists for.
const RUN_A = "/workspace/runs/run_alpha/repo";
const RUN_B = "/workspace/runs/run_bravo/repo";

describe("withMiseActivation · the PROJECT-command path is mise-activated", () => {
  it("prefixes the command with a NON-INTERACTIVE `--shims` activate, guarded on a mise.toml", () => {
    const wrapped = withMiseActivation("pnpm install", RUN_A);
    // SHIMS / non-interactive activation: `--shims` emits a plain POSIX
    // `export PATH="…/shims:$PATH"` that IMMEDIATELY puts the toolchain on PATH for the
    // rest of the `bash -c`/`sh -c` command. This is the crux of the fix.
    //
    // CAPTURED, CHECKED, then evaluated — not the obvious `eval "$(…)"`. That form reports
    // the status of EVAL, never of the substitution inside it: an activation that exited
    // nonzero substitutes to the EMPTY string, `eval ""` succeeds, and the project's
    // command proceeds with its declared toolchain absent.
    expect(wrapped).toContain('__tanren_mise_activate="$(mise activate bash --shims)"');
    expect(wrapped).toContain('eval "$__tanren_mise_activate"');
    expect(wrapped).toContain("toolchain activation FAILED");
    // NOT the bare/hook mode: `mise activate bash` (no `--shims`) installs an INTERACTIVE
    // precmd/chpwd hook that never fires for a non-interactive `bash -c`, and its bash-only
    // syntax `eval`s to an error under a `sh`/dash project shell — so PATH is never set and
    // a bare `pnpm` is `not found` (the observed apex exit-127 failure).
    expect(wrapped).not.toContain('eval "$(mise activate bash)"');
    // GUARDED: only activates when a mise.toml is present in the cwd, so a project that
    // declared no toolchain runs unchanged (the activation is a no-op skip).
    expect(wrapped).toContain("[ -f 'mise.toml' ]");
    // Non-interactive.
    expect(wrapped).toContain("MISE_YES=1");
    // The project's own command still runs AFTER the prelude (verbatim, at the tail).
    expect(wrapped.endsWith("pnpm install")).toBe(true);
  });

  it("is a no-op-shaped guard — a no-toolchain project's command runs even with no mise.toml", () => {
    // The guard is an `if … fi;` chained with `;` (NOT `&&`): a missing mise.toml SKIPS
    // activation but the project command still runs. Assert the chain uses `fi; ` before
    // the command, not `fi && `.
    const wrapped = withMiseActivation("echo hi", RUN_A);
    expect(wrapped).toContain("fi; echo hi");
    expect(wrapped).not.toContain("fi && echo hi");
  });

  it('CAPTURES and CHECKS BOTH branches — no bare `eval "$(` anywhere in the prelude', () => {
    // The fail-open, stated as a shape rule over the WHOLE prelude rather than one branch
    // of it. `eval "$(cmd)"` reports the status of EVAL, never of `cmd`, so the prelude
    // must contain NO command substitution sitting directly inside an `eval`.
    const prelude = withMiseActivation("", RUN_A);
    expect(prelude).not.toMatch(/eval\s+"\$\(/u);
    // …and every `eval` in it reads the CAPTURED variable. There are TWO, one per guarded
    // branch: fixing only the `mise.toml` branch would leave the marker branch — the one
    // that serves the far larger population of repos that never mentioned mise, and whose
    // toolchain Tanren itself provisioned — failing open exactly as before.
    const evals = (prelude.match(/eval\s+[^;]+/gu) ?? []).map((e) => e.trim());
    expect(evals).toEqual(['eval "$__tanren_mise_activate"', 'eval "$__tanren_mise_activate"']);
    // Each capture is guarded by its OWN `||` branch, not left unchecked…
    expect(prelude).toContain('__tanren_mise_activate="$(mise activate bash --shims)" || {');
    expect(prelude).toContain('__tanren_mise_activate="$(mise env -s bash)" || {');
    // …and there are TWO of those, one per branch — not one shared halt bolted onto the
    // guard, which would leave whichever branch it is not inside still failing open. (WHAT
    // each one SAYS is asserted against a real shell below: the source name is embedded
    // single-quoted, so it only reads back as prose once the shell has unescaped it.)
    expect(prelude.split("toolchain activation FAILED").length - 1).toBe(2);
  });
});

// REGRESSION (fail-closed) — the activation is a HALT on failure, not a skip. Each branch
// is entered only once the guard has established that this run HAS a toolchain to activate
// (the repo's own `mise.toml`, or a marker written by a provision that verified every
// declared binary), so an activation that dies means the project's command would otherwise
// run against whatever the runner image happens to carry.
//
// These drive the EMITTED string through a real POSIX `sh -c` — the same shape the
// substrate performs — because the defect is a SHELL-SEMANTICS one. No string assertion
// can settle it: `eval "$(false)"` and `x="$(false)" || exit 1` differ only in what the
// shell does with the status, which is exactly the thing a `toContain` cannot see.
describe("a failed mise activation HALTS the command (it does not silently continue)", () => {
  it("mise.toml branch: prints the reason to STDERR and exits nonzero WITHOUT running the command", () => {
    const shell = runPrelude({ trigger: "mise.toml", activateFails: true });
    // Nonzero: the run halts here rather than gating against a toolchain that is not on PATH.
    expect(shell.status).not.toBe(0);
    // The reason reaches STDERR (stdout stays the project's own stream) and names the
    // source that failed, so the operator knows which seam died.
    expect(shell.stderr).toContain("tanren: toolchain activation FAILED");
    expect(shell.stderr).toContain("'mise activate bash --shims' exited nonzero");
    // The project's command NEVER ran — the whole point of the halt.
    expect(shell.stdout).not.toContain(PROJECT_MARKER);
  });

  it("mise.toml branch: a SUCCESSFUL activation still applies the toolchain and runs the command", () => {
    // The other half: the check must not have turned the working path into a halt.
    const shell = runPrelude({ trigger: "mise.toml", activateFails: false });
    expect(shell.status).toBe(0);
    expect(shell.stdout).toContain(PROJECT_MARKER);
    // The captured export was actually EVALUATED — capturing without evaluating would be a
    // silent no-activation that every string assertion above would still pass.
    expect(shell.stdout).toContain(FAKE_SHIMS_DIR);
  });

  it("MARKER branch: a failed `mise env` halts too — the second door is not left open", () => {
    // The branch the backport had to widen to. Main grew a second activation door for
    // repos Tanren DETECTED a toolchain for, and a fail-closed that covers one door is not
    // a fail-closed: this is the branch most repos actually take.
    const shell = runPrelude({ trigger: "marker", activateFails: true });
    expect(shell.status).not.toBe(0);
    expect(shell.stderr).toContain("tanren: toolchain activation FAILED");
    // Names ITS source, not branch 1's — a shared message would leave the operator
    // debugging the wrong door.
    expect(shell.stderr).toContain("'mise env -s bash' exited nonzero");
    expect(shell.stderr).not.toContain("mise activate bash --shims");
    expect(shell.stdout).not.toContain(PROJECT_MARKER);
  });

  it("MARKER branch: a SUCCESSFUL activation applies the DECLARED tools and runs the command", () => {
    const shell = runPrelude({ trigger: "marker", activateFails: false });
    expect(shell.status).toBe(0);
    expect(shell.stdout).toContain(PROJECT_MARKER);
    // `mise env`, NOT the shims dir — the deliberate difference between the branches (the
    // shims dir shadows every tool in the runner's shared store, including undeclared
    // ones). Asserting the env dir is also what proves the marker branch, not branch 1, ran.
    expect(shell.stdout).toContain(FAKE_ENV_DIR);
    expect(shell.stdout).not.toContain(FAKE_SHIMS_DIR);
  });

  it("NEGATIVE CONTROL: neither trigger present is a pure SKIP that chains into the command", () => {
    // The guard stays a skip, not a gate. A repo that declared no toolchain enters NEITHER
    // branch — nothing to activate, nothing to fail closed on — and its command runs
    // exactly as it did before this change, with a still-zero exit. Without this, "fail
    // closed" could have been implemented as "fail", and every no-toolchain repo would
    // halt on a `mise` the runner does not even need.
    const shell = runPrelude({ trigger: "none", activateFails: true });
    expect(shell.status).toBe(0);
    expect(shell.stdout).toContain(PROJECT_MARKER);
    expect(shell.stderr).not.toContain("toolchain activation FAILED");
    // No activation happened at all: neither dir is on PATH.
    expect(shell.stdout).not.toContain(FAKE_SHIMS_DIR);
    expect(shell.stdout).not.toContain(FAKE_ENV_DIR);
  });
});

/** What the project's own command prints, so a halt is distinguishable from a run. */
const PROJECT_MARKER = "tanren-test: the project command ran";
/** What the stub's `mise activate --shims` puts on PATH — branch 1's evidence. */
const FAKE_SHIMS_DIR = "/tanren-test/fake-shims";
/** What the stub's `mise env -s bash` puts on PATH — branch 2's evidence. */
const FAKE_ENV_DIR = "/tanren-test/fake-mise-env";

/** Which of the two guarded triggers the fake workspace presents (or neither). */
type ActivationTrigger = "mise.toml" | "marker" | "none";

/**
 * Execute the EMITTED activation prelude in a real POSIX shell, against a stub `mise` that
 * succeeds or fails on demand. Nothing here talks to a real mise or a real runner: the unit
 * under test is the shell string, and the stub is the smallest thing that can answer it.
 *
 * `HOME` is redirected into the temp dir because a workspace path that is not a run sandbox
 * gets `$HOME`-scoped mise state ({@link miseRunScope}) — so the marker the `marker` trigger
 * writes lands inside the dir this reclaims, and never in the developer's real home.
 */
function runPrelude(opts: { trigger: ActivationTrigger; activateFails: boolean }): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "tanren-mise-activation-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // A `mise` that either emits the POSIX export each real subcommand emits — a DIFFERENT
    // one per subcommand, so the test can tell which branch actually ran — or dies.
    const failingStub = '#!/bin/sh\necho "mise: activation exploded" >&2\nexit 3\n';
    const workingStub = [
      "#!/bin/sh",
      'case "$1" in',
      `  activate) echo 'export PATH="${FAKE_SHIMS_DIR}:$PATH"' ;;`,
      `  env) echo 'export PATH="${FAKE_ENV_DIR}:$PATH"' ;;`,
      '  *) echo "mise: unexpected subcommand $*" >&2; exit 9 ;;',
      "esac",
      "",
    ].join("\n");
    writeFileSync(join(bin, "mise"), opts.activateFails ? failingStub : workingStub);
    chmodSync(join(bin, "mise"), 0o755);
    // Branch 1's trigger: the repo ships its own mise config, in the command's cwd.
    if (opts.trigger === "mise.toml") writeFileSync(join(dir, "mise.toml"), "[tools]\n");
    // Branch 2's trigger: the marker a verified provision writes for THIS run.
    if (opts.trigger === "marker") writeFileSync(miseRunScope(dir).markerFile.replace("$HOME", dir), "");

    // The project's command prints its marker and the PATH the activation left behind.
    const command = withMiseActivation(`printf '%s %s\\n' '${PROJECT_MARKER}' "$PATH"`, dir);
    const result = spawnSync("sh", ["-c", command], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, HOME: dir, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("miseRunScope · one runner, three concurrent runs, no shared mise state", () => {
  it("gives two different runs different config and marker files, and the SAME lock file", () => {
    const a = miseRunScope(RUN_A);
    const b = miseRunScope(RUN_B);
    // ISOLATION: the config is what `mise use --global` writes and what `mise which` /
    // `mise current` read back. Shared, run A verifies against the version run B just
    // wrote — the "last writer wins" half of the defect, which no lock can fix.
    expect(a.configFile).not.toBe(b.configFile);
    // ISOLATION: the marker is the activation trigger. Shared, run A's successful
    // provision makes run B activate a toolchain B never provisioned.
    expect(a.markerFile).not.toBe(b.markerFile);
    // SHARED, ON PURPOSE: mutual exclusion over the one shared MISE_DATA_DIR is the
    // point — two runs each taking their OWN lock would serialise nothing at all.
    expect(a.lockFile).toBe(b.lockFile);
    expect(a.lockFile).toBe(MISE_SHARED_LOCK_FILE);
  });

  it("puts a production run's mise state in the RUN dir, outside the repo Tanren did not author", () => {
    const scope = miseRunScope(RUN_A);
    // `/workspace/runs/<runId>` — the sandbox root, one level ABOVE `…/repo`, so the
    // writer's diff, the bootstrap commit and the pushed branch stay untouched.
    expect(scope.configFile).toBe("/workspace/runs/run_alpha/tanren-mise-config.toml");
    expect(scope.markerFile).toBe("/workspace/runs/run_alpha/tanren-mise-provisioned");
    // Nothing lands under `…/repo`, which IS the repository tree.
    expect(scope.configFile).not.toContain("/repo/");
    expect(scope.markerFile).not.toContain("/repo/");
  });

  it("falls back to a deterministic per-workspace name for a path that is not a run sandbox", () => {
    // The `rawInput.workspacePath` override seam (workflow/plannerRun.ts) and the
    // container fixtures pass paths of other shapes. Deterministic, never a throw.
    const first = miseRunScope("/home/tanren/tanren-toolchain-proof");
    expect(first).toEqual(miseRunScope("/home/tanren/tanren-toolchain-proof"));
    // Still PER-WORKSPACE — the isolation claim must not quietly collapse off the
    // production path, which is exactly where a fixture would stop reproducing the bug.
    expect(first.configFile).not.toBe(miseRunScope("/home/tanren/other-proof").configFile);
    // Home-scoped and shell-safe: `$HOME` expands, and the derived name carries no other
    // metacharacter, because these paths are emitted inside double quotes.
    expect(first.configFile.startsWith("$HOME/.tanren-mise-")).toBe(true);
    expect(first.configFile).toMatch(/^\$HOME\/\.tanren-mise-[A-Za-z0-9-]+-config\.toml$/u);
  });
});

describe("miseProvisionCommand · workspace-prep provisions the declared toolchain", () => {
  it("is a guarded `mise trust && mise install`, loud (no silent skip on a real failure)", () => {
    const cmd = miseProvisionCommand(RUN_A);
    expect(cmd).toContain("mise trust 'mise.toml'");
    expect(cmd).toContain("mise install");
    // trust THEN install, chained with `&&` so a failed trust aborts before install
    // (and the caller runs it under `set -e`, so a failed install is a LOUD halt).
    expect(cmd.indexOf("mise trust")).toBeLessThan(cmd.indexOf("mise install"));
    // GUARDED on the mise.toml being present so a no-toolchain project is a no-op skip.
    expect(cmd).toContain("[ -f 'mise.toml' ]");
    expect(cmd).toContain("skipping mise install");
  });

  it("holds the SHARED lock across `mise install`, because that writes the shared data dir", () => {
    const cmd = miseProvisionCommand(RUN_A);
    // The repo's own mise.toml outranks Tanren's per-run config in mise's hierarchy, so
    // this branch is not exposed to the config race — but `mise install` still mutates
    // the ONE shared installs tree, which is the `ln -sf … File exists` failure.
    expect(cmd).toContain(`flock -w ${String(MISE_LOCK_SLICE_SECONDS)} 9`);
    expect(cmd).toContain(`9>"${MISE_SHARED_LOCK_FILE}"`);
    expect(cmd.indexOf("flock")).toBeLessThan(cmd.indexOf("mise install"));
    // The WAIT is sliced and announced (stderr), because the lock lives outside the
    // workspace the activity watchdog probes: a single silent `flock -w 900` is read as a
    // wedged command and the connection is destroyed roughly twenty times sooner than the
    // declared budget. The heartbeat is what makes the budget real.
    expect(cmd).toContain("waiting for the shared mise lock");
    expect(cmd).toContain(`[ "$__tanren_mise_waited" -lt ${String(MISE_LOCK_WAIT_SECONDS)} ]`);
    // A `mise install` that FAILS under the lock is re-raised, not overwritten by the
    // lock-sentinel test that used to be the construct's last command.
    expect(cmd).toContain("|| __tanren_mise_rc=$?");
    expect(cmd).toContain('exit "$__tanren_mise_rc"');
    // Same run, same per-run config export as every other mise-touching command.
    expect(cmd).toContain('MISE_GLOBAL_CONFIG_FILE="/workspace/runs/run_alpha/tanren-mise-config.toml"');
  });
});

describe("the shared-mise-state defect · what must NOT be in the built commands any more", () => {
  it("never names the runner-wide marker two concurrent runs used to collide on", () => {
    // NEGATIVE CONTROL for bug 3. `$HOME/.tanren-toolchain-provisioned` was written by
    // whichever run provisioned first and then read by all three.
    for (const command of [
      withMiseActivation("just bootstrap", RUN_A),
      withMiseActivation("just bootstrap", RUN_B),
      miseProvisionCommand(RUN_A),
    ]) {
      expect(command).not.toContain(".tanren-toolchain-provisioned");
    }
  });

  it("never leaves a mise command on the runner-wide DEFAULT global config", () => {
    // NEGATIVE CONTROL for bug 2. Every branch that runs `mise` must first pin
    // MISE_GLOBAL_CONFIG_FILE; a branch that forgets falls back to
    // /home/tanren/.config/mise/config.toml, which is shared by all three runs.
    const wrapped = withMiseActivation("just bootstrap", RUN_A);
    // BOTH prelude branches export it — the repo-mise.toml one and the Tanren-provisioned
    // one — so neither can silently read the runner-wide config another run just wrote.
    expect(wrapped.split('MISE_GLOBAL_CONFIG_FILE="').length - 1).toBe(2);
    expect(wrapped.indexOf("MISE_GLOBAL_CONFIG_FILE=")).toBeLessThan(wrapped.indexOf("mise activate"));
    expect(wrapped.lastIndexOf("MISE_GLOBAL_CONFIG_FILE=")).toBeLessThan(wrapped.indexOf("mise env -s bash"));
    expect(wrapped).not.toContain("/home/tanren/.config/mise/config.toml");
  });

  it("activates on THIS run's marker and THIS run's config, and no other run's", () => {
    const wrapped = withMiseActivation("just bootstrap", RUN_A);
    // The per-run activation trigger, spelled out: the marker the same run's provision
    // wrote (toolchainProvision.ts `: > "<marker>"`), inside the run's own sandbox.
    expect(wrapped).toContain('[ -f "/workspace/runs/run_alpha/tanren-mise-provisioned" ]');
    expect(wrapped).toContain('MISE_GLOBAL_CONFIG_FILE="/workspace/runs/run_alpha/tanren-mise-config.toml"');
    // A sibling run's state is nowhere in it.
    expect(wrapped).not.toContain("run_bravo");
    // …and the reverse holds, so neither run is privileged by construction.
    expect(withMiseActivation("just bootstrap", RUN_B)).not.toContain("run_alpha");
  });
});

// REGRESSION — the runner image bakes a warm mise baseline into a shared dir and
// publishes its location via `/etc/profile.d/tanren-mise-shared-dir.sh`. A non-login
// `ssh exec` sources no profile script, and sshd forwards none of the image ENV (no
// SetEnv / AcceptEnv / PermitUserEnvironment on the runner), so nothing reached the
// engine: every mise call fell back to mise's `$HOME` defaults, the baked baseline was
// never used, and the toolchain landed in an unpinned dir shared by every concurrent run.
describe("mise reaches the shared data/cache dirs the runner image publishes", () => {
  it("EVERY mise seam sources the image's published script — the SAME one", () => {
    // Install-where-activation-reads. If the seams ever diverge — or one stops sourcing —
    // `mise install` writes somewhere `mise activate --shims` will not look, and a bare
    // `pnpm` is `not found` again. They share one preamble so they cannot drift apart.
    const prelude = miseSharedDirPrelude();
    expect(withMiseActivation("pnpm install", RUN_A)).toContain(prelude);
    expect(miseProvisionCommand(RUN_A)).toContain(prelude);
    expect(prelude).toContain(". /etc/profile.d/tanren-mise-shared-dir.sh");
  });

  it("sources BEFORE mise runs, in every seam (a pin after the command is no pin at all)", () => {
    const provision = miseProvisionCommand(RUN_A);
    expect(provision).toContain("tanren-mise-shared-dir.sh");
    expect(provision.indexOf("tanren-mise-shared-dir.sh")).toBeLessThan(provision.indexOf("mise trust"));
    const activation = withMiseActivation("pnpm install", RUN_A);
    expect(activation).toContain("tanren-mise-shared-dir.sh");
    expect(activation.indexOf("tanren-mise-shared-dir.sh")).toBeLessThan(activation.indexOf("mise activate"));
  });

  it("NEGATIVE CONTROL: reads the substrate's own declaration, never an invented path", () => {
    // The fail-open this blocks. Two of them, in fact:
    //   1. An unconditional `export MISE_DATA_DIR=/opt/tanren/mise` would point every
    //      `manual_ssh` host and every non-Tanren runner image at a dir that does not
    //      exist. So the engine hard-codes NO mise dir — it sources the script the image
    //      itself wrote, and the VALUES stay the image's to choose.
    //   2. Reading `$TANREN_MISE_DATA_DIR` instead would be a silent no-op on the real
    //      path: that variable is the sshd DAEMON's environment, which sshd does not
    //      forward into the session. A container-exec probe shows it set; over ssh it is
    //      empty. Assert the prelude does not depend on it.
    const prelude = miseSharedDirPrelude();
    expect(prelude).toContain("[ -r /etc/profile.d/tanren-mise-shared-dir.sh ]");
    expect(prelude).not.toContain("TANREN_MISE_DATA_DIR");
    expect(prelude).not.toContain("export MISE_DATA_DIR");
    expect(prelude).not.toContain("export MISE_CACHE_DIR");
  });

  it("is `set -e` safe — a runner without the script must not abort the command", () => {
    // The provision command runs as `set -e; <provision>`. A `[ -r … ] && . …` chain
    // returns 1 when the file is absent, which under `set -e` would kill the whole
    // command on exactly the runners this is supposed to leave alone. It must be `if/fi`.
    const prelude = miseSharedDirPrelude();
    expect(prelude.startsWith("if [ -r ")).toBe(true);
    expect(prelude.trimEnd().endsWith("fi;")).toBe(true);
    expect(prelude).not.toContain("&& .");
  });

  it("stays a no-op for a project that declared no toolchain (lives inside the activation guard)", () => {
    const wrapped = withMiseActivation("echo hi", RUN_A);
    expect(wrapped).toContain("fi; echo hi");
    expect(wrapped.indexOf("[ -f 'mise.toml' ]")).toBeLessThan(wrapped.indexOf("tanren-mise-shared-dir.sh"));
  });

  it("SHARES the data dir across runs while the config stays per-run — both, on purpose", () => {
    // The shared dir is what makes the image's warm baseline worth baking; the per-run
    // config is what stops run B's toolchain being activated for run A. Isolating the
    // data dir too would cold-download the whole toolchain on every run, so the shared
    // WRITES are serialised with `flock` instead (see the lock-scope tests above).
    const a = withMiseActivation("just bootstrap", RUN_A);
    const b = withMiseActivation("just bootstrap", RUN_B);
    const prelude = miseSharedDirPrelude();
    expect(a).toContain(prelude);
    expect(b).toContain(prelude);
    expect(a).toContain(miseRunScope(RUN_A).configFile);
    expect(b).not.toContain(miseRunScope(RUN_A).configFile);
  });
});

describe("the HARNESS / codex path is NEVER mise-activated (stays on the runner's isolated node)", () => {
  const codexInput = { codexHome: "/home/tanren/.codex/run_x", workspace: "/ws/run_x/repo" };

  it("the codex writer exec command contains NO mise activation", () => {
    const cmd = buildCodexExecCommand(codexInput);
    expect(cmd).toContain("codex exec");
    expect(cmd).not.toContain("mise activate");
    expect(cmd).not.toContain("mise install");
    expect(cmd).not.toContain("mise.toml");
  });

  it("the codex answerer exec command contains NO mise activation", () => {
    const cmd = buildCodexAnswererExecCommand({
      ...codexInput,
      schemaPath: "/home/tanren/.codex/run_x/v.schema.json",
      outputPath: "/home/tanren/.codex/run_x/v.response.json",
    });
    expect(cmd).toContain("codex exec");
    expect(cmd).not.toContain("mise activate");
    expect(cmd).not.toContain("mise install");
    expect(cmd).not.toContain("mise.toml");
  });
});
