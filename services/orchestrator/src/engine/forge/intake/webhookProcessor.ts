// §3.6 issue-loop hardening — the BACKGROUND processor + sweeper for persisted
// webhook deliveries (the persist-then-202 second half).
//
// The receiver now PERSISTS a verified delivery to `webhook_events` and returns
// 202 fast (no triage inline). This module drains those rows OUT of band:
//
//   processWebhookEvent — map ONE persisted delivery → the shared `intakeItem`
//     pipeline (triage → auto-route/inbox), under the source's org scope. Success
//     marks the row `processed`; a TRANSIENT failure marks it `failed` (the sweeper
//     re-drives it UNBOUNDED — a self-healing blip is never lost to a count). A
//     POISON failure — a genuinely non-recoverable delivery: a vanished source, an
//     unsupported mapping, or a `PersistentlyInvalidSpecError` (the spec-quality
//     gate's loud "needs human attention" surface, §3.6 fix 6) — is dead-lettered
//     immediately rather than re-triaged on a 5-minute LLM-cost loop forever.
//
// TIMEOUT-ERADICATION (feedback_no_timeouts_progress_based, BINDING): there is NO
// attempt-cap dead-letter. The terminal decision is the failure's NATURE (transient
// vs poison), not a count — retry transient forever, surface poison loud at once.
//
//   sweepWebhookEvents / sweepStuckCandidates — the sweeper the poller tick calls:
//     re-drive every undriven `received`/`failed` row and every stuck `auto_routed`
//     candidate (idempotently — `intakeItem` + `autoRouteCandidate` key on
//     (source, externalId)). This is what makes a transiently-failed intake
//     NEVER silently lost.

