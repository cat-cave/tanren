// Environment management (environment-management.md §3 Layer 4 + §6 + §7 P3) — the
// PER-PROJECT env resolution at the image seam. This is the env-layer counterpart
// of code-template selection: instead of resolving the runner image to a hardcoded
// default, a project's environment is identified by its toolchain content
// (`env_key`) and the runner image is resolved from the `environments` registry by
// that key, falling back to the warm GOLDEN BASE on a no-match.
//
// RESOLUTION (the per-project binding, environment-management.md §8 decision 4):
//   1. Read the project's COMMITTED toolchain (the deterministic `mise.lock`
//      counterpart available BEFORE the workspace is checked out — Tanren
//      materializes `mise.toml` from the project's declared `toolchain` the same
//      deterministic way it materializes the justfile/`.tanren/ci.yml`, so the
//      rendered toolchain IS the project's committed lockfile content at resolve
//      time). No declared toolchain ⇒ NO env_key ⇒ the golden base (a fresh
//      greenfield first boot, exactly as today).
//   2. computeEnvKey(base_digest ‖ mise.lock) over P2's golden base_digest.
//   3. EnvironmentStore.getByEnvKey for a VALIDATED/OFFICIAL match.
//   4. Match ⇒ use `env.image_ref` as the runner image + record the binding.
//      No-match ⇒ FALL BACK to the golden base (P4 replaces this with a JIT build).
//
// The existing flow is PRESERVED: a project with no lockfile/env resolves to the
// golden base exactly as today. Resolution NEVER stalls a run — a registry error is
// caught and degrades to the golden base (loud-logged), because the golden base is
// always a safe boot.

import type pg from "pg";
import { renderMiseToml } from "../forge/scaffold/skeleton.js";
import type { ProjectToolchain } from "../config/projectConfig.js";
import type { ActorRef } from "../state/actor.js";
import { EnvironmentStore, type EnvironmentStatus } from "../repositories/environments.js";
import { computeEnvKey } from "./envKey.js";
import { GOLDEN_BASE_IMAGE, resolveGoldenBaseDigest } from "./goldenBase.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

// Resolution only SEEDS from a PROVEN env (a draft is never validated, so it is
// never resolved into a workspace). Mirrors the template-selection status filter.
const RESOLVABLE_STATUSES: ReadonlyArray<EnvironmentStatus> = ["validated", "official"];

/** What env resolution decided for a project, recorded on the project config + threaded to alloc. */
export interface ProjectEnvBinding {
  // The runner image the workspace will seed from — `env.image_ref` on a match, or
  // the golden BASE image on a no-match / no-lockfile.
  imageRef: string;
  // The content key the project's toolchain hashed to, when it declared a toolchain
  // (absent for a no-toolchain project — no env_key, the golden-base path).
  envKey?: string;
  // The matched environment's registry id, when a validated/official env resolved
  // (absent on a no-match / golden-base fallback).
  environmentRef?: string;
  // Why this image was chosen — observable on the project config + in logs.
  source: "registry-match" | "golden-base-no-match" | "golden-base-no-toolchain";
}

/** The inputs resolution reads — the project's declared toolchain (the committed lockfile counterpart). */
export interface ResolveProjectEnvInput {
  // The project's declared `mise` toolchain (tool-name → version-spec). EMPTY/absent
  // ⇒ the project declared no toolchain (no `mise.toml`) ⇒ the project's `baseImage`.
  toolchain: ProjectToolchain | undefined;
  // The project's per-project runner image (`projects.runner_image`) — the fallback
  // when env-resolution finds no keyed match (or the project declared no toolchain).
  // For a normal project this IS the golden base (`runner_image` defaults to it); a
  // project that PINNED a custom image keeps that pin (the pin is an explicit
  // override, never silently replaced by the canonical golden base). Defaults to the
  // canonical golden base when absent.
  baseImage?: string;
}

/**
 * Resolve the runner image for a project from the `environments` registry by its
 * toolchain content key, falling back to the golden base on a no-match.
 *
 * Must be called with an ORG-SCOPED client (the registry is RLS-scoped: the lookup
 * sees the org's own envs + the cross-org official catalogue). A registry error
 * never stalls a run — it degrades to the golden base (the always-safe boot).
 */
export async function resolveProjectEnv(
  client: QueryClient,
  input: ResolveProjectEnvInput,
  actor: ActorRef,
): Promise<ProjectEnvBinding> {
  const toolchain = input.toolchain;
  // The no-env fallback is the project's OWN runner image (`projects.runner_image`),
  // which for a normal project IS the golden base — so the existing flow is byte-for-
  // byte preserved (a project resolves to exactly the image it does today), and a
  // project that pinned a custom image keeps its pin rather than being silently
  // replaced by the canonical golden base.
  const baseImage = input.baseImage ?? GOLDEN_BASE_IMAGE;
  // No declared toolchain ⇒ no env_key ⇒ the project's base image (a fresh greenfield
  // first boot, or a brownfield project that ships no `mise.toml`). Flow preserved.
  if (toolchain === undefined || Object.keys(toolchain).length === 0) {
    return { imageRef: baseImage, source: "golden-base-no-toolchain" };
  }

  // The project's committed mise toolchain, rendered DETERMINISTICALLY (the same
  // projection Tanren materializes into the repo) — this IS the `mise.lock`-slot
  // content the env_key is computed over at resolve time.
  const miseLock = renderMiseToml(toolchain);
  const envKey = computeEnvKey({ baseDigest: resolveGoldenBaseDigest(), miseLock });

  const match = await EnvironmentStore.getByEnvKey(client, envKey, RESOLVABLE_STATUSES, actor);
  if (match !== undefined) {
    return { imageRef: match.imageRef, envKey, environmentRef: match.id, source: "registry-match" };
  }
  // NO-MATCH: fall back to the project's base image — the warm golden base for a
  // normal project (covers the common toolchains). P4 replaces this with a JIT build
  // of the env_key-ed image.
  return { imageRef: baseImage, envKey, source: "golden-base-no-match" };
}
