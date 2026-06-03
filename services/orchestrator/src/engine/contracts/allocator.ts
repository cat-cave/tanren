export interface SshTarget {
  host: string;
  port: number;
  username: string;
  hostKeyFingerprint: string;
  identitySecretRef: string;
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
   * Optional list of Vault references whose values the allocator must
   * materialize into the runner's `CODEX_HOME` mount before signaling that
   * the runner is ready. The allocator owns the lifetime of any files
   * derived from these refs and wipes them on release.
   */
  vaultRefs?: string[];
  /**
   * Optional run labels used by the allocator router (P3-0027) to pick an
   * allocator kind and apply its pool policy. Allocators that do not route on
   * labels ignore this field. Absent / empty means "use the default kind".
   */
  labels?: Record<string, string>;
}

export interface RunnerAllocation {
  runnerId: string;
  target: SshTarget;
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
      target: {
        host: "runner",
        port: 22,
        username: "tanren",
        hostKeyFingerprint: "SHA256:fake",
        identitySecretRef: request.identitySecretRef,
      },
    };
  }

  async release(): Promise<void> {}
}
