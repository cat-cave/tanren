import { createHash } from "node:crypto";
import type { DockerEngineClient } from "./dockerEngine.js";
import { requireRunnerAuthorizedKey } from "./requireRunnerAuthorizedKey.js";

export interface RunnerRecord {
  runnerId: string;
  /**
   * The value persisted to `runners.run_id` (FK → `runs`). `null` for a RUNLESS
   * Forge ideation allocation, whose synthetic handle is not a real `runs` row.
   * The runner NAMING handle is carried separately in {@link RunnerRecord.handle};
   * this field is only the DB column value (and is read back as `null`).
   */
  runId: string | null;
  /** The value persisted to `runners.project_id` (FK → `projects`); `null` when runless / project-less. */
  projectId: string | null;
  /**
   * The stable NAMING handle used to derive the runner id, container name, and
   * volume names. Always present (a synthetic `forge_<…>` id when runless). NOT a
   * DB column — recomputed from inputs / `container_id` on read.
   */
  handle: string;
  /** The org the run belongs to; the `runners` row is written under its RLS scope. */
  orgId: string;
  containerId: string;
  workspaceVolume: string;
  codexHomeVolume: string;
  sshHost: string;
  sshPort: number;
  hostKeyFingerprint: string;
  imageSha: string;
  createdAt: Date;
  released: boolean;
}

/**
 * Why the periodic sweeper reclaimed a STUCK runner the normal release path
 * missed — the discriminated stuck-state. Carried on the reclaimed record and
 * stamped onto the durable `runner.swept` audit event.
 *
 * ABANDONMENT IS SIGN-OF-LIFE BASED, NOT WALL-CLOCK BASED. A long-but-ALIVE run
 * (its worker still renewing the job's lease) is NEVER reaped, no matter its age —
 * "10 minutes, or 6 hours, is nothing to an AI agent on a big build". A runner is
 * reaped only when there is genuinely NO sign of life:
 *
 *  - `terminal_run`: the owning run is terminal (completed/failed/halted/cancelled)
 *    yet the runner was never released (the run crashed before its release `finally`).
 *  - `lease_lapsed`: the owning run's worker stopped renewing its `job_queue` lease
 *    — the run has a `running` job whose `leased_until` is in the PAST and no other
 *    live job (queued/claimed/fresh-lease running). The DRIVER is dead, so its
 *    runner is leaked. This replaces the old wall-clock `ttl_exceeded` age cap.
 *  - `unclaimed_grace`: a wedged allocation never tied to a live `runs` row
 *    (run_id IS NULL), older than the grace window.
 */
export type RunnerReclaimReason = "terminal_run" | "lease_lapsed" | "unclaimed_grace";

/** A reclaimable runner: its full record plus the stuck-state the sweeper found it in. */
export interface StuckRunner {
  record: RunnerRecord;
  reason: RunnerReclaimReason;
}

/**
 * The instants the stuck-state query compares against (resolved from the live clock
 * in `sweepStuck`). All are SIGN-OF-LIFE boundaries, never a wall-clock kill of a
 * live run.
 */
export interface StuckThresholds {
  /**
   * Now (the sweep instant). The lease-lapse predicate compares each run's
   * `job_queue.leased_until` against this — a lease expiring BEFORE now means the
   * worker stopped heartbeating (dead driver), regardless of how old the runner is.
   */
  now: Date;
  /**
   * A runner created before this (now − graceMs) is past the allocate→first-heartbeat
   * handoff window. Used to (a) reclaim a run-LESS wedged allocation and (b) absorb
   * the brief window after allocate before the run's first lease lands, so a healthy
   * just-allocated runner is never reaped before its worker has had a chance to
   * record a lease. NOT an age cap on a live run.
   */
  graceThreshold: Date;
}

/** A durable audit record of a sweeper reclaim, written org-scoped on success. */
export interface SweptAudit {
  runnerId: string;
  /** The owning run id, or `null` for a wedged (unclaimed-grace) allocation. */
  runId: string | null;
  projectId: string | null;
  orgId: string;
  reason: RunnerReclaimReason;
}

