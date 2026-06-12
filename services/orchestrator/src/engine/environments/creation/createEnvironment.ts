// Environment management (environment-management.md §4 + §7 P4) — the ENV-CREATION
// META-FLOW, the env-layer counterpart of `templates/creation/createTemplate.ts`.
// Given a project's OFF-baseline toolchain (a no-registry-match toolchain NOT covered
// by the golden baseline), it runs the build→validate→publish meta-flow and registers
// a VALIDATED environment — or fails LOUD without publishing. The env-layer of
// "no workspace seeds from an unvalidated environment."
//
//   1. BUILD    — `EnvImageBuildDriver.build`: BuildKit-build the golden base + the
//                 project's off-baseline toolchain → a pushed env image
//                 (liveEnvBuildDriver.ts → scripts/dev/build-env-image.sh).
//   2. VALIDATE — allocate a runner FROM the built image, run the env validation
//                 harness (POSITIVE smoke: every declared tool resolves to its locked
//                 version; NEGATIVE controls: an undeclared tool is absent + a
//                 forbidden version is unresolvable) → an EnvironmentValidationProof.
//   3. PUBLISH  — ONLY if `environmentValidates(proof)`: register the env in the
//                 `EnvironmentStore` (status `validated`, with image_ref +
//                 capabilities + provenance + validation_proof). A failed validation
//                 NEVER publishes — a LOUD `EnvironmentValidationFailedError`, never a
//                 silent golden-base degrade for a toolchain that demanded a real env.
//
// REUSE, don't reinvent: the build is the BuildKit seam (P2 patterns), validation is
// the env harness (the env counterpart of the template harness), publish is the P3
// `EnvironmentStore`. This module is ONLY the orchestration + the fail-closed gate.
//
// SCOPE: this builds the MISE-tier JIT creation. A `flake.nix`-present project routes
// to the Nix builder (P5) BEFORE this flow — see the seam in the no-match router
// (resolveProjectEnvWithCreation.ts); this flow assumes the mise tier.

import type pg from "pg";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { Allocator, RunnerHandle } from "../../contracts/allocator.js";
import type { CommandSubstrate } from "../../contracts/commandSubstrate.js";
import { workspaceRepoPathForRun } from "../../workspace/index.js";
import { quoteSshShellArg } from "../../ssh/command.js";
import type { ProjectToolchain } from "../../config/projectConfig.js";
import { renderMiseToml } from "../../forge/scaffold/skeleton.js";
import type { ActorRef } from "../../state/actor.js";
import { EnvironmentStore, type Environment } from "../../repositories/environments.js";
import type { EnvironmentProvenance, EnvironmentValidationProof } from "../manifest.js";
import { createLogger } from "../../observability/logger.js";
import { computeEnvKey } from "../envKey.js";
import { resolveGoldenBaseDigest } from "../goldenBase.js";
import { type BuiltEnvImage, EnvBuildFailedError, type EnvImageBuildDriver } from "./envBuildDriver.js";
import { runEnvValidationHarness } from "./envValidationHarness.js";
import { environmentValidates } from "./envValidationProof.js";

const log = createLogger("env-creation");

// Project the declared toolchain (a list of {name, version}) into the persisted
// `EnvironmentCapabilities.tools` SUMMARY MAP (name → version) the registry stores +
// selection queries. De-duped last-wins, matching `renderMiseToml`'s projection.
function toolchainCapabilityMap(toolchain: ProjectToolchain): Record<string, string> {
  const tools: Record<string, string> = {};
  for (const { name, version } of toolchain) {
    tools[name] = version;
  }
  return tools;
}

// The injected collaborators the env meta-flow drives. The build + the runner
// allocation are SEAMS so the orchestration is exercised end-to-end against stubs
// (a stubbed builder + a fake allocator/substrate) — the wave's test contract.
export interface CreateEnvironmentDeps {
  pool: pg.Pool;
  actor: ActorRef;
  // Step 1: the env-image build seam (BuildKit build → pushed image ref).
  buildDriver: EnvImageBuildDriver;
  // Step 2: the allocator + command substrate the validation runner is allocated +
  // probed on. The runner is allocated FROM the freshly-built env image.
  allocator: Allocator;
  ssh: CommandSubstrate;
  identitySecretRef: string;
  // The clock — passed so the proof's validatedAt is deterministic in tests.
  now: () => Date;
  // Per-command validation timeout.
  timeoutMs: number;
}

