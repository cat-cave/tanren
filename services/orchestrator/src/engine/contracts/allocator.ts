// The set of execution backends a runner handle can belong to. SSH is the one
// concrete arm today; the others are DOCUMENTED SEAM ARMS — named so the model is
// explicit, not yet built (Fly Machines micro-VM, Sprites/Daytona native-exec). A
// new backend extends this union + adds a `RunnerHandle` subtype; it does NOT
// refactor the consumers.
export type RunnerBackend = "ssh";

// A RUNNER HANDLE — the address a {@link CommandSubstrate} / {@link FileSubstrate}
// operates on. This is the CONTRACT SURFACE: the substrate that PRODUCED the handle
// knows how to reach the runner; engine code threads the handle through unchanged
// and reads only `backend` off this base — never a backend's reach fields. A
// concrete backend extends this with its own reach fields (see
// {@link SshRunnerHandle}); the base stays minimal so consumers cannot accidentally
// couple to one backend's transport.
export interface RunnerHandle {
  readonly backend: RunnerBackend;
}

// The SSH concrete handle: how the SSH CommandSubstrate / FileSubstrate reach the
// runner — host/port/username + the verifiable host-key fingerprint + the Vault
// ref for the identity key (never the key material itself). This is the ONE
// concrete handle shape today.
export interface SshRunnerHandle extends RunnerHandle {
  backend: "ssh";
  host: string;
  port: number;
  username: string;
  hostKeyFingerprint: string;
  identitySecretRef: string;
}

// Build an SSH runner handle. The single place that stamps `backend: "ssh"`, so
// allocators (and test fixtures) construct the discriminated handle from their SSH
// reach fields without repeating the tag. Omit `backend` from the input — it is
// always "ssh" here.
export function sshRunnerHandle(fields: Omit<SshRunnerHandle, "backend">): SshRunnerHandle {
  return { backend: "ssh", ...fields };
}

// Narrow an opaque RunnerHandle to its SSH shape. The SSH substrate + the SSH
// allocators are the only places that read SSH reach-fields; they go through this
// so a non-SSH handle is a LOUD failure (never a silent misread) the day a second
// backend lands.
export function asSshRunnerHandle(handle: RunnerHandle): SshRunnerHandle {
  if (handle.backend !== "ssh") {
    throw new Error(`expected an SSH runner handle, got backend "${String(handle.backend)}"`);
  }
  return handle as SshRunnerHandle;
}

export interface AllocationRequest {
  runId: string;
  projectId: string;
  runnerImage: string;
  identitySecretRef: string;
  /**
   * The org the run belongs to. Threaded end-to-end so a backend that persists
   * a `runners` row (a tenant table) writes it under the org's RLS scope rather
   * than off-RLS via a BYPASSRLS role. Optional on the contract so scaffolded /
   * benchmark / fixture constructions keep compiling, but the live worker path
   * always supplies it and the sidecar allocator SERVICE requires it.
   */
  orgId?: string;
  /**
   * RUNLESS allocation marker (Forge ideation). A Forge ideation model call (the
   * greenfield interview / discovery / triage / recon / ⌘K conversation) has NO
   * run — it allocates a short-lived runner for ONE model call. `runId` /
   * `projectId` are still carried as a stable, synthetic HANDLE (used only for
   * runner/container/volume naming, labels, and the per-call CODEX_HOME path) but
   * the persisted `runners` row's FK columns come from {@link persistedRunId} /
   * {@link persistedProjectId} instead — both NULL-able to avoid the
   * run_id→runs / project_id→projects FK violations the synthetic handle causes.
   *
   * `true` is purely a signal that the persisted FK columns are governed by the
   * `persisted*` overrides below (which a runless caller sets). Absent / false ⇒
   * a real run whose `runId` / `projectId` ARE FK-valid rows (the run-executor
   * path), persisted directly.
   */
  runless?: boolean;
  /**
   * Explicit value for the persisted `runners.run_id` column when {@link runless}.
   * `null` ⇒ NULL (no `runs` row — the Forge case). Ignored when `runless` is not
   * set (the run path persists `runId` directly).
   */
  persistedRunId?: string | null;
  /**
   * Explicit value for the persisted `runners.project_id` column when
   * {@link runless}. The REAL project id for a project-scoped Forge surface
   * (discovery / triage / recon / ⌘K — preserves project attribution), or `null`
   * for the project-less greenfield interview. Ignored when `runless` is not set.
   */
  persistedProjectId?: string | null;
  /**
   * Optional run labels used by the allocator router to pick an
   * allocator kind and apply its pool policy. Allocators that do not route on
   * labels ignore this field. Absent / empty means "use the default kind".
   */
  labels?: Record<string, string>;
}

export interface RunnerAllocation {
  runnerId: string;
  target: RunnerHandle;
  imageSha: string;
}