/** A durable audit record of a runner allocation, written org-scoped on success. */
export interface AllocationAudit {
  runnerId: string;
  /** The real run id, or `null` for a runless Forge allocation. */
  runId: string | null;
  projectId: string | null;
  orgId: string;
  imageSha: string;
  runless: boolean;
}

export interface RunnerStore {
  insert(record: RunnerRecord): Promise<void>;
  markReleased(runnerId: string, reason: string): Promise<RunnerRecord | undefined>;
  findActive(runnerId: string): Promise<RunnerRecord | undefined>;
  /**
   * List every active (un-released) runner in a STUCK state the normal release
   * path missed, each tagged with WHY. A genuine reconciler — a healthy in-flight
   * runner (its owning run still non-terminal AND its worker still renewing the
   * job lease) is NEVER returned, regardless of how long it has been running.
   * Cross-org SYSTEM read (the sweeper reaps across all tenants), so the live impl
   * runs on the BYPASSRLS system pool. See {@link StuckRunner}.
   */
  listStuck(thresholds: StuckThresholds): Promise<StuckRunner[]>;
  /**
   * Append a durable, org-scoped `allocator.allocated` audit event for a
   * successful allocation. Mirrors the audit trail every other MUTATING surface
   * leaves — `/allocate` is a mutating route that previously left none.
   */
  recordAllocated(audit: AllocationAudit): Promise<void>;
  /**
   * Append the durable, org-scoped `runner.swept` audit event proving a sweeper
   * reclaim fired (reason + the non-secret runner/run handles). A leak the
   * per-run `finally` missed is never reclaimed silently.
   */
  recordSwept(audit: SweptAudit): Promise<void>;
}

export interface AllocateInput {
  runId: string;
  projectId: string;
  runnerImage: string;
  /** The org the run belongs to; the runner row is persisted under its RLS scope. */
  orgId: string;
  /**
   * RUNLESS Forge ideation marker. When true, `runId` / `projectId` are a stable
   * synthetic naming HANDLE (still used for the runner id, container, and volume
   * names) but the persisted runners row's run_id column is NULL — the handle is
   * not a real `runs` row, so persisting it would violate the run_id→runs FK.
   */
  runless?: boolean;
  /**
   * The value to persist to project_id when {@link runless}: the REAL project id
   * for a project-scoped Forge surface, or `null` for the project-less greenfield
   * interview. Ignored when `runless` is false (the run path persists `projectId`).
   */
  persistedProjectId?: string | null;
}

export interface AllocateResult {
  runnerId: string;
  sshHost: string;
  sshPort: number;
  hostKeyFingerprint: string;
  imageSha: string;
}

export interface RunnerLifecycleConfig {
  docker: DockerEngineClient;
  store: RunnerStore;
  /** Internal docker network name the allocator attaches each runner to. */
  networkName: string;
  /** When set (dev profile), publishes the runner SSH port on the host. */
  hostSshPort?: number;
  /** Host the orchestrator should SSH to. In prod this is the container DNS name. */
  sshHostnameForOrchestrator: (containerName: string) => string;
  /**
   * Poll delay between host-key readiness probes while a freshly-started container
   * boots sshd. NOT a cap — see {@link readHostKeyFingerprint}: the boot probe
   * polls until the host key appears (readiness) or the container is observed DEAD
   * (genuine failure), with no fixed attempt ceiling.
   */
  hostKeyReadDelayMs?: number;
  /** Backoff utility (overridable for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Extra docker capabilities the runner needs (e.g. SYS_ADMIN for codex sandbox). */
  capAdd?: string[];
  securityOpt?: string[];
  /** Optional clock for testing. */
  now?: () => Date;
}

export class RunnerLifecycle {
  private readonly docker: DockerEngineClient;
  private readonly store: RunnerStore;
  private readonly networkName: string;
  private readonly hostSshPort: number | undefined;
  private readonly hostnameForOrchestrator: (containerName: string) => string;
  private readonly hostKeyReadDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly capAdd: string[];
  private readonly securityOpt: string[];
  private readonly clock: () => Date;