import type pg from "pg";
import { randomUUID } from "node:crypto";
import { runWithJobOrgId, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import { ZodError } from "zod";
import { orgScopingPool } from "../../data/orgScopedDb.js";
import {
  autoRouteCandidate,
  InboxStore,
  type AutoRouteDeps,
  type InboxSource,
  type TriageAnswerer,
} from "../inbox/index.js";
import { PersistentlyInvalidSpecError } from "../specQuality/index.js";
import { intakeItem } from "./pipeline.js";
import { GithubWebhookScopeMismatchError, mapGithubIssueWebhook } from "./webhookMapping.js";
import { WebhookEventStore, type WebhookEvent } from "../../repositories/webhookEvents.js";
import { loadRunnableInboxSource } from "./sourceValidation.js";

// How many undriven rows / stuck candidates a single sweep tick re-drives per org
// (bounds the work per tick; the rest carry to the next tick).
const SWEEP_BATCH = 20;
export const DEFAULT_WEBHOOK_CLAIM_LEASE_MS = 5 * 60 * 1000;

export interface WebhookProcessorDeps {
  pool: pg.Pool;
  // The per-source triage answerer factory (real provider answerer in prod).
  answererFactory: (target: { orgId: string; projectId?: string }) => TriageAnswerer;
  // The autonomous DAG-insert deps (system actor) — identical to the receiver/poller.
  autoRoute: AutoRouteDeps;
  // Stable identity for one processor instance. Tests and multiple pollers can
  // inject distinct identities to prove the lease CAS; omitted calls get a
  // process-attempt identity and still cannot settle another live claim.
  workerId?: string;
  claimLeaseMs?: number;
  /**
   * Optional companion record for a claimed GitHub issue delivery. Production
   * supplies the IssueSourceAdapter recorder; the webhook event still has one
   * durable persistence/claim/retry path here.
   */
  recordIssueObservation?: (source: InboxSource, event: WebhookEvent) => Promise<void>;
}

// Map a persisted webhook event's payload to an ingest item. Only `issues` is
// wired today (the receiver only persists `issues` events); an unknown type is a
// hard, non-recoverable mapping error so it dead-letters rather than re-driving.
function mapEvent(event: WebhookEvent, source: InboxSource) {
  if (event.eventType !== "issues") {
    return { kind: "skip" as const, reason: `unsupported webhook event type: ${event.eventType}` };
  }
  return mapGithubIssueWebhook(event.payload, source);
}

/**
 * Process ONE persisted webhook event end-to-end. Resolves the source, maps the
 * payload, runs the shared intake pipeline under the source's org scope, and marks
 * the row terminally. Returns whether it ended `processed` (a `skip` mapping is a
 * legitimate processed no-op — e.g. a closed issue). Recoverable failures mark the
 * row `failed`/`dead_lettered` and DO NOT throw (the sweeper continues to others).
 */
export async function processWebhookEvent(deps: WebhookProcessorDeps, event: WebhookEvent): Promise<boolean> {
  const workerId = deps.workerId ?? `webhook-worker-${randomUUID()}`;
  const claimed = await runWithOrgScope(deps.pool, event.orgId, (client) =>
    WebhookEventStore.claim(client, {
      id: event.id,
      workerId,
      leaseMs: deps.claimLeaseMs ?? DEFAULT_WEBHOOK_CLAIM_LEASE_MS,
    }),
  );
  if (claimed === undefined) return false;
  event = claimed;

  let source: InboxSource;
  try {
    // Event org is authority: an old hostile (org B, source A) tuple must fail
    // before mapping, answerer, candidate, or source-org effects.
    source = await runWithSystemScope(deps.pool, (client) =>
      loadRunnableInboxSource(client, { sourceId: event.sourceId, orgId: event.orgId }),
    );
  } catch {
    await markFailure(deps, event, "source_lineage_or_state_invalid", true, workerId);
    return false;
  }

  let mapped: ReturnType<typeof mapEvent>;
  try {
    // bh-7 observes the exact delivery bh-3 already persisted and claimed. It
    // does not create a second webhook processor; a failed observation leaves
    // this event recoverable for this processor's normal sweeper retry.
    mapped = mapEvent(event, source);
    await deps.recordIssueObservation?.(source, event);
  } catch (error) {
    const poison = error instanceof ZodError || error instanceof GithubWebhookScopeMismatchError;
    await markFailure(deps, event, messageOf(error), poison, workerId);
    return false;
  }
  if (mapped.kind === "skip") {
    // A non-ingest action (closed/deleted/PR) is a real terminal — mark processed.
    await runWithOrgScope(deps.pool, event.orgId, (client) => WebhookEventStore.complete(client, event.id, workerId));
    return true;
  }

  try {
    await runWithJobOrgId(source.orgId, () =>
      intakeItem(
        {
          pool: orgScopingPool(deps.pool),
          answerer: deps.answererFactory({
            orgId: source.orgId,
            ...(source.projectId === null ? {} : { projectId: source.projectId }),
          }),
          autoRoute: deps.autoRoute,
        },
        source,
        mapped.item,
      ),
    );
  } catch (error) {
    // §3.6 fix 6: a spec the quality gate could not make valid (it reached a genuine
    // non-convergence fixed point) is NOT a transient — re-triaging it on every sweep
    // would be an infinite LLM-cost loop. POISON: dead-letter it immediately (loud
    // terminal). Everything else is transient — stays `failed`, re-driven UNBOUNDED.
    const poison = error instanceof PersistentlyInvalidSpecError;
    await markFailure(deps, event, messageOf(error), poison, workerId);
    return false;
  }

  await runWithOrgScope(deps.pool, event.orgId, (client) => WebhookEventStore.complete(client, event.id, workerId));
  return true;
}

// Record a processing failure org-scoped. `poison: true` (a genuinely non-recoverable
// delivery) dead-letters on this very attempt; `poison: false` (a transient blip)
// stays `failed` so the sweeper re-drives it UNBOUNDED — never lost to a count.
async function markFailure(
  deps: WebhookProcessorDeps,
  event: WebhookEvent,
  error: string,
  poison: boolean,
  workerId: string,
): Promise<void> {
  await runWithOrgScope(deps.pool, event.orgId, (client) =>
    WebhookEventStore.recordFailure(client, event.id, error, poison, workerId),
  );
}

/**
 * Sweep: re-drive every undriven (`received`/`failed`) webhook event across all
 * orgs (system-scoped fan-out, then per-org under RLS), bounded per org. This is
 * the never-silently-lost guarantee — a delivery whose inline processing failed is
 * picked up here next tick. Returns the count re-driven (tests assert).
 */
export async function sweepWebhookEvents(deps: WebhookProcessorDeps): Promise<number> {
  const orgIds = await runWithSystemScope(deps.pool, (client) => InboxStore.listDistinctEnabledSourceOrgIds(client));
  let count = 0;
  for (const orgId of orgIds) {
    const events = await runWithOrgScope(deps.pool, orgId, (client) =>
      WebhookEventStore.listUndriven(client, SWEEP_BATCH),
    );
    for (const event of events) {
      await processWebhookEvent(deps, event);
      count += 1;
    }
  }
  return count;
}

/**
 * Sweep: re-drive every candidate stranded `auto_routed` with no resolved spec —
 * the verdict said auto-route but the DAG commit never landed (a crash between the
 * upsert and `autoRouteCandidate`). Re-running the auto-route is idempotent on
 * (source, externalId). Returns the count re-driven.
 */
export async function sweepStuckCandidates(deps: WebhookProcessorDeps): Promise<number> {
  const orgIds = await runWithSystemScope(deps.pool, (client) => InboxStore.listDistinctEnabledSourceOrgIds(client));
  let count = 0;
  for (const orgId of orgIds) {
    const stuck = await runWithOrgScope(deps.pool, orgId, (client) =>
      InboxStore.listStuckAutoRouted(client, SWEEP_BATCH),
    );
    for (const candidate of stuck) {
      const routableSpec = candidate.triage?.routableSpec ?? null;
      if (candidate.projectId === null || routableSpec === null) continue;
      try {
        await runWithJobOrgId(orgId, () =>
          autoRouteCandidate({ pool: orgScopingPool(deps.pool) }, candidate, routableSpec, deps.autoRoute),
        );
        count += 1;
      } catch (error) {
        // A persistently-invalid stuck spec is escalated by resolving the candidate
        // OUT of `auto_routed` so the sweep stops re-driving it (loud — it leaves the
        // auto path for operator review). Everything else retries next sweep.
        if (error instanceof PersistentlyInvalidSpecError) {
          await runWithOrgScope(deps.pool, orgId, (client) =>
            InboxStore.resolveCandidate(client, candidate.id, "triaged", null),
          );
        }
      }
    }
  }
  return count;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
