// The TEMPLATE VALIDATION HARNESS — the "meaningful, not green-by-accident" proof
// (docs/roadmap/templating-system.md §2.4 / §4). It runs OVER a conforming template
// repo (a `justfile` + `.tanren/ci.yml`, see docs/operator-guide/ci-config.md) on an
// allocated runner and produces a `TemplateValidationProof` (the canonical
// manifest proof shape, assignable straight to `TemplateManifestV1.validationProof`).
// It REUSES the existing native
// gate runner (`../workflow/gate`) + the resolved CI config — it does NOT reinvent
// gate execution.
//
// Three stages, in order:
//   1. POSITIVE controls — `just bootstrap`, then each declared tier + `just build`,
//      ALL must pass over the template (proving the gates run green on a clean tree).
//   2. NEGATIVE controls (the core) — for each DECLARED gate capability, plant a
//      temporary defect in a SCRATCH COPY and assert the gate CATCHES it (fails),
//      then discard the copy. A gate that PASSES despite the defect is `unproven`
//      (the v29 no-op-typecheck failure mode); a gate that FAILS is `proven`; a gate
//      that could NOT run (timed out / substrate error) is INDETERMINATE → a LOUD
//      `unproven` (an infra timeout is NEVER a meaningful negative-control pass); an
//      undeclared capability is `n/a`.
//   3. AUDITOR — run the spec-loop auditor over the template (injected seam) and
//      assert no open P0/P1 → `auditorClean`.
//
// `templateValidates(proof)` (./validationProof.ts) is the final verdict:
// positive pass + every declared negative control proven + auditor clean.

