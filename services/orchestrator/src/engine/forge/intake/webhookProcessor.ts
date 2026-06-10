// §3.6 issue-loop hardening — the BACKGROUND processor + sweeper for persisted
// webhook deliveries (the persist-then-202 second half).
//
// The receiver now PERSISTS a verified delivery to `webhook_events` and returns
// 202 fast (no triage inline). This module drains those rows OUT of band:
//
//   processWebhookEvent — map ONE persisted delivery → the shared `intakeItem`
//     pipeline (triage → auto-route/inbox), under the source's org scope. Success
//     marks the row `processed`; a recoverable failure marks it `failed` (the
//     sweeper re-drives it) and bumps an attempt count that dead-letters the row
//     once exhausted — never an infinite re-drive. A `PersistentlyInvalidSpecError`
//     (the spec-quality gate's loud "needs human attention" surface, §3.6 fix 6) is
//     NOT recoverable: it is dead-lettered immediately rather than re-triaged on a
//     5-minute LLM-cost loop forever.
//
//   sweepWebhookEvents / sweepStuckCandidates — the sweeper the poller tick calls:
//     re-drive every undriven `received`/`failed` row and every stuck `auto_routed`
//     candidate (idempotently — `intakeItem` + `autoRouteCandidate` key on
//     (source, externalId)). This is what makes a transiently-failed intake
//     NEVER silently lost.

import type pg from "pg";
import { runWithJobOrgId, runWithOrgScope, runWithSystemScope } from "@tanren/db";
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
import { mapGithubIssueWebhook } from "./webhookMapping.js";
import { WebhookEventStore, type WebhookEvent } from "../../repositories/webhookEvents.js";

// The attempt budget before a webhook event is dead-lettered (a loud terminal a
// human must look at). Generous — a genuinely transient failure (LLM timeout, DB
// blip) clears in one or two re-drives; only a persistently-broken delivery
// exhausts it. NOT a cost loop: a dead-lettered row is never re-driven.
export const WEBHOOK_EVENT_MAX_ATTEMPTS = 5;

// How many undriven rows / stuck candidates a single sweep tick re-drives per org
// (bounds the work + the LLM spend per tick; the rest carry to the next tick).
const SWEEP_BATCH = 20;

export interface WebhookProcessorDeps {
  pool: pg.Pool;
  // The per-source triage answerer factory (real provider answerer in prod).
  answererFactory: (target: { orgId: string; projectId?: string }) => TriageAnswerer;
  // The autonomous DAG-insert deps (system actor) — identical to the receiver/poller.
  autoRoute: AutoRouteDeps;
}

// Map a persisted webhook event's payload to an ingest item. Only `issues` is
// wired today (the receiver only persists `issues` events); an unknown type is a
// hard, non-recoverable mapping error so it dead-letters rather than re-driving.
function mapEvent(event: WebhookEvent, source: InboxSource) {
  if (event.eventType !== "issues") {
    return { kind: "skip" as const, reason: `unsupported webhook event type: ${event.eventType}` };
  }
  return mapGithubIssueWebhook(event.payload, source.projectId);
}

/**
 * Process ONE persisted webhook event end-to-end. Resolves the source, maps the
 * payload, runs the shared intake pipeline under the source's org scope, and marks
 * the row terminally. Returns whether it ended `processed` (a `skip` mapping is a
 * legitimate processed no-op — e.g. a closed issue). Recoverable failures mark the
 * row `failed`/`dead_lettered` and DO NOT throw (the sweeper continues to others).
 */
export async function processWebhookEvent(deps: WebhookProcessorDeps, event: WebhookEvent): Promise<boolean> {
  const source = await runWithSystemScope(deps.pool, (client) => InboxStore.getSource(client, event.sourceId));
  if (source === undefined) {
    // The source vanished — there is nothing to re-drive to. Dead-letter loudly.
    await markFailure(deps, event, "source_not_found", WEBHOOK_EVENT_MAX_ATTEMPTS);
    return false;
  }

  const mapped = mapEvent(event, source);
  if (mapped.kind === "skip") {
    // A non-ingest action (closed/deleted/PR) is a real terminal — mark processed.
    await runWithOrgScope(deps.pool, event.orgId, (client) => WebhookEventStore.markProcessed(client, event.id));
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
    // §3.6 fix 6: a spec the quality gate could not make valid (within its bounded
    // revision budget) is NOT a transient — re-triaging it on every sweep would be
    // an infinite LLM-cost loop. Dead-letter it immediately (loud terminal) by
    // forcing the attempt count to the cap; everything else is recoverable.
    const persistentlyInvalid = error instanceof PersistentlyInvalidSpecError;
    await markFailure(deps, event, messageOf(error), persistentlyInvalid ? 1 : WEBHOOK_EVENT_MAX_ATTEMPTS);
    return false;
  }

  await runWithOrgScope(deps.pool, event.orgId, (client) => WebhookEventStore.markProcessed(client, event.id));
  return true;
}

// Record a processing failure org-scoped. `maxAttempts === 1` (the persistently-
// invalid path) dead-letters on this very attempt.
async function markFailure(
  deps: WebhookProcessorDeps,
  event: WebhookEvent,
  error: string,
  maxAttempts: number,
): Promise<void> {
  await runWithOrgScope(deps.pool, event.orgId, (client) =>
    WebhookEventStore.recordFailure(client, event.id, error, maxAttempts),
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
