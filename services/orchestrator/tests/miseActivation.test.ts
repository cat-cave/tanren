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
import { miseProvisionCommand, withMiseActivation } from "../src/engine/ssh/miseActivate.js";
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
