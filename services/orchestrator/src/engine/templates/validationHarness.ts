// The TEMPLATE VALIDATION HARNESS — the "meaningful, not green-by-accident" proof
// (docs/roadmap/templating-system.md §2.4 / §4). It runs OVER a conforming template
// repo (a `justfile` + `.tanren/ci.yml`, see stack-flexible-contract.md) on an
// allocated runner and produces a `ValidationProof`. It REUSES the existing native
// gate runner (`../workflow/gate`) + the resolved CI config — it does NOT reinvent
// gate execution.
//
// Three stages, in order:
//   1. POSITIVE controls — `just bootstrap`, then each declared tier + `just build`,
//      ALL must pass over the template (proving the gates run green on a clean tree).
//   2. NEGATIVE controls (the core) — for each DECLARED gate capability, plant a
//      temporary defect in a SCRATCH COPY and assert the gate CATCHES it (fails),
//      then discard the copy. A gate that PASSES despite the defect is `unproven`
//      (the v29 no-op-typecheck failure mode); a gate that FAILS is `proven`; an
//      undeclared capability is `n/a`.
//   3. AUDITOR — run the spec-loop auditor over the template (injected seam) and
//      assert no open P0/P1 → `auditorClean`.
//
// `templateValidates(proof)` (../templates/validationProof.ts) is the final verdict:
// positive pass + every declared negative control proven + auditor clean.

import { bootstrapCommand, type CiConfigV1, tiersFor } from "../ci/index.js";
import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { runGateForWhen } from "../workflow/gate/runGateForWhen.js";
import type { GateAppendEvent } from "../workflow/gate/runGateTier.js";
import { type GateInvocation, type NegativeControl } from "./negativeControls.js";
import { createScratchCopy, removeScratchCopy, type ScratchCopyDeps, writeDefectFiles } from "./scratchCopy.js";
import { type NegativeControls, type NegativeControlVerdict, type ValidationProof } from "./validationProof.js";

// The auditor seam: returns the number of OPEN P0/P1 findings over the template (0 ⇒
// clean). Injected so the harness is testable without a live LLM and so it reuses the
// real spec-loop auditor (../workflow/auditor) at the call site. A throw is a LOUD
// failure (auditorClean cannot be asserted), surfaced as an error result — never a
// silent "clean".
export interface TemplateAuditor {
  openBlockingFindings(input: { workspacePath: string; baselineSha: string }): Promise<number>;
}

export interface ValidationHarnessInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  // The bootstrapped template workspace on the runner (positive controls run here).
  workspacePath: string;
  // Where scratch copies of the template are made for the negative-control pass. Each
  // control gets a unique subdir under this; the harness removes each after use. Pass
  // a workspace-local path (reaper-protected + torn down with the run).
  scratchRoot: string;
  // The resolved CI config for the template (from resolveGateConfig over the repo).
  config: CiConfigV1;
  // The negative controls to run, ONE per declared capability. Capabilities NOT
  // present here are recorded `n/a`. The caller builds these from the template's
  // declared capabilities + lifecycle (see negativeControls.ts default injectors).
  negativeControls: ReadonlyArray<NegativeControl>;
  // The deploy/build step is `just build` by convention; overridable for a stack that
  // names it differently. Run as the final positive control.
  buildStep?: { name: string; run: string };
  // The auditor seam (stage 3).
  auditor: TemplateAuditor;
  // The template commit the proof is anchored on.
  validatedSha: string;
  // The clock — Date.now() is unavailable in some contexts, so the caller passes it.
  now: () => Date;
  timeoutMs: number;
  // The event sink the harness narrates through — the SAME store the gate runner uses,
  // so the positive/negative gate runs land in the run's timeline. Required: the
  // harness runs the real gate runner (which emits gate.* events), so an absent sink
  // would silently swallow them. Tests pass a recording sink.
  appendEvent: GateAppendEvent;
}

// The default build positive control (`just build`).
const DEFAULT_BUILD_STEP = { name: "build", run: "just build" } as const;

// Run the full validation harness and produce the proof. Stages run in order; a stage
// that cannot run is a LOUD failure (positive controls / scratch-copy errors throw;
// the auditor throwing surfaces as auditorClean=false with the error rethrown), never
// a quiet pass.
export async function runValidationHarness(input: ValidationHarnessInput): Promise<ValidationProof> {
  // Stage 1: POSITIVE controls.
  const positiveControlsPassed = await runPositiveControls(input, input.appendEvent);

  // Stage 2: NEGATIVE controls. Even if positive controls failed we still run these so
  // the proof records WHICH gates are no-ops (a template that fails its own clean
  // build AND has a no-op typecheck should report both), but the verdict already fails.
  const negativeControls = await runNegativeControls(input);

  // Stage 3: AUDITOR.
  const openBlocking = await input.auditor.openBlockingFindings({
    workspacePath: input.workspacePath,
    baselineSha: input.validatedSha,
  });
  const auditorClean = openBlocking === 0;

  return {
    positiveControlsPassed,
    negativeControls,
    auditorClean,
    validatedAt: input.now().toISOString(),
    validatedSha: input.validatedSha,
  };
}

