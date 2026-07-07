// Environment management (env-management.md §4 + §7 P4) — the run-executor's JIT
// env-image refinement step, extracted from runExecutor.ts (it keeps that file under
// the line/dependency caps + isolates the env-creation wiring).
//
// P3's resolution (inside `loadRunExecutionContext`) already set `context.runnerImage`
// to a registry match or the golden-base no-match placeholder. This step — run OUTSIDE
// the scoped read txn, where the worker's allocator/ssh are available — routes the
// project's declared toolchain through the P4 no-match router. It short-circuits a
// baseline-subset toolchain to the golden base (NO build), and SYNCHRONOUSLY
// builds→validates→publishes a real env image for an off-baseline no-match, then
// overrides `context.runnerImage` to seed from it. A creation FAILURE propagates LOUD
// (the run fails-closed; never seeds from an unvalidated env). A no-op when the
// toolchain is empty OR baseline-subset (the golden base already serves it).
//
// H1 finding #4 — an OFF-baseline toolchain with NO JIT seams wired
// (`TANREN_ENV_REGISTRY` unset) FAILS LOUD (`JitBuildRequiredError`) rather than
// silently degrading to the golden base. Doctrine §2.2: halt loud, never seed from
// an unvalidated env for a toolchain that demanded a real one.

import type pg from "pg";
import { orgScopingPool } from "../data/orgScopedDb.js";
import { systemActor } from "../state/actor.js";
import type { ProjectConfigV1 } from "../config/index.js";
import type { PlannerRunContext } from "../workflow/plannerRun.js";
import {
  assertJitAvailableForToolchain,
  resolveProjectEnvWithCreation,
  type EnvCreationDeps,
} from "../environments/creation/index.js";

// Re-exported so runExecutor.ts types its `RunExecutorDeps.envCreation` seam without a
// direct import of the env-creation module (keeping that file under its dependency cap).
export type { EnvCreationDeps };

export interface RefineRunnerImageForEnvInput {
  pool: pg.Pool;
  creation: EnvCreationDeps | undefined;
  context: PlannerRunContext;
  projectConfig: ProjectConfigV1;
  orgId: string;
}

/**
 * Refine the run's resolved runner image via JIT env-image creation. A no-op when the
 * project declared no toolchain OR the toolchain is a baseline-subset (the golden
 * base already serves it — apex-style node+pnpm lands here). An OFF-baseline
 * toolchain routes through the P4 resolver to build→validate→publish a real env
 * image, then overrides `context.runnerImage` to seed from it.
 *
 * An OFF-baseline toolchain with NO `creation` seams wired throws
 * `JitBuildRequiredError` (H1 #4 — no silent golden-base fallback). A creation
 * failure throws LOUD (fail-closed; never seed from an unvalidated env).
 */
export async function refineRunnerImageForEnv(input: RefineRunnerImageForEnvInput): Promise<void> {
  const { creation, context, projectConfig, orgId } = input;
  const toolchain = projectConfig.lifecycle?.toolchain;
  // Symmetric with `assertJitAvailableForToolchain`: an empty / baseline-subset
  // toolchain needs neither JIT nor a build. The assertion no-ops in both cases
  // and throws only when off-baseline + no registry. We call it FIRST so a run on
  // a worker booted without JIT capability fails LOUD immediately, before we
  // touch the DB.
  assertJitAvailableForToolchain(toolchain, {
    projectId: context.projectId,
    registryConfigured: creation !== undefined,
  });
  if (creation === undefined) {
    // The assertion above passed ⇒ the toolchain is empty / baseline-subset ⇒
    // the golden base binding is correct. Nothing to refine.
    return;
  }
  if (toolchain === undefined || toolchain.length === 0) {
    // Guard already returned above for the empty case when creation was undefined;
    // preserved here so the type narrowing works for the resolver call below.
    return;
  }
  // Route through the P4 resolver: a match / baseline-subset toolchain returns the
  // same image P3 did; an off-baseline no-match JIT-builds + validates + publishes,
  // then seeds from the new env image. `context.runnerImage` IS the P3-resolved image
  // (the golden base on a no-match), which doubles as the `baseImage` the router FROMs.
  const binding = await resolveProjectEnvWithCreation(
    orgScopingPool(input.pool),
    { toolchain, baseImage: context.runnerImage, orgId, projectId: context.projectId },
    systemActor,
    creation,
  );
  // Override the seed image with the (possibly JIT-built) env image. On a short-circuit
  // / match this is the same value P3 already set — a harmless no-op override.
  context.runnerImage = binding.imageRef;
}