/**
 * The (run_id, project_id) values a backend should PERSIST to the `runners` row's
 * FK columns for an allocation. For a real run they are the request's FK-valid
 * `runId` / `projectId`; for a RUNLESS Forge ideation allocation they are the
 * caller's `persisted*` overrides (NULL run_id always; NULL or the real project
 * id) so the insert does not violate the run_id→runs / project_id→projects FKs.
 * The synthetic naming handle (`request.runId`) is NEVER persisted when runless.
 */
export function persistedRunnerKeys(request: AllocationRequest): {
  runId: string | null;
  projectId: string | null;
} {
  if (request.runless === true) {
    return {
      runId: request.persistedRunId ?? null,
      projectId: request.persistedProjectId ?? null,
    };
  }
  return { runId: request.runId, projectId: request.projectId };
}

export type ReleaseReason = "completed" | "failed" | "abandoned";

/**
 * The taxonomic class every allocator belongs to. The `Allocator` catalog
 * historically bundled three distinct concerns behind a single "provisioning"
 * label (Codex H3 #14/#15/#16) — this taxonomy names them, so consumers that
 * need to reason about lifecycle (does release destroy? does the runner survive
 * across runs?) can branch on a typed capability instead of an ad-hoc allowlist
 * of kinds.
 *
 *   - `provisioning` — creates + destroys a real underlying resource on every
 *     allocate / release. Cloud allocators (hetzner, digitalocean, gcp,
 *     aws_ec2, kubernetes). Release TEARS DOWN the resource; there is nothing
 *     to sweep afterwards.
 *   - `fixed_pool` — leases a pre-existing, long-lived host from a configured
 *     pool (static, manual_ssh). NEVER provisions; NEVER destroys — release
 *     only frees the lease. The host survives across releases, so an
 *     orchestrator crash mid-run leaks the `runners` row (covered by the
 *     orphan sweeper) and the on-host `/workspace/runs/*` (covered by the
 *     run-workspace reaper).
 *   - `delegated` — the orchestrator does not provision the runner itself; it
 *     HTTP-delegates to a sidecar service that owns container lifecycle. From
 *     the orchestrator's perspective the resource IS destroyed on release (the
 *     sidecar tears down); it is "provisioning" in EFFECT but the credentials
 *     and lifecycle logic live in the sidecar service, not here.
 *   - `routed` — the router allocator's honest self-description: it dispatches
 *     each allocate to a backing allocator per label routing, so its own
 *     taxonomy is "consult the routing config". Consumers that need the
 *     concrete class for a specific allocation must resolve it per-kind via
 *     `allocatorTaxonomyFor` in `engine/allocators/poolPolicy.ts`.
 */
export type AllocatorTaxonomy = "provisioning" | "fixed_pool" | "delegated" | "routed";

/**
 * The RUNNER-ALLOCATOR contract. Every implementation hands the orchestrator a
 * connectable {@link RunnerAllocation} and later frees it via {@link release};
 * the LIFECYCLE class each impl belongs to is stated up front via the
 * {@link taxonomy} capability field so consumers can branch on whether release
 * actually destroys a resource without a per-kind allowlist. See
 * {@link AllocatorTaxonomy} for the class definitions.
 */
export interface Allocator {
  /**
   * The lifecycle class this allocator belongs to. Encodes whether allocate /
   * release provision + destroy a real resource (`provisioning`), lease a
   * pre-existing pool host (`fixed_pool`), HTTP-delegate to a sidecar service
   * (`delegated`), or dispatch per-allocate to a backing allocator (`routed`).
   * Consumers that need to reason about whether release destroys — the orphan
   * sweeper, the run-workspace reaper — branch on this rather than an ad-hoc
   * kind list.
   */
  readonly taxonomy: AllocatorTaxonomy;
  allocate(request: AllocationRequest): Promise<RunnerAllocation>;
  /**
   * Release the runner. `reason` is best-effort metadata for the allocator's
   * finalizer log; PROVISIONING + DELEGATED allocators tear the resource down,
   * FIXED-POOL allocators only free the lease (the host survives). Calling
   * release on an already-released runner is a no-op.
   */
  release(runnerId: string, reason?: ReleaseReason): Promise<void>;
}

export class FakeAllocator implements Allocator {
  // Fixed-pool by contract: FakeAllocator's `release()` is a no-op — it does not
  // destroy the (imaginary) host. That matches the "lease, never destroy" shape
  // of fixed_pool, which keeps the conformance suite honest.
  readonly taxonomy: AllocatorTaxonomy = "fixed_pool";
  async allocate(request: AllocationRequest): Promise<RunnerAllocation> {
    return {
      runnerId: `runner_${request.runId}`,
      imageSha: `${request.runnerImage}@sha256:fake`,
      target: sshRunnerHandle({
        host: "runner",
        port: 22,
        username: "tanren",
        hostKeyFingerprint: "SHA256:fake",
        identitySecretRef: request.identitySecretRef,
      }),
    };
  }

  async release(): Promise<void> {}
}
