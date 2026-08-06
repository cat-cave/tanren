// APP-ENV REDACTION at the workspace doors (CWE-532).
//
// Both app-env doors — `bootstrapWorkspace` and `ensureWorkspaceDepsInstalled` — are
// careful that the `export K='v'; …` prelude never touches the `command` field the typed
// error carries, and each said so in a comment: "no app-secret value can reach the error
// message or the emitted event payload". That was only ever true of the COMMAND. The same
// errors also carry `outputTail`, which is the PROJECT's own stdout+stderr captured with
// the app env in scope, and a `just bootstrap` that echoes a variable (a `set -x`, a curl
// with the token on the argv, a stack trace quoting a DSN) put the VALUE straight into
// `WorkspaceBootstrapError.message` / `WorkspaceDepsInstallError.message`, and from there
// into the `workspace.failed` / `run.failed` payloads.
//
// These pin the redaction at BOTH doors — a redaction that covers one of two call sites is
// a redaction an operator cannot rely on — plus the two edges that decide whether it is
// usable at all: the minimum length below which redacting would shred the diagnostic while
// protecting nothing, and the longest-first ordering that stops a value containing another
// from being left half-exposed.

import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { sshRunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import {
  bootstrapWorkspace,
  ensureWorkspaceDepsInstalled,
  WorkspaceBootstrapError,
  WorkspaceDepsInstallError,
} from "../src/engine/workspace/index.js";

const target: RunnerHandle = sshRunnerHandle({
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
});
const WORKSPACE = "/workspace/runs/run_redact/repo";

/**
 * A substrate whose PROJECT step fails having printed `output` on stdout.
 *
 * The deps-ensure door is no longer one round-trip: it first probes the repo's toolchain
 * DECLARATION files and only then builds + runs the guarded install. That probe must
 * SUCCEED, or `resolveWorkspaceToolchain` throws `WorkspaceMiseProvisionError` and these
 * tests would never reach the door they are about. So it is answered as "this workspace
 * declares nothing Tanren recognizes" (exit 0, no frames) and every other round-trip is
 * the failing project step.
 */
class EchoingSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  constructor(private readonly output: string) {}
  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    if (command.command.includes("TANREN-TOOLCHAIN-DECLARATION")) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 1, stdout: this.output, stderr: "" };
  }
}

