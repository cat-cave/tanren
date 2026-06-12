// Environment management (environment-management.md §4 + §7 P4) — the ENV-IMAGE
// VALIDATION HARNESS, the env-layer counterpart of `templates/validationHarness.ts`.
// It runs OVER a freshly-built env image (on a runner allocated FROM that image, or a
// `docker run` of it) and produces an `EnvironmentValidationProof` — the canonical
// manifest proof shape, assignable straight to `environments.validation_proof`.
//
// Two stages, in order (mirroring the template harness's positive→negative shape):
//   1. POSITIVE SMOKE — for EVERY declared tool, `mise exec -- <tool> --version`
//      exits 0 AND reports the LOCKED version (the version the project declared in its
//      `mise.toml`). A tool that does not resolve, exits non-zero, or reports a
//      DIFFERENT version fails the smoke (the env did not bake what it promised).
//   2. NEGATIVE CONTROLS (isolation — non-optional) — the two probes from
//      ./envNegativeControls.ts: an UNDECLARED baseline tool must NOT resolve
//      (`mise which`/`mise exec` fails) and a FORBIDDEN version of a declared tool must
//      NOT resolve. A control whose defect is NOT caught (the leak resolved) is
//      `unproven`; a control whose defect IS caught (the leak is absent) is `proven`.
//
// The env image ships `mise` + the project's `mise.toml` baked in (the build driver
// runs `mise trust && mise install` at build time), so the harness probes through
// `mise exec`/`mise which` in the workspace where the `mise.toml` lives. The
// commands run over the SAME `CommandSubstrate` seam the template harness uses; the
// caller (createEnvironment) allocates the runner + supplies the handle + workspace.

import type { RunnerHandle } from "../../contracts/allocator.js";
import type { CommandSubstrate } from "../../contracts/commandSubstrate.js";
import { quoteSshShellArg } from "../../ssh/command.js";
import type { ProjectToolchain } from "../../config/projectConfig.js";
import type { EnvironmentValidationProof, EnvNegativeControlResult } from "../manifest.js";
import { buildEnvNegativeControlPlan, type EnvNegativeControl } from "./envNegativeControls.js";

export interface EnvValidationHarnessInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  // The workspace on the runner where the env's `mise.toml` lives — the cwd the
  // smoke + isolation probes run in (so `mise` resolves the env's locked toolchain).
  // The build driver materializes the `mise.toml` here (or the image bakes it at this
  // path and the harness `cd`s in).
  workspacePath: string;
  // The project's declared toolchain (tool → locked version-spec) — the smoke asserts
  // each resolves to ITS declared version, and the isolation controls are derived from
  // it. Must be NON-EMPTY (an empty toolchain never reaches the JIT-build path).
  toolchain: ProjectToolchain;
  // The clock — passed so the proof's validatedAt is deterministic in tests.
  now: () => Date;
  // Per-command timeout.
  timeoutMs: number;
}

// Run the full env validation harness → the proof. Stages run in order; even when the
// positive smoke fails we still run the isolation controls so the proof records WHICH
// isolation defect (if any) the env also has, but the verdict (envValidationProof.ts)
// already fails on the smoke.
export async function runEnvValidationHarness(input: EnvValidationHarnessInput): Promise<EnvironmentValidationProof> {
  const positiveSmokePassed = await runPositiveSmoke(input);

  const plan = buildEnvNegativeControlPlan(input.toolchain);
  const undeclaredToolAbsent = await runUndeclaredToolControl(input, plan.undeclaredTool);
  const forbiddenVersionAbsent = await runForbiddenVersionControl(input, plan.forbiddenVersion);

  return {
    positiveSmokePassed,
    negativeControls: { undeclaredToolAbsent, forbiddenVersionAbsent },
    validatedAt: input.now().toISOString(),
  };
}

// STAGE 1 — POSITIVE SMOKE. For each declared tool, assert `mise exec -- <tool>
// --version` exits 0 AND the declared version-spec appears in its `mise ls`/exec
// output. We resolve the version via `mise ls --installed` (the locked install) and
// assert the declared spec is what mise resolved — a tool resolving to a DIFFERENT
// version (the env baked the wrong thing) fails the smoke. Short-circuits on the
// first failure (a single tool that did not bake means the env is not valid).
async function runPositiveSmoke(input: EnvValidationHarnessInput): Promise<boolean> {
  for (const { name: tool, version: declaredSpec } of input.toolchain) {
    const ok = await toolResolvesToLockedVersion(input, tool, declaredSpec);
    if (!ok) {
      return false;
    }
  }
  return true;
}

// One tool's smoke: it must RESOLVE (mise knows it) and RUN (`--version` exit 0) at
// the LOCKED version. `mise ls --installed --json` reports the resolved version for a
// requested tool; we assert the declared spec matches the resolved version (a loose
// major `24` matches a resolved `24.x`; an exact `24.2.0` matches exactly). The
// `--version` exec proves the tool genuinely runs, not just that mise lists it.
async function toolResolvesToLockedVersion(
  input: EnvValidationHarnessInput,
  tool: string,
  declaredSpec: string,
): Promise<boolean> {
  // `mise exec -- <tool> --version` — proves the tool resolves AND runs. A non-zero
  // exit (mise could not resolve it / the tool errored) fails the smoke.
  const exec = await input.ssh.run(input.target, {
    command: `set -e; export MISE_YES=1; mise exec -- ${quoteSshShellArg(tool)} --version`,
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
  });
  if (exec.failure !== undefined || exec.timedOut || exec.exitCode !== 0) {
    return false;
  }
  // The tool ran — now assert mise RESOLVED the LOCKED version (the env baked what was
  // declared, not a stray version). `mise ls --installed` lists `<tool> <resolved>`;
  // we assert a line for the tool whose resolved version is prefixed by the declared
  // loose-major spec (`24` ⊑ `24.7.1`) or equals an exact spec. This catches an env
  // that resolved the WRONG version even though SOME version ran.
  const ls = await input.ssh.run(input.target, {
    command: `export MISE_YES=1; mise ls --installed ${quoteSshShellArg(tool)} 2>/dev/null || mise ls --installed 2>/dev/null`,
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
  });
  if (ls.failure !== undefined || ls.timedOut || ls.exitCode !== 0) {
    return false;
  }
  return resolvedVersionMatchesSpec(ls.stdout, tool, declaredSpec);
}