  constructor(config: RunnerLifecycleConfig) {
    this.docker = config.docker;
    this.store = config.store;
    this.networkName = config.networkName;
    this.hostSshPort = config.hostSshPort;
    this.hostnameForOrchestrator = config.sshHostnameForOrchestrator;
    this.hostKeyReadDelayMs = config.hostKeyReadDelayMs ?? 500;
    this.sleep =
      config.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.capAdd = config.capAdd ?? [];
    this.securityOpt = config.securityOpt ?? [];
    this.clock = config.now ?? (() => new Date());
  }

  async allocate(input: AllocateInput): Promise<AllocateResult> {
    // Resolve the PUBLIC authorized_keys line FIRST — fail closed (loud throw) on a
    // blank/unset key BEFORE any side effect, so a misconfigured allocator never
    // spends a volume/container on a runner the orchestrator could never SSH into.
    const runnerAuthorizedKey = requireRunnerAuthorizedKey();
    const runnerId = `runner_${input.runId}`;
    const slug = `tanren-runner-${input.runId}`.replaceAll(/[^A-Za-z0-9_.-]/gu, "-");
    const containerName = slug;
    const workspaceVolume = volumeNamesFor(input.runId).workspace;
    const codexHomeVolume = volumeNamesFor(input.runId).codexHome;

    // Idempotent allocate (fix #3): the runner id is the deterministic
    // `runner_<handle>`, so a RETRIED /allocate for the same handle would, with a
    // bare `ON CONFLICT DO UPDATE`, overwrite a still-LIVE container_id —
    // orphaning the prior container (unreferenced → unsweepable, the 204GB-leak
    // class). Pre-check for a live row and return its SSH target unchanged.
    // Never create a second container for an already-allocated runner.
    const existing = await this.store.findActive(runnerId);
    if (existing !== undefined) {
      return {
        runnerId: existing.runnerId,
        sshHost: existing.sshHost,
        sshPort: existing.sshPort,
        hostKeyFingerprint: existing.hostKeyFingerprint,
        imageSha: existing.imageSha,
      };
    }

    // Side-effect chain (fix #1): every step below is a Docker/DB side effect
    // that can throw — createContainer, startContainer, inspectContainer,
    // readHostKeyFingerprint (throws when the container dies on boot), store.insert
    // (throws on a DB outage). A throw after the first createVolume would orphan the
    // two volumes + the container, INVISIBLE to release/sweepStuck (which key off
    // the DB row that was never written). Wrap the whole chain and tear the
    // partial state down best-effort by deterministic name before re-throwing.
    await this.docker.createVolume(workspaceVolume, allocatorLabels(input.runId));
    await this.docker.createVolume(codexHomeVolume, allocatorLabels(input.runId));

    try {
      const containerId = await this.docker.createContainer({
        name: containerName,
        image: input.runnerImage,
        // No secret VALUE is ever delivered to a runner via Docker env. The only
        // env here is the PUBLIC authorized_keys line (safe) + the ephemeral
        // marker. Run-scoped runner credentials (the tenant's model/codex auth) are
        // written into CODEX_HOME over the SSH FILE substrate AFTER allocation
        // (orchestrator codexMaterializer / opencodeMaterializer), so `docker
        // inspect` on a runner can carry no secret.
        env: {
          TANREN_RUNNER_AUTHORIZED_KEY: runnerAuthorizedKey,
          TANREN_RUNNER_EPHEMERAL: "1",
        },
        labels: allocatorLabels(input.runId),
        volumes: [
          { volumeName: workspaceVolume, containerPath: "/workspace" },
          { volumeName: codexHomeVolume, containerPath: "/tanren-runtime/codex-home" },
        ],
        networkName: this.networkName,
        hostSshPort: this.hostSshPort,
        capAdd: this.capAdd,
        securityOpt: this.securityOpt,
      });

      try {
        await this.docker.startContainer(containerId);
        const inspected = await this.docker.inspectContainer(containerId);
        const hostKeyFingerprint = await this.readHostKeyFingerprint(containerId);

        const sshHost = this.hostnameForOrchestrator(containerName);
        const sshPort = this.hostSshPort ?? 22;

        const record: RunnerRecord = {
          runnerId,
          // Runless Forge ideation: run_id is NULL (no `runs` row); project_id is the
          // caller's `persistedProjectId` (the real project, or null when project-less)
          // — never the synthetic handle. The handle is kept in `handle` for
          // naming/recovery only.
          runId: input.runless === true ? null : input.runId,
          projectId: input.runless === true ? (input.persistedProjectId ?? null) : input.projectId,
          handle: input.runId,
          orgId: input.orgId,
          containerId,
          workspaceVolume,
          codexHomeVolume,
          sshHost,
          sshPort,
          hostKeyFingerprint,
          imageSha: inspected.imageSha,
          createdAt: this.clock(),
          released: false,
        };
        await this.store.insert(record);
        // Durable audit trail: every other mutating surface leaves one; `/allocate`
        // previously left none. Written org-scoped (same RLS scope as the `runners`
        // row) AFTER the row is committed, so the audit reflects only a real
        // allocation.
        await this.store.recordAllocated({
          runnerId,
          runId: record.runId,
          projectId: record.projectId,
          orgId: input.orgId,
          imageSha: inspected.imageSha,
          runless: input.runless === true,
        });

        return {
          runnerId,
          sshHost,
          sshPort,
          hostKeyFingerprint,
          imageSha: inspected.imageSha,
        };
      } catch (error) {
        // The container exists but a later step failed: remove it before falling
        // through to the volume teardown below.
        await this.docker.removeContainer(containerId, true).catch(() => {});
        throw error;
      }
    } catch (error) {
      // Best-effort teardown of the orphaned volumes (the container, if any, was
      // already removed in the inner catch). Each teardown swallows its own
      // failure so it can never MASK the original error — the original is always
      // re-thrown (fail-closed + loud at the caller).
      await this.docker.removeVolume(workspaceVolume).catch(() => {});
      await this.docker.removeVolume(codexHomeVolume).catch(() => {});
      throw error;
    }
  }

