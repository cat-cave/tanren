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

export interface Allocator {
  allocate(request: AllocationRequest): Promise<RunnerAllocation>;
  /**
   * Release the runner. `reason` is best-effort metadata for the allocator's
   * finalizer log; allocator implementations must always run the same
   * destroy + wipe path regardless of the reason. Calling release on an
   * already-released runner is a no-op.
   */
  release(runnerId: string, reason?: ReleaseReason): Promise<void>;
}

export class FakeAllocator implements Allocator {
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
