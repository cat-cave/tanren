// The PRODUCTION REVALIDATOR (docs/roadmap/templating-system.md §4) — the seam that
// re-runs the FULL validation harness over a REGISTERED template's repo, so the
// maintenance loop's GREEN/RED verdict is produced by the SAME oracle the creation
// flow proved the template with (`runValidationHarness`). It does NOT reinvent
// validation; it only PROVISIONS the registered repo onto a runner and hands the
// harness its inputs.
//
// The provisioning (allocate a runner → check out the template's repoRef →
// bootstrap → resolve its `.tanren/ci.yml` → wire the auditor) is an INJECTED seam
// (`TemplateWorkspaceProvisioner`) — exactly mirroring how the creation flow's
// `TemplateBuildDriver` returns a `BuiltTemplate` handle the harness consumes. The
// real provisioner lives at the worker-boot call site (allocator + clone + bootstrap
// over SSH); tests inject a scripted provisioner OR drive the loop with a fully-faked
// `TemplateRevalidator` directly (no provisioner needed). A provisioning throw is a
// LOUD per-template failure the loop logs + retries — never a silent green.

import type { CiConfigV1 } from "../../ci/index.js";
import type { RunnerHandle } from "../../contracts/allocator.js";
import type { CommandSubstrate } from "../../contracts/commandSubstrate.js";
import { type GateAppendEvent } from "../../workflow/gate/runGateTier.js";
import { buildNegativeControlPlan } from "../negativeControls.js";
import { runValidationHarness, type TemplateAuditor } from "../validationHarness.js";
import type { TemplateValidationProof } from "../manifest.js";
import type { MaintainableTemplate, TemplateRevalidator } from "./maintenancePass.js";

// The provisioned context the harness re-validates over — the maintenance analogue
// of the creation flow's `BuiltTemplate`. The provisioner allocates the runner,
// checks out + bootstraps the template's `repoRef`, resolves its CI config, and wires
// the auditor; the revalidator runs the harness over it and the provisioner tears the
// runner down (its `release` closure).
export interface ProvisionedTemplate {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  // The bootstrapped template workspace on the runner (positive controls run here).
  workspacePath: string;
  // Where the negative-control scratch copies are made (reaper-protected).
  scratchRoot: string;
  // The resolved `.tanren/ci.yml` config (the harness reads its tiers/bootstrap).
  config: CiConfigV1;
  // The exact checked-out commit the proof is anchored on.
  checkedOutSha: string;
  // The auditor seam over the provisioned template (the spec-loop auditor in prod).
  auditor: TemplateAuditor;
  // Whether the template declares mutation (so the negative-control plan seeds a
  // mutation control) + its mutation step. From the template's declared capabilities.
  mutation?: { step: string };
  // The optional non-default build step (`just build` by convention).
  buildStep?: { name: string; run: string };
  // Narration sink — the harness emits gate.* events through it.
  appendEvent: GateAppendEvent;
  // Tear down the allocated runner (always called, even on a harness throw).
  release: () => Promise<void>;
}

// The provisioner seam: given a registered template, provision its repo onto a runner
// and return the harness context. The real impl (worker boot) allocates + clones +
// bootstraps over SSH; tests inject a scripted provisioner. A throw is LOUD.
export interface TemplateWorkspaceProvisioner {
  provision(template: MaintainableTemplate): Promise<ProvisionedTemplate>;
}

// Build a production `TemplateRevalidator` from a provisioner + a clock. It
// provisions the template, runs the harness over it, and ALWAYS releases the runner
// (finally) — so a harness throw still tears down the allocation. The negative-control
// plan is derived from the template's declared mutation capability (mirrors the
// creation flow), so a mutation-declaring template re-proves its seeded-mutant kill.
export function harnessRevalidator(deps: {
  provisioner: TemplateWorkspaceProvisioner;
  now: () => Date;
  timeoutMs: number;
}): TemplateRevalidator {
  return {
    async revalidate({ template }): Promise<TemplateValidationProof> {
      const ctx = await deps.provisioner.provision(template);
      try {
        const negativeControls = buildNegativeControlPlan(
          ctx.mutation === undefined ? {} : { mutationStep: ctx.mutation.step },
        );
        return await runValidationHarness({
          ssh: ctx.ssh,
          target: ctx.target,
          workspacePath: ctx.workspacePath,
          scratchRoot: ctx.scratchRoot,
          config: ctx.config,
          negativeControls,
          ...(ctx.buildStep === undefined ? {} : { buildStep: ctx.buildStep }),
          auditor: ctx.auditor,
          validatedSha: ctx.checkedOutSha,
          now: deps.now,
          timeoutMs: deps.timeoutMs,
          appendEvent: ctx.appendEvent,
        });
      } finally {
        await ctx.release();
      }
    },
  };
}