  async release(runnerId: string, reason: string): Promise<{ released: boolean }> {
    // markReleased is the SINGLE atomic CLAIM gate (fix #2). It flips the row to
    // released only when it was still active (`AND released_at IS NULL` in the
    // UPDATE), returning the claimed record on rowCount===1 and `undefined` when
    // some other caller already released it. We gate ALL Docker teardown on
    // winning the claim, so two concurrent release() calls tear the same
    // container+volumes down EXACTLY once. The loser is a clean no-op.
    const record = await this.store.markReleased(runnerId, reason);
    if (record === undefined) {
      return { released: false };
    }
    await this.docker.stopContainer(record.containerId);
    await this.docker.removeContainer(record.containerId, true);
    // Workspace + CODEX_HOME volumes are wiped on every release path (success
    // or failure). This is the security boundary the spec calls out: nothing
    // from the previous run survives.
    await this.docker.removeVolume(record.workspaceVolume);
    await this.docker.removeVolume(record.codexHomeVolume);
    return { released: true };
  }

  /**
   * Reconcile STUCK/LEAKED runners the normal release path missed: a runner whose
   * owning run is terminal but unreleased, a runner whose owning run's worker stopped
   * renewing its job lease (the DRIVER is dead — abandonment by SIGN-OF-LIFE, not by
   * age), or a wedged allocation never tied to a live run. A long-but-ALIVE run (lease
   * fresh) is never touched no matter its age. Each stuck candidate is released through
   * the SINGLE atomic claim (`release` → `markReleased`), so a healthy in-flight runner
   * is never touched (the query already excludes it) and a concurrent /release race
   * tears down exactly once. The release reason carries the stuck-state. On a winning
   * claim the reclaimed record is returned WITH its reason so the caller can emit the
   * durable `runner.swept` audit. A release that THROWS is re-thrown to the caller (the
   * sweeper logs + counts it loud — never swallowed).
   *
   * Idempotent: a second sweep over the same DB state reclaims nothing new (the
   * first sweep already flipped released_at; the still-active healthy runners stay
   * excluded by the stuck query).
   */
  async sweepStuck(unclaimedGraceMs: number): Promise<StuckRunner[]> {
    const now = this.clock();
    const thresholds: StuckThresholds = {
      now,
      graceThreshold: new Date(now.getTime() - unclaimedGraceMs),
    };
    const candidates = await this.store.listStuck(thresholds);
    const reclaimed: StuckRunner[] = [];
    for (const candidate of candidates) {
      // The release reason mirrors the stuck-state so the existing release-status
      // vocabulary stays meaningful (`abandoned` for lease-lapsed/wedged, terminal otherwise).
      const result = await this.release(candidate.record.runnerId, releaseReasonFor(candidate.reason));
      // A LIVE→released claim we won; the loser (already released by a concurrent
      // path) returns released:false and is skipped — never double-counted.
      if (result.released) {
        reclaimed.push(candidate);
      }
    }
    return reclaimed;
  }