import { bootstrapCommand, type CiConfigV1, tiersFor } from "../ci/index.js";
import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { runGateForWhen } from "../workflow/gate/runGateForWhen.js";
import type { GateAppendEvent } from "../workflow/gate/runGateTier.js";
import { withMiseActivation } from "../ssh/miseActivate.js";
import { DEFAULT_BOOTSTRAP_COMMAND, ensureWorkspaceDepsInstalled } from "../workspace/index.js";
import { type NegativeControlResult, type TemplateValidationProof } from "./manifest.js";
import { type GateInvocation, type NegativeControl } from "./negativeControls.js";
import { createScratchCopy, removeScratchCopy, type ScratchCopyDeps, writeDefectFiles } from "./scratchCopy.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("template-validation-harness");

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
export async function runValidationHarness(input: ValidationHarnessInput): Promise<TemplateValidationProof> {
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
  // DEPS-BEFORE-GATE (apex v35): install the template's deps FIRST — the tiers depend on
  // a bootstrapped tree, and a writer-authored `just tier-2` invokes
  // `./node_modules/.bin/<tool>` which is `command not found` (exit 127) until
  // `node_modules` exists. This MUST run unconditionally: when the template's
  // `.tanren/ci.yml` omits `bootstrap.run`, the OLD `if (bootstrap !== undefined)` skip
  // left the tiers running over an UNINSTALLED tree. We delegate to the shared
  // `ensureWorkspaceDepsInstalled` — the SAME deps-install the run-loop gate (#562) and
  // the batch/fresh-runner re-gates use — so the stack-agnostic `DEFAULT_BOOTSTRAP_COMMAND`
  // (`just bootstrap` if a justfile is present, else a loud failure) is the fallback when
  // no explicit `bootstrap.run` is declared, mise toolchain provision runs first, and the
  // contract-gated guard makes a contract-less tree a cheap no-op. A nonzero exit / timeout
  // throws `WorkspaceDepsInstallError`, which fails the positive controls (never a silent
  // green-by-accident gate over a tree that couldn't install).
  const explicitBootstrap = bootstrapCommand(input.config);
  try {
    await ensureWorkspaceDepsInstalled({
      ssh: input.ssh,
      target: input.target,
      workspacePath: input.workspacePath,
      command: explicitBootstrap ?? DEFAULT_BOOTSTRAP_COMMAND,
      timeoutMs: input.timeoutMs,
    });
  } catch {
    return false;
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
  // The build positive control — mise-activated so a bare `pnpm`/`node` in the
  // template's `just build` resolves to its declared toolchain (PROJECT path).
  const build = input.buildStep ?? DEFAULT_BUILD_STEP;
  const result = await input.ssh.run(input.target, {
    command: withMiseActivation(build.run),
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
  });
  return result.failure === undefined && !result.timedOut && result.exitCode === 0;
}

// Stage 2: run every declared negative control over its own scratch copy, returning the
// per-capability verdict map (undeclared capabilities → "n/a").
async function runNegativeControls(
  input: ValidationHarnessInput,
): Promise<TemplateValidationProof["negativeControls"]> {
  const verdicts: TemplateValidationProof["negativeControls"] = {
    typecheck: "n/a",
    lint: "n/a",
    test: "n/a",
    mutation: "n/a",
  };
  const scratchDeps: ScratchCopyDeps = { ssh: input.ssh, target: input.target, timeoutMs: input.timeoutMs };
  let index = 0;
  for (const control of input.negativeControls) {
    verdicts[control.capability] = await runOneNegativeControl(input, scratchDeps, control, index);
    index += 1;
  }
  return verdicts;
}

// The outcome of running a capability's gate over a scratch copy carrying a planted
// defect. THREE honestly-different states (VALIDATION INTEGRITY) — collapsing them is
// the bug this guards: an infra timeout / substrate error is NOT the gate catching the
// defect, so it must NEVER count as a meaningful negative-control pass.
//   - "caught"        — the gate RAN and FAILED on the injected defect (it works) ⇒ proven.
//   - "passed"        — the gate RAN and PASSED despite the defect ⇒ a no-op gate
//                       (the v29 scenario) ⇒ unproven.
//   - "could_not_run" — the gate could NOT run (timed out / substrate failure) ⇒ the
//                       negative control is INDETERMINATE. We did not prove the gate
//                       catches the defect, so it is a LOUD unproven — never proven.
type GateInvocationOutcome = "caught" | "passed" | "could_not_run";

// One negative control: copy the template → plant the defect → run the gate over the
// copy → map the outcome to the verdict → discard the copy. A scratch-copy error
// (copy/write) propagates LOUDLY — it cannot be a quiet verdict. The teardown always
// runs (finally).
async function runOneNegativeControl(
  input: ValidationHarnessInput,
  scratchDeps: ScratchCopyDeps,
  control: NegativeControl,
  index: number,
): Promise<NegativeControlResult> {
  const scratchPath = `${input.scratchRoot.replace(/\/+$/u, "")}/nc-${String(index)}-${control.capability}`;
  await createScratchCopy(scratchDeps, input.workspacePath, scratchPath);
  try {
    await writeDefectFiles(scratchDeps, scratchPath, control.defect.files);
    const outcome = await runGateForInvocation(input, scratchPath, control.invocation);
    switch (outcome) {
      case "caught":
        // The gate CAUGHT the planted defect (failed as it must) ⇒ proven.
        return "proven";
      case "passed":
        // The gate PASSED despite the defect ⇒ a no-op gate (the v29 scenario) ⇒ unproven.
        log.warn("negative control UNPROVEN — gate passed despite the planted defect (a no-op gate)", {
          capability: control.capability,
        });
        return "unproven";
      case "could_not_run":
        // VALIDATION INTEGRITY: the gate could NOT run (timed out / substrate error) over
        // the scratch copy — a flaky runner, NOT the gate catching the defect. We have
        // NOT proven the gate is meaningful, so this is a LOUD unproven; an infra timeout
        // must never publish a template with a gate that may be a no-op.
        log.warn(
          "negative control UNPROVEN — gate could NOT run over the scratch copy (timed out / substrate error); " +
            "an infra timeout is NEVER a meaningful negative-control pass",
          { capability: control.capability },
        );
        return "unproven";
      default: {
        const exhaustive: never = outcome;
        throw new Error(`runOneNegativeControl: unhandled gate outcome ${String(exhaustive)}`);
      }
    }
  } finally {
    await removeScratchCopy(scratchDeps, scratchPath);
  }
}

// Run a capability's gate over the scratch copy and classify the outcome. A tier
// invocation reuses the gate-runner over the copy; a step invocation runs the single
// declared command (mutation). The classification distinguishes a gate that CAUGHT the
// defect from one that could NOT run (timeout / substrate failure) — the latter is
// INDETERMINATE, not a pass: a gate that could not run cannot be a clean pass AND a
// gate that timed out cannot be the gate catching the defect.
async function runGateForInvocation(
  input: ValidationHarnessInput,
  scratchPath: string,
  invocation: GateInvocation,
): Promise<GateInvocationOutcome> {
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
    if (outcome.passed) {
      return "passed";
    }
    // The gate FAILED. Distinguish a genuine defect-catch from an infra timeout: if the
    // failing tier's failing step TIMED OUT, the gate did not run to a verdict — it is
    // INDETERMINATE, never a meaningful catch.
    return outcome.failure.steps.some((step) => step.timedOut) ? "could_not_run" : "caught";
  }
  const result = await input.ssh.run(input.target, {
    command: invocation.run,
    cwd: scratchPath,
    timeoutMs: input.timeoutMs,
  });
  // A timeout or substrate failure means the gate could NOT run to a verdict — it is
  // INDETERMINATE, never a defect-catch. Only a clean nonzero exit is a genuine catch.
  if (result.timedOut || result.failure !== undefined) {
    return "could_not_run";
  }
  return result.exitCode === 0 ? "passed" : "caught";
}