/** Drive `bootstrapWorkspace` to its failure and hand back the typed error. */
async function failedBootstrap(ssh: EchoingSsh, appEnv?: Record<string, string>): Promise<WorkspaceBootstrapError> {
  const error = await bootstrapWorkspace({
    ssh,
    target,
    workspacePath: WORKSPACE,
    command: "just bootstrap",
    appEnv,
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(WorkspaceBootstrapError);
  return error as WorkspaceBootstrapError;
}

/** Drive `ensureWorkspaceDepsInstalled` to its failure and hand back the typed error. */
async function failedDepsInstall(ssh: EchoingSsh, appEnv?: Record<string, string>): Promise<WorkspaceDepsInstallError> {
  const error = await ensureWorkspaceDepsInstalled({
    ssh,
    target,
    workspacePath: WORKSPACE,
    command: "just bootstrap",
    appEnv,
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(WorkspaceDepsInstallError);
  return error as WorkspaceDepsInstallError;
}

describe("a failed bootstrap cannot print an injected app-env SECRET into the error or the events", () => {
  it("redacts every injected app-env value out of the captured output tail", async () => {
    const secret = "sk-live-9f2c4a8e1b7d";
    const ssh = new EchoingSsh(`connecting with API_TOKEN=${secret}\ncurl: (6) Could not resolve host`);
    const typed = await failedBootstrap(ssh, { API_TOKEN: secret, MODE: "dev" });

    expect(typed.outputTail).not.toContain(secret);
    // `.message` is the string that actually travels: it is what `workspace.failed` and
    // `run.failed` carry, so a clean `outputTail` with a leaky message would fix nothing.
    expect(typed.message).not.toContain(secret);
    // Redacted, not deleted: the operator still gets a legible diagnostic, and is told
    // WHICH variable was removed so they know where to look.
    expect(typed.outputTail).toContain("[redacted:API_TOKEN]");
    expect(typed.outputTail).toContain("Could not resolve host");
    // …and the ORIGINAL command survives, prelude-free — the half that was already true.
    expect(typed.command).toBe("just bootstrap");
    // THE TEST WOULD OTHERWISE BE VACUOUS. If `appEnv` were quietly dropped instead of
    // materialized, every assertion above would still pass while the door leaked nothing
    // because it injected nothing. This is the proof that the value really was in scope
    // for the step whose output was just redacted.
    expect(ssh.commands[0]?.command).toContain(secret);
  });

  it("leaves a value UNDER the threshold alone — 7 characters untouched, 8 redacted", async () => {
    // `dev`, `1`, `true`: bytes that appear all over ordinary build output. Redacting them
    // would shred the diagnostic and hide no secret. The threshold is 8 characters, so the
    // boundary itself is asserted from BOTH sides — a threshold tested only from one side
    // is an off-by-one nobody notices until a real secret sits exactly on it.
    const typed = await failedBootstrap(new EchoingSsh("mode=dev region=eu-west build=c0ffee01 failed"), {
      MODE: "dev",
      REGION: "eu-west",
      BUILD: "c0ffee01",
    });

    expect(typed.outputTail).toContain("mode=dev");
    expect(typed.outputTail).not.toContain("[redacted:MODE]");
    // 7 characters — the last value the diagnostic keeps.
    expect(typed.outputTail).toContain("region=eu-west");
    expect(typed.outputTail).not.toContain("[redacted:REGION]");
    // 8 characters — exactly at the threshold, and therefore redacted.
    expect(typed.outputTail).toContain("[redacted:BUILD]");
    expect(typed.outputTail).not.toContain("c0ffee01");
  });

  it("redacts LONGEST-FIRST so a value containing another is not left half-exposed", async () => {
    // The ordering defect this catches: `API_TOKEN_PREFIX`'s value is a strict prefix of
    // `API_TOKEN`'s. Shortest-first replaces the prefix and leaves the REMAINDER of the
    // real token sitting in the tail — a redaction marker with live secret bytes stuck to
    // it, which reads as safe and is not.
    const token = "sk-live-9f2c4a8e1b7d";
    const prefix = "sk-live-9f2c";
    const typed = await failedBootstrap(new EchoingSsh(`Authorization: Bearer ${token}\n401 Unauthorized`), {
      API_TOKEN_PREFIX: prefix,
      API_TOKEN: token,
    });

    expect(typed.outputTail).toContain("[redacted:API_TOKEN]");
    expect(typed.outputTail).not.toContain("[redacted:API_TOKEN_PREFIX]");
    // THE ASSERTION THAT CATCHES IT: not "the whole token is gone" (a shortest-first pass
    // makes that true too, by mangling it) but "the REMAINDER a shortest-first pass would
    // have left behind is gone".
    expect(typed.outputTail).not.toContain("4a8e1b7d");
    expect(typed.outputTail).not.toContain(token);
    expect(typed.outputTail).toContain("401 Unauthorized");
  });

  it("NEGATIVE CONTROL: with no appEnv the tail passes through BYTE-IDENTICAL", async () => {
    // The redaction must not be a diagnostic tax on the (common) no-app-env run: with
    // nothing injected there is nothing Tanren knows to remove, and the operator's output
    // must arrive exactly as the project printed it — not merely "close enough".
    const output = "installing dependencies\nerror: command failed with exit code 1.";
    const typed = await failedBootstrap(new EchoingSsh(output));
    expect(typed.outputTail).toBe(output);
    expect(typed.message).toContain(output);
  });
});

describe("the per-gate deps-install door redacts the SAME way (one door covered is not a fix)", () => {
  it("WorkspaceDepsInstallError carries a redacted output tail AND a redacted message", async () => {
    // The door that runs before EVERY gate, not just once at workspace-prep — so it is the
    // one with the most chances to print a secret, and the one a fix applied only at
    // `bootstrapWorkspace` would leave wide open.
    const secret = "postgres://tanren:hunter2hunter2@db.internal:5432/app";
    const ssh = new EchoingSsh(`+ node scripts/migrate.js --url ${secret}\nerror: connection to server failed`);
    const typed = await failedDepsInstall(ssh, { DATABASE_URL: secret });

    expect(typed.outputTail).not.toContain(secret);
    // The password alone, in case a partial replacement ever leaves the credential behind
    // while removing the URL around it.
    expect(typed.outputTail).not.toContain("hunter2hunter2");
    expect(typed.message).not.toContain(secret);
    expect(typed.outputTail).toContain("[redacted:DATABASE_URL]");
    // Still a usable diagnostic, and still the ORIGINAL (prelude-free) command.
    expect(typed.outputTail).toContain("connection to server failed");
    expect(typed.command).toBe("just bootstrap");
    // Round-trip 1 is the declaration probe; round-trip 2 is the guarded install, and it
    // is the one that carried the app env — without which this test proves nothing.
    expect(ssh.commands).toHaveLength(2);
    expect(ssh.commands[1]?.command).toContain(secret);
  });

  it("NEGATIVE CONTROL: with no appEnv the deps-install tail passes through BYTE-IDENTICAL", async () => {
    // Deliberately NOT a `…: not found` output: that is claimed by the missing-binary
    // triage and leaves through `WorkspaceToolchainUnavailableError` instead, which would
    // quietly stop this from testing the door it names.
    const output = "tanren: deps-ensure installing\nERR_PNPM_OUTDATED_LOCKFILE";
    const typed = await failedDepsInstall(new EchoingSsh(output));
    expect(typed.outputTail).toBe(output);
    expect(typed.message).toContain(output);
  });
});