// The inputs the creation flow takes: the owning org + the project (for naming) + its
// off-baseline toolchain + the golden base it layers on. The org is carried
// EXPLICITLY (the run's tenant scope), not derived from the actor — `ActorRef` is the
// audit identity, the org is the run/project's RLS scope (mirroring how
// `resolveProjectEnv` threads org via the scoped client + data, not the actor).
export interface CreateEnvironmentRequest {
  // The owning org — the env is registered under this org's RLS scope. A run path
  // supplies the run's `projects.org_id` (NOT-NULL); a LOUD failure on an empty id.
  orgId: string;
  // The project the env is created FOR (a stable allocation handle).
  projectId: string;
  // The project's declared toolchain — the OFF-baseline tool set the env bakes. MUST
  // be non-empty + not baseline-covered (the router guarantees this before calling).
  toolchain: ProjectToolchain;
  // The golden BASE image the env FROMs (`FROM <goldenBaseImage>`). Never scratch.
  goldenBaseImage: string;
}

// The outcome of a successful creation: the registered env + its proof + the image ref
// the workspace now seeds from. A FAILED validation does NOT return this — it throws
// `EnvironmentValidationFailedError` (the fail-closed gate).
export interface CreateEnvironmentResult {
  environment: Environment;
  proof: EnvironmentValidationProof;
  imageRef: string;
}

// Thrown when the built env image did NOT pass validation — the fail-closed publish
// gate (env-management.md §4). The proof is attached so the caller surfaces EXACTLY
// which control failed (a leaked baseline tool → undeclaredToolAbsent unproven). An
// invalid env is never registered; this is the LOUD finding (mirrors
// `TemplateValidationFailedError`).
export class EnvironmentValidationFailedError extends Error {
  readonly proof: EnvironmentValidationProof;
  readonly envKey: string;
  constructor(envKey: string, proof: EnvironmentValidationProof) {
    super(
      `env ${envKey} FAILED validation — not published. ` +
        `positiveSmokePassed=${String(proof.positiveSmokePassed)}, ` +
        `negativeControls=${JSON.stringify(proof.negativeControls)}`,
    );
    this.name = "EnvironmentValidationFailedError";
    this.proof = proof;
    this.envKey = envKey;
  }
}

// Run the full env-creation meta-flow. Returns the registered env on success; throws
// LOUD on a failed build (`EnvBuildFailedError`, from the driver) or a failed
// validation (`EnvironmentValidationFailedError`) — never publishes a degraded env.
export async function createEnvironment(
  deps: CreateEnvironmentDeps,
  request: CreateEnvironmentRequest,
): Promise<CreateEnvironmentResult> {
  const orgId = requireOrg(request.orgId);
  const miseToml = renderMiseToml(request.toolchain);
  const baseDigest = resolveGoldenBaseDigest();
  const envKey = computeEnvKey({ baseDigest, miseLock: miseToml });

  // STEP 1 — BUILD: BuildKit-build the golden base + the project's off-baseline
  // toolchain → a pushed env image. A build that does not produce a pushed image
  // throws `EnvBuildFailedError` (LOUD) — the creation flow aborts WITHOUT publishing.
  let built: BuiltEnvImage;
  try {
    built = await deps.buildDriver.build({ miseToml, goldenBaseImage: request.goldenBaseImage, envKey });
  } catch (error) {
    if (error instanceof EnvBuildFailedError) throw error;
    throw new EnvBuildFailedError(envKey, error instanceof Error ? error.message : String(error));
  }

  // STEP 2 — VALIDATE over a runner allocated FROM the built image. RELEASE it in a
  // `finally` (pass OR fail) so the validation runner is never LEAKED (mirrors the
  // template flow's teardown discipline). The release is best-effort (never throws).
  const proof = await validateBuiltEnv(deps, request, built);

  // THE FAIL-CLOSED GATE: only an env whose proof validates (positive smoke + BOTH
  // isolation controls proven) may publish. A failed validation is the LOUD finding —
  // never a silent golden-base degrade for a toolchain that demanded a real env.
  if (!environmentValidates(proof)) {
    throw new EnvironmentValidationFailedError(envKey, proof);
  }

  // STEP 3 — PUBLISH: register the validated env (status `validated`, image_ref +
  // capabilities + provenance + the proof). Keyed on (org_id, env_key) — a re-build
  // over the same content UPSERTs. The workspace now seeds from `built.imageRef`.
  const provenance: EnvironmentProvenance = {
    baseDigest,
    miseLockHash: sha256(miseToml),
    createdByRunId: request.projectId,
  };
  const environment = await EnvironmentStore.create(
    deps.pool,
    {
      orgId,
      envKey,
      imageRef: built.imageRef,
      capabilities: { tools: toolchainCapabilityMap(request.toolchain) },
      provenance,
      status: "validated",
      validationProof: proof,
    },
    deps.actor,
  );
  log.info("published validated env", { envKey, environmentId: environment.id, imageRef: built.imageRef });
  return { environment, proof, imageRef: built.imageRef };
}