// Does the `mise ls --installed` output show `<tool>` resolved to a version that
// satisfies the declared spec? mise prints `<tool>  <version>  …` lines. We find the
// tool's line(s) and assert at least one resolved version STARTS WITH the declared
// loose-major (`24` → `24.7.1`) or equals the declared exact spec. A loose-major spec
// must match on a version boundary (`2` must not match `24.x`), so we compare against
// the dotted segments. Tanren parses no semver — this is a prefix-on-dot-boundary
// check, deliberately conservative.
export function resolvedVersionMatchesSpec(lsOutput: string, tool: string, declaredSpec: string): boolean {
  const spec = declaredSpec.trim();
  const lines = lsOutput
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (const line of lines) {
    // A mise ls line is whitespace-separated columns: `node  24.7.1  ~/.../mise.toml`.
    const cols = line.split(/\s+/u).filter((c) => c.length > 0);
    if (cols[0] !== tool) {
      continue;
    }
    const resolved = cols[1];
    if (resolved === undefined) {
      continue;
    }
    if (versionSatisfiesSpec(resolved, spec)) {
      return true;
    }
  }
  return false;
}

// A resolved version satisfies a declared spec when it EQUALS the spec or the spec is
// a DOTTED PREFIX of it (a loose major/minor: `24` ⊑ `24.7.1`, `3.14` ⊑ `3.14.2`, but
// `2` does NOT match `24.7.1` because the boundary after `2` is `4`, not `.`). This is
// the conservative "the locked version is a refinement of the declared spec" rule.
function versionSatisfiesSpec(resolved: string, spec: string): boolean {
  if (resolved === spec) {
    return true;
  }
  return resolved.startsWith(`${spec}.`);
}

// STAGE 2a — UNDECLARED-TOOL-ABSENT. The undeclared (baseline/sentinel) tool must NOT
// resolve through the env's mise toolchain: `mise which <tool>` fails AND `mise exec
// -- <tool> --version` is non-zero. If EITHER resolves, the golden base leaked → the
// control is `unproven` (validation fails). If neither resolves, the env is isolated →
// `proven`. A substrate failure running the probe cannot be a quiet `proven` — it is
// `unproven` (we could not prove isolation).
async function runUndeclaredToolControl(
  input: EnvValidationHarnessInput,
  control: EnvNegativeControl,
): Promise<EnvNegativeControlResult> {
  // `mise which` resolves a tool to its shim path; a non-zero exit means mise does NOT
  // provide it. `mise exec -- <tool> --version` is the runtime corroboration. The tool
  // is ABSENT (isolation proven) iff BOTH fail to resolve it.
  const result = await input.ssh.run(input.target, {
    command:
      `export MISE_YES=1; ` +
      `if mise which ${quoteSshShellArg(control.tool)} >/dev/null 2>&1; then echo RESOLVED; ` +
      `elif mise exec -- ${quoteSshShellArg(control.tool)} --version >/dev/null 2>&1; then echo RESOLVED; ` +
      `else echo ABSENT; fi`,
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
  });
  if (result.failure !== undefined || result.timedOut || result.exitCode !== 0) {
    // The probe itself could not run — we cannot PROVE isolation, so it is unproven
    // (never a silent pass).
    return "unproven";
  }
  // ABSENT ⇒ the undeclared tool does not resolve ⇒ isolation proven. RESOLVED ⇒ the
  // env leaked the baseline tool ⇒ unproven.
  return result.stdout.includes("ABSENT") && !result.stdout.includes("RESOLVED") ? "proven" : "unproven";
}

// STAGE 2b — FORBIDDEN-VERSION-ABSENT. A WRONG version of a DECLARED tool must NOT be
// resolvable: `mise exec <tool>@<forbiddenVersion> -- <tool> --version` must FAIL
// (mise cannot resolve the forbidden version). If it SUCCEEDS, the env resolved a
// version the project never locked → `unproven`. If it fails (mise rejects the
// forbidden version), the env pins only the locked version → `proven`.
async function runForbiddenVersionControl(
  input: EnvValidationHarnessInput,
  control: EnvNegativeControl,
): Promise<EnvNegativeControlResult> {
  const forbidden = control.forbiddenVersion ?? "0.0.0";
  const result = await input.ssh.run(input.target, {
    command:
      `export MISE_YES=1; ` +
      `if mise exec ${quoteSshShellArg(`${control.tool}@${forbidden}`)} -- ${quoteSshShellArg(control.tool)} --version >/dev/null 2>&1; then ` +
      `echo RESOLVED; else echo ABSENT; fi`,
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
  });
  if (result.failure !== undefined || result.timedOut || result.exitCode !== 0) {
    return "unproven";
  }
  return result.stdout.includes("ABSENT") && !result.stdout.includes("RESOLVED") ? "proven" : "unproven";
}
