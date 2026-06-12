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
// (the run fails-closed; never seeds from an unvalidated env). A no-op when the seams
// are absent (P3 behavior preserved) or the toolchain is empty.

import type pg from "pg";
import { orgScopingPool } from "../data/orgScopedDb.js";
import { systemActor } from "../state/actor.js";
import type { ProjectConfigV1 } from "../config/index.js";
import type { PlannerRunContext } from "../workflow/plannerRun.js";
import { resolveProjectEnvWithCreation, type EnvCreationDeps } from "../environments/creation/index.js";

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
 * Refine the run's resolved runner image via JIT env-image creation when the seams are
 * wired. Mutates `context.runnerImage` in place to the (possibly JIT-built + validated)
 * env image. A no-op when `creation` is undefined (P4 seams not wired → P3 behavior) or
 * the project declared no toolchain. A creation failure throws LOUD (fail-closed).
 */
export async function refineRunnerImageForEnv(input: RefineRunnerImageForEnvInput): Promise<void> {
  const { creation, context, projectConfig, orgId } = input;
  if (creation === undefined) {
    // P4 seams not wired → P3 behavior (the golden-base no-match fallback).
    return;
  }
  const toolchain = projectConfig.lifecycle?.toolchain;
  if (toolchain === undefined || Object.keys(toolchain).length === 0) {
    // No declared toolchain → nothing to build (the golden base stands).
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
