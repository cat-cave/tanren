// The MergeCoordinator subscriber (autonomy-engine.md §2d, §1.5): a long-lived
// per-process listener that drives the per-project MergeCoordinator on startup and
// on every run.*-terminal / merge.completed notification — reacting to the events
// ALREADY on the LISTEN/NOTIFY bus, no new polling. It is the wiring the worker
// boot starts so the native merge queue self-advances.
//
// Mechanism mirrors the DagWalkerSubscriber: the eventStore fires a `tanren_run`
// NOTIFY (payload = the run id) at every run-state change. This subscriber wakes on
// that channel, resolves the run's project under the system scope, and coordinates
// that project's queue. Each pass merges AT MOST ONE entry (serialization); a merge
// completing fires another `tanren_run` notification (the merge finalizes the run),
// which re-triggers the coordinator to pick the NEXT DAG-ordered head — so A merges,
// then B, then C in dependency order, one at a time.
//
// Coalesced per project (like the walker): a project already coordinating
// re-coordinates once when its current pass finishes, so a notification storm
// collapses to at most one follow-up pass. The atomic queue claim is the hard
// serialization boundary regardless; coalescing keeps the load sane.

import { NOTIFICATION_CHANNEL, RUN_ACTIVITY_CHANNEL, type PgNotifyListener, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { Allocator } from "../contracts/allocator.js";
import type { MergeCoordinator } from "../contracts/mergeCoordinator.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { VcsProvider } from "../contracts/vcsProvider.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { buildBatchMergeCoordinator } from "./batchCoordinatorBuild.js";

export interface MergeCoordinatorSubscriberDeps {
  pool: pg.Pool;
  /** The shared LISTEN connection (the SAME one the SSE source / walker use). */
  notifyListener: PgNotifyListener;
  /** Required when `coordinator` is not injected (the production path). */
  secrets?: SecretStore;
  vcsProvider?: VcsProvider;
  githubAppMinter?: GithubAppTokenMinter;
  /**
   * The runner allocator + SSH substrate + identity ref the drive-path conflict
   * resolver provisions a short-lived runner from (the original run's runner is
   * gone by drive time). REQUIRED when `coordinator` is not injected (the
   * production path) — a missing allocator/ssh on a real conflict is a LOUD throw,
   * never a silent revert to the deleted blind-re-exec.
   */
  allocator?: Allocator;
  ssh?: CommandSubstrate;
  identitySecretRef?: string;
  /**
   * Plane-split (autonomy loops): the control-plane run-state writer. When present
   * (remote-writes on), the production coordinator routes EVERY tenant write it
   * drives (merge-stage events/tasks/runs/specs, spec-status finalize, conflict
   * re-exec, queue/batch events) through the control plane; absent, direct on the
   * pool (byte-identical). Only consulted when `coordinator` is not injected.
   */
  runStateWriter?: RunStateWriter;
  /**
   * The coordinator to drive. Defaults to the production
   * `buildBatchMergeCoordinator(...)` (via `buildProductionCoordinator`). A test
   * injects a recording coordinator to assert the event-driven trigger fires it.
   */
  coordinator?: MergeCoordinator;
  /**
   * Injectable wall clock (ms epoch) for the pending-hold debounce window — defaults
   * to `Date.now`. A test overrides it to drive the debounce deterministically.
   */
  now?: () => number;
}

/**
 * Bug B — the NOTIFY-storm debounce window (ms). While a project is in a timed hold
 * (pending batch/no-checks settle, or a same-candidate `merge_retry` backoff),
 * NOTIFY-driven re-passes are SUPPRESSED for this window so unrelated `tanren_run`
 * NOTIFYs do not burn retry attempts early. The armed re-drive timer (`retryAfterMs`)
 * is the AUTHORITATIVE re-check; it bypasses the suppression. The window is kept SHORT (≤ the
 * registered-check settle cadence) so a GENUINE check-completion / merge.completed NOTIFY is still reacted to
 * within one window — the debounce throttles the storm, it never silences a real
 * completion. It applies ONLY to the pending-hold state, never to a clean pass.
 */
const PENDING_DEBOUNCE_MS = 5_000;

/** Resolve a run's project id, system-scoped (the `tanren_run` payload is run-only). */
async function resolveRunProject(pool: pg.Pool, runId: string): Promise<string | undefined> {
  return runWithSystemScope(pool, async (client) => {
    const result = await client.query<{ project_id: string | null }>("SELECT project_id FROM runs WHERE run_id = $1", [
      runId,
    ]);
    return result.rows[0]?.project_id ?? undefined;
  });
}

async function resolveCredentialRepairProjects(pool: pg.Pool, eventId: string): Promise<string[]> {
  return runWithSystemScope(pool, async (client) => {
    const result = await client.query<{
      project_id: string | null;
      org_id: string | null;
      event_type: string;
      payload: Record<string, unknown> | null;
    }>("SELECT project_id, org_id, event_type, payload FROM events WHERE id = $1", [eventId]);
    const row = result.rows[0];
    if (
      row === undefined ||
      !(
        row.event_type === "credential.configured" ||
        row.event_type === "credential.github.configured" ||
        row.event_type === "org.github.connected" ||
        (row.event_type === "integration.provisioned" && row.payload?.["providerKind"] === "github") ||
        row.payload?.["provider"] === "github"
      )
    ) {
      return [];
    }
    if (row.project_id !== null) return [row.project_id];
    if (row.org_id === null) return [];

    const projects = await client.query<{ project_id: string }>(
      `SELECT DISTINCT project_id
         FROM merge_queue
        WHERE org_id = $1
          AND status IN ('queued', 'merging', 'dequeued')
        ORDER BY project_id`,
      [row.org_id],
    );
    return projects.rows.map((project) => project.project_id);
  });
}

/** Discover every project that has a native merge queue to coordinate (system-scoped). */
async function listProjectsWithQueue(pool: pg.Pool): Promise<string[]> {
  return runWithSystemScope(pool, async (client) => {
    const result = await client.query<{ project_id: string }>(
      `SELECT DISTINCT mq.project_id
         FROM merge_queue mq
        WHERE mq.status IN ('queued', 'merging')
           OR (
             mq.status = 'dequeued'
             AND mq.dequeue_reason = 'blocked'
             AND mq.pr_url IS NOT NULL
             AND mq.pr_url <> ''
             AND mq.pr_number IS NOT NULL
             AND NOT EXISTS (
               SELECT 1
                 FROM merge_queue active
                WHERE active.run_id = mq.run_id
                  AND active.status IN ('queued', 'merging')
             )
             AND COALESCE((
               SELECT (
                   latest.event_type = 'merge.dequeued'
                   AND latest.payload ->> 'integration' = 'native_queue'
                   AND latest.payload ->> 'reason' = 'blocked'
                 )
                 OR (
                   latest.event_type = 'merge.batch.infra_blocked'
                   AND latest.payload ->> 'terminal' = 'true'
                   AND (
                     latest.payload ->> 'kind' = 'missing_required_credential'
                     OR latest.payload ->> 'cause' IN ('missing_required_credential', 'missing_github_credential')
                     OR latest.payload ->> 'reason' IN ('missing_required_credential', 'missing_github_credential')
                     OR latest.payload ->> 'message' LIKE '%missing GitHub credential ref:%'
                     OR latest.payload ->> 'message' LIKE '%missing % credential ref:%'
                     OR latest.payload ->> 'message' LIKE '%No GitHub credential configured%'
                   )
                   AND EXISTS (
                     SELECT 1
                       FROM events repair
                      WHERE repair.project_id = mq.project_id
                        AND repair.org_id = mq.org_id
                        AND (repair.ts > latest.ts OR (repair.ts = latest.ts AND repair.id > latest.id))
                        AND (
                          repair.event_type IN ('credential.configured', 'credential.github.configured')
                          OR (
                            repair.event_type = 'integration.provisioned'
                            AND repair.payload ->> 'providerKind' = 'github'
                          )
                          OR repair.event_type = 'org.github.connected'
                          OR repair.payload ->> 'provider' = 'github'
	                        )
	                        AND (
	                          repair.payload ->> 'mode' = 'app'
	                          OR repair.payload ->> 'credentialKind' = 'github_app'
	                          OR COALESCE(
	                            NULLIF(latest.payload ->> 'credentialRef', ''),
	                            NULLIF(latest.payload ->> 'missingRef', ''),
	                            NULLIF(latest.payload ->> 'requiredCredentialRef', ''),
                            substring(latest.payload ->> 'message' from 'missing [^:]* credential ref: ([^[:space:]]+)')
                          ) IS NULL
                          OR repair.payload ->> 'credentialRef' = COALESCE(
                            NULLIF(latest.payload ->> 'credentialRef', ''),
                            NULLIF(latest.payload ->> 'missingRef', ''),
                            NULLIF(latest.payload ->> 'requiredCredentialRef', ''),
                            substring(latest.payload ->> 'message' from 'missing [^:]* credential ref: ([^[:space:]]+)')
                          )
                          OR repair.payload ->> 'ref' = COALESCE(
                            NULLIF(latest.payload ->> 'credentialRef', ''),
                            NULLIF(latest.payload ->> 'missingRef', ''),
                            NULLIF(latest.payload ->> 'requiredCredentialRef', ''),
	                            substring(latest.payload ->> 'message' from 'missing [^:]* credential ref: ([^[:space:]]+)')
	                          )
	                          OR EXISTS (
	                            SELECT 1
	                              FROM jsonb_array_elements_text(
	                                CASE WHEN jsonb_typeof(repair.payload -> 'secretRefNames') = 'array'
	                                  THEN repair.payload -> 'secretRefNames'
	                                  ELSE '[]'::jsonb
	                                END
	                              ) AS secret_ref(ref)
	                             WHERE secret_ref.ref = COALESCE(
	                               NULLIF(latest.payload ->> 'credentialRef', ''),
	                               NULLIF(latest.payload ->> 'missingRef', ''),
	                               NULLIF(latest.payload ->> 'requiredCredentialRef', ''),
	                               substring(latest.payload ->> 'message' from 'missing [^:]* credential ref: ([^[:space:]]+)')
	                             )
	                          )
	                        )
	                   )
	                 )
                 FROM events latest
                WHERE latest.id = (
                  SELECT e.id
                    FROM events e
                   WHERE e.project_id = mq.project_id
                     AND e.org_id = mq.org_id
                     AND (
                       e.event_type IN (
                         'merge.dequeued',
                         'merge.completed',
                         'merge.queue.infra_blocked',
                         'merge.batch.culprit',
                         'dag.spec.needs_attention',
                         'dag.spec.percolation_replan',
                         'merge.conflict.replan_routed',
                         'recovery.replan_queued'
                       )
                       OR (e.event_type = 'merge.batch.infra_blocked' AND e.payload ->> 'terminal' = 'true')
                     )
                     AND (
                       (e.run_id IS NOT NULL AND e.run_id = mq.run_id)
                       OR (NULLIF(e.payload ->> 'runId', '') IS NOT NULL AND e.payload ->> 'runId' = mq.run_id)
                       OR (NULLIF(e.payload ->> 'prUrl', '') IS NOT NULL AND e.payload ->> 'prUrl' = mq.pr_url)
                       OR (NULLIF(e.payload ->> 'prNumber', '') IS NOT NULL AND e.payload ->> 'prNumber' = mq.pr_number)
                       OR EXISTS (
                         SELECT 1
                           FROM jsonb_array_elements(
                             CASE WHEN jsonb_typeof(e.payload -> 'members') = 'array'
                               THEN e.payload -> 'members'
                               ELSE '[]'::jsonb
                             END
                           ) AS member
                          WHERE member ->> 'prNumber' = mq.pr_number
                             OR member ->> 'specId' = mq.spec_id
                       )
                       OR (
                         e.event_type IN (
                           'dag.spec.needs_attention',
                           'dag.spec.percolation_replan',
                           'merge.conflict.replan_routed',
                           'recovery.replan_queued'
                         )
                         AND e.spec_id = mq.spec_id
                       )
                     )
                   ORDER BY e.ts DESC, e.id DESC
                   LIMIT 1
                )
             ), false)
           )
        ORDER BY mq.project_id`,
    );
    return result.rows.map((row) => row.project_id);
  });
}

/**
 * The running subscriber handle: coordinates every queued project once on start,
 * then coordinates a project whenever one of its runs reaches a state change.
 * `stop()` unsubscribes (idempotent). Per-project passes are coalesced so a storm
 * of notifications collapses into at most one in-flight pass + one queued re-pass.
 */
export class MergeCoordinatorSubscriber {
  private readonly coordinator: MergeCoordinator;
  private unsubscribe: (() => void) | undefined;
  private eventUnsubscribe: (() => void) | undefined;
  private stopped = false;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly rePending = new Set<string>();
  /**
   * One-shot delayed re-drive timers, keyed by project — armed when a coordinate pass
   * HELD on a transient condition (an infra error) that no `tanren_run` NOTIFY will
   * clear on its own, so a stuck single-PR queue still recovers. Bounded + IDEMPOTENT:
   * at most one timer per project (a second hold while one is armed is a no-op — never
   * stacked), and the timer is cleared on `stop()`.
   */
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Bug B debounce: per-project deadline (ms epoch) until which NOTIFY-driven re-passes
   * are SUPPRESSED because the project is in a timed hold. Set when a coordinate pass
   * returns a pending or merge-retry hold; consulted ONLY in the NOTIFY path (`onRunActivity`). The
   * authoritative re-check is the armed `retryAfterMs` timer, which bypasses this.
   */
  private readonly pendingHoldUntil = new Map<string, number>();
  /** Injectable clock (ms epoch) for the pending-hold debounce — defaults to Date.now. */
  private readonly now: () => number;

  constructor(private readonly deps: MergeCoordinatorSubscriberDeps) {
    this.coordinator = deps.coordinator ?? this.buildProductionCoordinator();
    this.now = deps.now ?? Date.now;
  }

  private buildProductionCoordinator(): MergeCoordinator {
    const { secrets, vcsProvider, allocator, ssh, identitySecretRef } = this.deps;
    if (secrets === undefined || vcsProvider === undefined) {
      throw new Error("MergeCoordinatorSubscriber requires secrets + vcsProvider when no coordinator is injected");
    }
    // The drive-path conflict resolver provisions a short-lived runner + workspace to
    // run the REAL intent-preserving resolver (the blind-re-exec stub is gone). Its
    // allocator/ssh/identity are REQUIRED for the production coordinator — a missing
    // one is a LOUD throw at assembly, never a silent revert on the conflict path.
    if (allocator === undefined || ssh === undefined || identitySecretRef === undefined) {
      throw new Error(
        "MergeCoordinatorSubscriber requires allocator + ssh + identitySecretRef when no coordinator is injected (the drive-path conflict resolver provisions a runner)",
      );
    }
    // the native-queue driver is the speculative batch-check + bisect
    // coordinator (it forms a batch, proves the prospective merged state green as a
    // unit, then drives the SAME per-run merges in DAG order — a bad interaction
    // is bisected to one PR rather than stalling the batch).
    return buildBatchMergeCoordinator({
      pool: this.deps.pool,
      secrets,
      vcsProvider,
      allocator,
      ssh,
      identitySecretRef,
      ...(this.deps.githubAppMinter !== undefined && { githubAppMinter: this.deps.githubAppMinter }),
      // Plane-split: route every coordinator-driven tenant write through the
      // control plane when wired; else direct on the pool (byte-identical).
      ...(this.deps.runStateWriter !== undefined && { runStateWriter: this.deps.runStateWriter }),
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async start(): Promise<void> {
    void this.subscribeInBackground();
    void this.driveAllProjects();
  }

  private async subscribeInBackground(): Promise<void> {
    try {
      const unsubscribe = await this.deps.notifyListener.subscribe(RUN_ACTIVITY_CHANNEL, (payload) => {
        void this.onRunActivity(payload).catch((error: unknown) => {
          console.error(`[merge-coordinator] run-activity handler failed for run ${payload}:`, error);
        });
      });
      const eventUnsubscribe = await this.deps.notifyListener.subscribe(NOTIFICATION_CHANNEL, (payload) => {
        void this.onEventActivity(payload).catch((error: unknown) => {
          console.error(`[merge-coordinator] event handler failed for event ${payload}:`, error);
        });
      });
      if (this.stopped) {
        unsubscribe();
        eventUnsubscribe();
        return;
      }
      this.unsubscribe = unsubscribe;
      this.eventUnsubscribe = eventUnsubscribe;
    } catch (error) {
      console.error("[merge-coordinator] failed to subscribe to the run-activity bus (will not auto-advance):", error);
    }
  }

  private async driveAllProjects(): Promise<void> {
    try {
      const projectIds = await listProjectsWithQueue(this.deps.pool);
      await Promise.all(projectIds.map((projectId) => this.schedule(projectId)));
    } catch (error) {
      console.error("[merge-coordinator] initial queue drive failed (will drive on the next notification):", error);
    }
  }

  /** Stop listening. Idempotent; in-flight passes finish on their own. */
  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.eventUnsubscribe?.();
    this.eventUnsubscribe = undefined;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.pendingHoldUntil.clear();
  }

  /**
   * Arm a ONE-SHOT delayed re-drive of `projectId` after `delayMs` (the coordinator's
   * `retryAfterMs` from an infra-error hold). Idempotent: if a timer is already armed
   * for this project, do nothing — never stack timers. Cleared on `stop()`.
   */
  private armDelayedReDrive(projectId: string, delayMs: number): void {
    if (this.stopped || this.retryTimers.has(projectId)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(projectId);
      // This timer IS the authoritative re-check for a pending/infra hold — clear the
      // NOTIFY-suppression window so the re-drive (and any NOTIFY after it) runs fresh.
      this.pendingHoldUntil.delete(projectId);
      if (this.stopped) return;
      void this.schedule(projectId);
    }, delayMs);
    // Do not keep the event loop alive solely for this re-drive timer.
    timer.unref?.();
    this.retryTimers.set(projectId, timer);
  }

  private async onRunActivity(runId: string): Promise<void> {
    if (runId === "") return;
    const projectId = await resolveRunProject(this.deps.pool, runId);
    if (projectId === undefined) return;
    // Bug B debounce: while this project is in a pending-hold window, SUPPRESS the
    // NOTIFY-driven re-pass — the armed `retryAfterMs` timer is the authoritative
    // re-check. This collapses a `tanren_run` NOTIFY storm (concurrent specs emit
    // ~2/sec) into at most one batch integration per window, killing the no-CI hot
    // loop. The window is short (≤ the registered-check settle cadence) so a GENUINE check-completion
    // NOTIFY is still reacted to within one window once the hold lapses — it throttles
    // the storm, never silences a real completion.
    const holdUntil = this.pendingHoldUntil.get(projectId);
    if (holdUntil !== undefined && this.now() < holdUntil) return;
    await this.schedule(projectId);
  }

  private async onEventActivity(eventId: string): Promise<void> {
    if (eventId === "") return;
    const projectIds = await resolveCredentialRepairProjects(this.deps.pool, eventId);
    await Promise.all(projectIds.map((projectId) => this.schedule(projectId)));
  }

  /** Coordinate a project, coalescing concurrent requests (latest state, once). */
  private schedule(projectId: string): Promise<void> {
    const existing = this.inFlight.get(projectId);
    if (existing !== undefined) {
      this.rePending.add(projectId);
      return existing;
    }
    const run = this.runChain(projectId).finally(() => {
      this.inFlight.delete(projectId);
    });
    this.inFlight.set(projectId, run);
    return run;
  }

  /** Coordinate, then re-coordinate while a trigger arrived mid-pass. */
  private async runChain(projectId: string): Promise<void> {
    do {
      this.rePending.delete(projectId);
      try {
        const result = await this.coordinator.coordinate(projectId);
        // A pending/infra hold returns no merge AND no `tanren_run` NOTIFY is guaranteed
        // to re-trigger this project on its own (a clean single-PR queue would otherwise
        // hang; a no-checks settle expires on wall time). Arm a bounded, idempotent
        // one-shot re-drive so the held batch is re-checked once it clears.
        if (
          result.retryAfterMs !== undefined &&
          (!this.rePending.has(projectId) || result.holdReason === "merge_retry")
        ) {
          // Bug B: a PENDING hold and a merge_retry backoff open a NOTIFY-suppression
          // window so unrelated run activity does not hot-loop the integration or burn
          // retry attempts early. Infra-error holds still allow prompt clearing signals.
          if (result.holdReason === "merge_retry") {
            this.pendingHoldUntil.set(projectId, this.now() + Math.max(PENDING_DEBOUNCE_MS, result.retryAfterMs));
            this.rePending.delete(projectId);
          } else if (result.holdReason === "all_blocked") {
            this.pendingHoldUntil.set(projectId, this.now() + PENDING_DEBOUNCE_MS);
          }
          this.armDelayedReDrive(projectId, result.retryAfterMs);
        } else if (result.retryAfterMs === undefined) {
          // A pass that did NOT hold-pending (a merge advanced, a dequeue, or a clean
          // empty/serialized hold) clears any stale suppression window so the next
          // NOTIFY re-checks immediately — the debounce only ever spans a live hold.
          this.pendingHoldUntil.delete(projectId);
        }
      } catch (error) {
        console.error(`[merge-coordinator] coordinate pass failed for project ${projectId}:`, error);
      }
    } while (this.rePending.has(projectId));
  }
}

/** Build + start the MergeCoordinator subscriber from the worker boot. */
export async function startMergeCoordinatorSubscriber(
  deps: MergeCoordinatorSubscriberDeps,
): Promise<MergeCoordinatorSubscriber> {
  const subscriber = new MergeCoordinatorSubscriber(deps);
  await subscriber.start();
  return subscriber;
}