  /**
   * Wait for a FRESHLY-STARTED container's sshd to publish its host key, then
   * fingerprint it.
   *
   * Boot-readiness probe, NOT a wall-clock timeout. We poll until the key appears
   * (readiness reached) — a container that is simply slow to boot is NEVER given
   * up on by an attempt count. The ONLY give-up condition is genuine FAILURE: the
   * container is observed no longer RUNNING (it crashed/exited on boot), so the
   * host key will never appear. We inspect liveness on each miss; a dead container
   * fails LOUD with its state, a live-but-not-yet-ready one keeps being polled.
   */
  private async readHostKeyFingerprint(containerId: string): Promise<string> {
    let lastError: unknown;
    for (;;) {
      try {
        const publicKey = await this.docker.readContainerFile(containerId, "/etc/ssh/ssh_host_ed25519_key.pub");
        const fingerprint = fingerprintOpenSshPublicKey(publicKey);
        if (fingerprint !== undefined) {
          return fingerprint;
        }
      } catch (error) {
        lastError = error;
      }
      // Sign-of-life gate: only give up when the container is genuinely DEAD — a
      // crashed/exited boot can never expose a host key. A still-running container
      // is just mid-boot, so we keep polling (no attempt cap). A transient inspect
      // failure is itself NOT a give-up signal — we keep polling on the next tick.
      let running = true;
      try {
        running = (await this.docker.inspectContainer(containerId)).running;
      } catch {
        running = true;
      }
      if (!running) {
        throw new Error(
          `runner container ${containerId} exited before exposing an SSH host key (sshd boot failed)${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
        );
      }
      await this.sleep(this.hostKeyReadDelayMs);
    }
  }
}

/**
 * Map a sweeper stuck-reason to the `release()` reason string. All three reclaim
 * paths (lease-lapsed / wedged / terminal-run) resolve to the `abandoned` release
 * STATUS (see pgRunnerStore.releaseStatusFor) — a swept runner is an abandoned one
 * regardless of WHY — but the reason string carries the discriminated cause into
 * the release path for observability.
 */
export function releaseReasonFor(reason: RunnerReclaimReason): string {
  return reason === "terminal_run" ? "abandoned-terminal-run" : "abandoned";
}

export function volumeNamesFor(runId: string): { workspace: string; codexHome: string } {
  const slug = `tanren-runner-${runId}`.replaceAll(/[^A-Za-z0-9_.-]/gu, "-");
  return {
    workspace: `${slug}-workspace`,
    codexHome: `${slug}-codex-home`,
  };
}

export function allocatorLabels(runId: string): Record<string, string> {
  return {
    "tanren.managed-by": "allocator",
    "tanren.run-id": runId,
  };
}

export function fingerprintOpenSshPublicKey(publicKey: Buffer): string | undefined {
  const [, encodedKey] = publicKey.toString("utf8").trim().split(/\s+/u);
  if (encodedKey === undefined || encodedKey === "") {
    return undefined;
  }
  const keyBuffer = Buffer.from(encodedKey, "base64");
  return `SHA256:${createHash("sha256").update(keyBuffer).digest("base64").replace(/=+$/u, "")}`;
}
