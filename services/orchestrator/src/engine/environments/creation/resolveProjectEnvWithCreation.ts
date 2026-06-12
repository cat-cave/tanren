// Environment management (environment-management.md §4 + §7 P4) — the NO-MATCH ROUTER
// that wires JIT env-image creation into P3's resolution. The env-layer counterpart
// of the code-template no-match hook (`templates/creation/noMatchHook.ts`).
//
// P3's `resolveProjectEnv` already does: env_key MATCH → use it; no-match → the golden
// base (a placeholder fallback). P4 REPLACES that no-match fallback (for toolchains the
// golden base does NOT already serve) with JIT creation. The routing this module owns:
//
//   1. env_key MATCH                            → use it (unchanged from P3).
//   2. no-match + toolchain ⊆ golden baseline   → the golden base (SHORT-CIRCUIT — no
//      build; apex-style node+pnpm projects land here and NEVER trigger a build).
//   3. no-match + toolchain ⊄ baseline (mise)   → JIT-create (build→validate→publish)
//      SYNCHRONOUSLY + seed from the published env image (like the synchronous
//      code-template create-then-seed). A creation FAILURE propagates LOUD.
//   4. no-match + flake.nix present             → SEAM for the Nix tier (P5). NOT built
//      here — `flakePresent: true` throws a loud "Nix tier not yet built" rather than
//      silently mise-building a flake-tier project.
//
// INVARIANT (the env-layer of "no from-scratch project"): after P4, NO workspace seeds
// from an UNVALIDATED environment. A baseline-subset toolchain seeds from the golden
// base (itself validated by P2's build). An off-baseline toolchain seeds ONLY from a
// JIT-built env that passed positive smoke + negative controls. A creation failure is
// a LOUD halt, never a silent golden-base degrade.

import type pg from "pg";
import type { ProjectToolchain } from "../../config/projectConfig.js";
import type { ActorRef } from "../../state/actor.js";
import { resolveProjectEnv, type ProjectEnvBinding, type ResolveProjectEnvInput } from "../resolveProjectEnv.js";
import { toolchainCoveredByGoldenBaseline } from "../baselineCoverage.js";
import { createLogger } from "../../observability/logger.js";
import { createEnvironment, type CreateEnvironmentDeps } from "./createEnvironment.js";

const log = createLogger("env-resolution");

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

// The creation collaborators the router threads to `createEnvironment` on the JIT-build
// branch. Same shape as `CreateEnvironmentDeps` minus the `pool`/`actor` (the router
// already holds the scoped client + actor) — those are filled from the resolve call.
export type EnvCreationDeps = Omit<CreateEnvironmentDeps, "pool" | "actor">;

// The router's input: the P3 resolve input + the org (the run's tenant scope, for
// creation) + the project id (the creation handle) + an optional `flakePresent` flag
// (the Nix-tier seam). `flakePresent` defaults to false (the mise tier, the 95% case).
export interface ResolveWithCreationInput extends ResolveProjectEnvInput {
  // The run's owning org — threaded to `createEnvironment` on the JIT-build branch.
  orgId: string;
  // The project the env is created for (a stable allocation handle).
  projectId: string;
  // The Nix-tier signal (env-management.md §3 escape-hatch): the project ships a
  // `flake.nix`. The mise-tier JIT build does NOT serve a flake — P4 routes it to a
  // LOUD "Nix tier not yet built" (P5), never a silent mise-build of a flake project.
  flakePresent?: boolean;
}

// Thrown when a no-match project ships a `flake.nix` (the Nix tier) — P4 builds only
// the mise tier, so the Nix-tier JIT creation (nix2container + attic, P5) is a LOUD
// not-yet-built, never a silent mise-build of a flake-tier project.
export class NixTierNotBuiltError extends Error {
  constructor(projectId: string) {
    super(
      `project ${projectId} ships a flake.nix (the Nix escape-hatch tier) with no registry match — ` +
        `the Nix-tier JIT env creation (nix2container + attic) is P5, not yet built. Routed loud rather than ` +
        `silently mise-building a flake-tier project.`,
    );
    this.name = "NixTierNotBuiltError";
  }
}