// Stage 1: run `just bootstrap` (the config's declared bootstrap command), then every
// declared tier + `just build`, ALL must pass over the clean template. The tiers run
// through the gate-runner (reuse); bootstrap + build run as direct steps. A failure at
// any point fails the positive controls (short-circuits — later steps are pointless
// over a tree that won't bootstrap/gate clean).
async function runPositiveControls(input: ValidationHarnessInput, appendEvent: GateAppendEvent): Promise<boolean> {
  // `just bootstrap` (or whatever the config declares) FIRST — the tiers depend on a
  // bootstrapped tree. A template that declares no bootstrap skips this (the tiers
  // then carry their own setup), never a silent assumption.
  const bootstrap = bootstrapCommand(input.config);
  if (bootstrap !== undefined) {
    const result = await input.ssh.run(input.target, {
      command: bootstrap,
      cwd: input.workspacePath,
      timeoutMs: input.timeoutMs,
    });
    if (result.failure !== undefined || result.timedOut || result.exitCode !== 0) {
      return false;
    }
  }
  // Every lifecycle point's tiers must pass. We iterate the three points so a tier
  // mapped to any of them is exercised (a template declares tier-1/2/3 across
  // per_iteration/pre_audit/pre_merge).
  for (const when of ["per_iteration", "pre_audit", "pre_merge"] as const) {
    if (tiersFor(input.config, when).length === 0) {
      continue;
    }
    const outcome = await runGateForWhen({
      ssh: input.ssh,
      target: input.target,
      workspacePath: input.workspacePath,
      config: input.config,
      when,
      timeoutMs: input.timeoutMs,
      appendEvent,
    });
    if (!outcome.passed) {
      return false;
    }
  }
  // The build positive control.
  const build = input.buildStep ?? DEFAULT_BUILD_STEP;
  const result = await input.ssh.run(input.target, {
    command: build.run,
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
  });
  return result.failure === undefined && !result.timedOut && result.exitCode === 0;
}

// Stage 2: run every declared negative control over its own scratch copy, returning the
// per-capability verdict map (undeclared capabilities → "n/a").
async function runNegativeControls(input: ValidationHarnessInput): Promise<NegativeControls> {
  const verdicts: NegativeControls = { typecheck: "n/a", lint: "n/a", test: "n/a", mutation: "n/a" };
  const scratchDeps: ScratchCopyDeps = { ssh: input.ssh, target: input.target, timeoutMs: input.timeoutMs };
  let index = 0;
  for (const control of input.negativeControls) {
    verdicts[control.capability] = await runOneNegativeControl(input, scratchDeps, control, index);
    index += 1;
  }
  return verdicts;
}

// One negative control: copy the template → plant the defect → run the gate over the
// copy → "proven" iff the gate FAILED (caught the defect), else "unproven" → discard
// the copy. A scratch-copy error (copy/write) propagates LOUDLY — it cannot be a quiet
// "proven" or "unproven". The teardown always runs (finally).
async function runOneNegativeControl(
  input: ValidationHarnessInput,
  scratchDeps: ScratchCopyDeps,
  control: NegativeControl,
  index: number,
): Promise<NegativeControlVerdict> {
  const scratchPath = `${input.scratchRoot.replace(/\/+$/u, "")}/nc-${String(index)}-${control.capability}`;
  await createScratchCopy(scratchDeps, input.workspacePath, scratchPath);
  try {
    await writeDefectFiles(scratchDeps, scratchPath, control.defect.files);
    const gateFailed = await runGateForInvocation(input, scratchPath, control.invocation);
    // The gate CAUGHT the defect (failed) ⇒ proven. The gate PASSED despite the defect
    // ⇒ unproven (the no-op gate — the v29 scenario).
    return gateFailed ? "proven" : "unproven";
  } finally {
    await removeScratchCopy(scratchDeps, scratchPath);
  }
}

// Run a capability's gate over the scratch copy and report whether it FAILED. A tier
// invocation reuses the gate-runner over the copy; a step invocation runs the single
// declared command (mutation). "Failed" = the gate did not pass (nonzero / timeout /
// substrate failure all count — a gate that could not run cannot be a clean pass).
async function runGateForInvocation(
  input: ValidationHarnessInput,
  scratchPath: string,
  invocation: GateInvocation,
): Promise<boolean> {
  if (invocation.kind === "tier") {
    const outcome = await runGateForWhen({
      ssh: input.ssh,
      target: input.target,
      workspacePath: scratchPath,
      config: input.config,
      when: invocation.when,
      timeoutMs: input.timeoutMs,
      appendEvent: input.appendEvent,
    });
    return !outcome.passed;
  }
  const result = await input.ssh.run(input.target, {
    command: invocation.run,
    cwd: scratchPath,
    timeoutMs: input.timeoutMs,
  });
  const passed = result.failure === undefined && !result.timedOut && result.exitCode === 0;
  return !passed;
}