// STEP 2 helper: allocate a runner FROM the built env image, run the validation
// harness in the workspace where the env's mise.toml lives, and RELEASE the runner in
// a `finally`. The harness's positive smoke + isolation controls are the proof.
async function validateBuiltEnv(
  deps: CreateEnvironmentDeps,
  request: CreateEnvironmentRequest,
  built: BuiltEnvImage,
): Promise<EnvironmentValidationProof> {
  const orgId = requireOrg(request.orgId);
  // A stable synthetic handle for the validation runner (must match the safe `run_*`
  // workspace-path pattern — sanitize the project id). The env image bakes the
  // toolchain; the harness probes through `mise` in the workspace.
  const runId = `run_env_validate_${request.projectId.replaceAll(/[^A-Za-z0-9_-]/gu, "_")}_${randomUUID().slice(0, 8)}`;
  const workspacePath = workspaceRepoPathForRun(runId);
  const allocation = await deps.allocator.allocate({
    runId,
    projectId: request.projectId,
    runnerImage: built.imageRef,
    identitySecretRef: deps.identitySecretRef,
    orgId,
    // RUNLESS — this is an env-validation allocation, not a real run. NULL FK columns
    // (no runs/projects row for the synthetic handle) avoid the FK violations.
    runless: true,
    persistedRunId: null,
    persistedProjectId: request.projectId,
  });
  const target = allocation.target;
  try {
    // Materialize the project's mise.toml into the validation workspace so `mise`
    // resolves the env's toolchain there (the image bakes the install; the toml in the
    // cwd is what `mise exec`/`mise which` read to know what to resolve).
    await materializeMiseToml(deps.ssh, target, workspacePath, renderMiseToml(request.toolchain), deps.timeoutMs);
    return await runEnvValidationHarness({
      ssh: deps.ssh,
      target,
      workspacePath,
      toolchain: request.toolchain,
      now: deps.now,
      timeoutMs: deps.timeoutMs,
    });
  } finally {
    // RELEASE the validation runner (pass OR fail) — never leaked. Best-effort: a
    // release failure is logged, never thrown (it must not mask the validation result).
    try {
      await deps.allocator.release(allocation.runnerId, "completed");
    } catch (error) {
      log.warn("failed to release env-validation runner — leak risk", { runnerId: allocation.runnerId }, error);
    }
  }
}

// Write the rendered mise.toml into the validation workspace (mkdir + write), so the
// harness's `mise exec`/`mise which` probes resolve the env's declared toolchain.
async function materializeMiseToml(
  ssh: CommandSubstrate,
  target: RunnerHandle,
  workspacePath: string,
  miseToml: string,
  timeoutMs: number,
): Promise<void> {
  await ssh.run(target, {
    command: `set -eu; mkdir -p ${quoteSshShellArg(workspacePath)}`,
    timeoutMs,
  });
  await ssh.run(target, {
    command: `cat > ${quoteSshShellArg(`${workspacePath}/mise.toml`)}`,
    cwd: workspacePath,
    stdin: miseToml,
    timeoutMs,
  });
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// Org is required — the env is org-scoped. An empty org id is a LOUD failure, never a
// silent fallback to a default org (mirrors `createTemplate`'s requireOrg + the
// no_silent_fallbacks doctrine: a missing tenant scope at a run path is a bug).
function requireOrg(orgId: string): string {
  if (orgId.trim() === "") {
    throw new Error("createEnvironment requires an org-scoped run (orgId is empty)");
  }
  return orgId;
}