/**
 * Resolve the runner image for a project, JIT-creating a validated env image on a
 * no-match for an off-baseline toolchain. The P4 superset of `resolveProjectEnv`:
 * a registry match or a baseline-subset toolchain resolves exactly as P3 (no build);
 * an off-baseline no-match SYNCHRONOUSLY builds→validates→publishes a real env and
 * seeds from it. A creation FAILURE propagates LOUD (never a silent golden-base
 * degrade for a toolchain that demanded a real env).
 *
 * Must be called with an ORG-SCOPED client (the registry is RLS-scoped). The creation
 * deps are the build/allocate seams; they are only touched on the JIT-build branch.
 */
export async function resolveProjectEnvWithCreation(
  client: QueryClient,
  input: ResolveWithCreationInput,
  actor: ActorRef,
  creation: EnvCreationDeps,
): Promise<ProjectEnvBinding> {
  // First do the P3 resolution: a registry MATCH (source `registry-match`), a
  // no-toolchain golden base (`golden-base-no-toolchain`), or a no-match golden-base
  // PLACEHOLDER (`golden-base-no-match`) that P4 may replace with a JIT build.
  const binding = await resolveProjectEnv(client, input, actor);

  // Branches 1 + 2-as-no-toolchain: a registry match or a no-toolchain project is
  // already terminal — use it unchanged (P3 behavior preserved exactly).
  if (binding.source !== "golden-base-no-match") {
    return binding;
  }

  // A no-match WITH a declared toolchain. The toolchain is present (no-match implies a
  // non-empty toolchain — the no-toolchain case never reaches here).
  const toolchain = input.toolchain;
  if (toolchain === undefined || toolchain.length === 0) {
    // Defensive: a no-match must carry a toolchain. If somehow not, keep the P3 binding.
    return binding;
  }

  // Branch 2 — the GOLDEN-BASE SHORT-CIRCUIT (the do-NOT-over-build rule): the
  // toolchain is a SUBSET of the golden baseline, so the golden base ALREADY serves it
  // (it IS a validated env for this toolchain) — resolve to the golden base, no build.
  // apex-style node+pnpm toolchains land here.
  if (toolchainCoveredByGoldenBaseline(toolchain)) {
    log.info("toolchain covered by golden baseline — short-circuit to golden base (no JIT build)", {
      projectId: input.projectId,
      envKey: binding.envKey,
    });
    return binding;
  }

  // Branch 4 — the NIX-TIER SEAM. A flake-tier project with no match is P5, not P4: a
  // LOUD not-yet-built, never a silent mise-build of a flake project.
  if (input.flakePresent === true) {
    throw new NixTierNotBuiltError(input.projectId);
  }

  // Branch 3 — JIT-CREATE (the mise tier). The toolchain is OFF-baseline + no match:
  // build→validate→publish a real env SYNCHRONOUSLY, then seed from it. A creation
  // FAILURE (build / validation) propagates LOUD — the run never seeds from an
  // unvalidated env for a toolchain that demanded a real one.
  log.info("off-baseline toolchain, no registry match — JIT-creating a validated env image", {
    projectId: input.projectId,
    envKey: binding.envKey,
  });
  const result = await createEnvironment(
    { ...creation, pool: client as pg.Pool, actor },
    {
      orgId: input.orgId,
      projectId: input.projectId,
      toolchain,
      goldenBaseImage: binding.imageRef,
    },
  );
  // Seed from the freshly-published env image — the binding now points at a VALIDATED
  // env, with the env_key + the registered env's id recorded. Labeled `jit-created`
  // (distinct from a pre-existing `registry-match`) so the build is observable.
  return {
    imageRef: result.imageRef,
    ...(binding.envKey === undefined ? {} : { envKey: binding.envKey }),
    environmentRef: result.environment.id,
    source: "jit-created",
  };
}

export { toolchainCoveredByGoldenBaseline } from "../baselineCoverage.js";
export type { ProjectToolchain };
