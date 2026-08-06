// env P0b/c — the project-command-vs-harness two-path separation for mise.
//
// The crux of wiring point 5: the PROJECT's gate/bootstrap commands run mise-ACTIVATED
// (so a bare `node`/`pnpm` resolves to the project's `mise.toml`-declared toolchain),
// while the HARNESS path (codex writer + answerer) is NEVER mise-activated (it keeps
// the runner's isolated node, per P0a). These tests pin both halves:
//   - `withMiseActivation` prefixes the project command with a guarded NON-INTERACTIVE
//     `mise activate bash --shims` (NOT the interactive hook mode — see below);
//   - `miseProvisionCommand` is a guarded `mise trust && mise install`;
//   - the codex exec command builders contain NO mise activation (the harness path).

import { describe, expect, it } from "vitest";
import { miseProvisionCommand, miseSharedDirPrelude, withMiseActivation } from "../src/engine/ssh/miseActivate.js";
import { buildCodexAnswererExecCommand, buildCodexExecCommand } from "../src/engine/providers/codexExecCommand.js";

describe("withMiseActivation · the PROJECT-command path is mise-activated", () => {
  it("prefixes the command with a NON-INTERACTIVE `--shims` activate, guarded on a mise.toml", () => {
    const wrapped = withMiseActivation("pnpm install");
    // SHIMS / non-interactive activation: `--shims` emits a plain POSIX
    // `export PATH="…/shims:$PATH"` that IMMEDIATELY puts the toolchain on PATH for the
    // rest of the `bash -c`/`sh -c` command. This is the crux of the fix.
    expect(wrapped).toContain('eval "$(mise activate bash --shims)"');
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
    const wrapped = withMiseActivation("echo hi");
    expect(wrapped).toContain("fi; echo hi");
    expect(wrapped).not.toContain("fi && echo hi");
  });
});

describe("miseProvisionCommand · workspace-prep provisions the declared toolchain", () => {
  it("is a guarded `mise trust && mise install`, loud (no silent skip on a real failure)", () => {
    const cmd = miseProvisionCommand();
    expect(cmd).toContain("mise trust 'mise.toml'");
    expect(cmd).toContain("mise install");
    // trust THEN install, chained with `&&` so a failed trust aborts before install
    // (and the caller runs it under `set -e`, so a failed install is a LOUD halt).
    expect(cmd.indexOf("mise trust")).toBeLessThan(cmd.indexOf("mise install"));
    // GUARDED on the mise.toml being present so a no-toolchain project is a no-op skip.
    expect(cmd).toContain("[ -f 'mise.toml' ]");
    expect(cmd).toContain("skipping mise install");
  });
});

// REGRESSION — the runner image bakes a warm mise baseline into a shared dir and
// publishes its location via `/etc/profile.d/tanren-mise-shared-dir.sh`. A non-login
// `ssh exec` sources no profile script, and sshd forwards none of the image ENV (no
// SetEnv / AcceptEnv / PermitUserEnvironment on the runner), so nothing reached the
// engine: every mise call fell back to mise's `$HOME` defaults, the baked baseline was
// never used, and the toolchain landed in an unpinned dir shared by every concurrent run.
describe("mise reaches the shared data/cache dirs the runner image publishes", () => {
  it("BOTH mise seams source the image's published script — the SAME one", () => {
    // Install-where-activation-reads. If the two seams ever diverge — or one stops
    // sourcing — `mise install` writes somewhere `mise activate --shims` will not look,
    // and a bare `pnpm` is `not found` again.
    const prelude = miseSharedDirPrelude();
    expect(withMiseActivation("pnpm install")).toContain(prelude);
    expect(miseProvisionCommand()).toContain(prelude);
    expect(prelude).toContain(". /etc/profile.d/tanren-mise-shared-dir.sh");
  });

  it("sources BEFORE mise runs, in both seams (a pin after the command is no pin at all)", () => {
    const provision = miseProvisionCommand();
    expect(provision).toContain("tanren-mise-shared-dir.sh");
    expect(provision.indexOf("tanren-mise-shared-dir.sh")).toBeLessThan(provision.indexOf("mise trust"));
    const activation = withMiseActivation("pnpm install");
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

  it("stays a no-op for a project that declared no toolchain (lives inside the mise.toml guard)", () => {
    const wrapped = withMiseActivation("echo hi");
    expect(wrapped).toContain("fi; echo hi");
    expect(wrapped.indexOf("[ -f 'mise.toml' ]")).toBeLessThan(wrapped.indexOf("tanren-mise-shared-dir.sh"));
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
