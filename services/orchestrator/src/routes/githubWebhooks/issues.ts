// P1d autonomous intake — the GitHub issues WEBHOOK RECEIVER (autonomy-engine.md
// §1d). GitHub posts an `issues` event here; we resolve the configured inbox
// SOURCE (by id in the path), VERIFY the signature against that source's secret
// (mandatory — no unauthenticated intake), then PERSIST the verified raw delivery
// durably and return 202 FAST.
//
// §3.6 (persist-then-202 + async): the OLD receiver ran runner allocation + a
// 120s-budget triage call INLINE — inside GitHub's ~10s delivery window — and
// 202-swallowed any failure. GitHub, seeing a 2xx, never re-delivers, so a
// transient blip PERMANENTLY LOST the intake (and every delivery showed red in
// GitHub's UI from the timeout). Now the receiver does the ONE durable thing —
// persist the event — and a background processor (kicked best-effort here, and
// GUARANTEED by the poller's sweeper) does the allocation/triage/routing out of
// band. A processing failure is recoverable: the sweeper re-drives the persisted
// row idempotently. The intake is never silently lost.
//
// The receiver is NOT org-keyed in the path (GitHub does not send a tenant id),
// so it resolves the source + its org server-side, system-scoped, and persists +
// processes under that org's RLS scope. This route mounts at root alongside the CI
// webhook receiver.

import { Hono } from "hono";
import type pg from "pg";
import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import {
  intakeAutoRouteDeps,
  processWebhookEvent,
  verifyGithubSignature,
  type WebhookProcessorDeps,
} from "../../engine/forge/intake/index.js";
import { pgRepositories } from "../../engine/contracts/repositories.js";
import { ActiveGitHubIssuesConfig, type InboxSource, type TriageAnswerer } from "../../engine/forge/inbox/index.js";
import type { AutoRouteDeps } from "../../engine/forge/inbox/index.js";
import type { ForgeAnswererTarget } from "../../engine/forge/providerFactory.js";
import { createLogger } from "../../engine/observability/logger.js";

const log = createLogger("issue-webhook");

export interface IssueWebhookRouteDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  // The per-source triage answerer factory (real provider answerer in prod). Used
  // by the background processor — NOT on the receiver hot path.
  answererFactory: (target: ForgeAnswererTarget) => TriageAnswerer;
  // The autonomous DAG-insert deps (system actor). Used by the background processor.
  // Defaults to the plain platform-admin system actor when the caller omits it.
  autoRoute?: AutoRouteDeps;
}

/** Resolve a source system-scoped (the receiver has no tenant context in the path). */
async function resolveSource(pool: pg.Pool, sourceId: string): Promise<InboxSource | undefined> {
  return runWithSystemScope(pool, (client) => pgRepositories.inbox.getSource(client, sourceId));
}

export function createIssueWebhookRoutes(deps: IssueWebhookRouteDeps) {
  const app = new Hono<ActorContextEnv>();
  const processorDeps: WebhookProcessorDeps = {
    pool: deps.pool,
    answererFactory: deps.answererFactory,
    autoRoute: deps.autoRoute ?? intakeAutoRouteDeps(),
  };

  app.post("/github/webhooks/issues/:sourceId", async (c) => {
    const event = c.req.header("x-github-event") ?? "";
    // The signature is computed over the RAW body — read text, then parse.
    const rawBody = await c.req.text();

    const source = await resolveSource(deps.pool, c.req.param("sourceId"));
    if (source === undefined) return c.json({ error: "source_not_found" }, 404);

    // Mandatory signature verification (§1d). Resolve the source's secret; a
    // source with no secret, or a bad signature, is rejected — no intake.
    const config = source.kind === "issues" ? ActiveGitHubIssuesConfig.safeParse(source.config) : undefined;
    const secretRef = config?.success === true ? config.data.webhookSecretRef : undefined;
    const secret = secretRef === undefined ? undefined : await deps.secrets.get(secretRef);
    const check = verifyGithubSignature({
      rawBody,
      signatureHeader: c.req.header("x-hub-signature-256"),
      secret: secret?.value ?? "",
    });
    if (!check.ok) return c.json({ error: "signature_rejected", message: check.reason }, 401);

    if (event !== "issues") return c.json({ event, outcome: "ignored_event" }, 202);

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "invalid_webhook", message: "body was not JSON" }, 400);
    }

    // §3.6 persist-then-202: the ONLY synchronous work is the durable write — one
    // INSERT, well inside GitHub's 10s window. The verified delivery is now
    // recoverable; the actual triage/alloc/routing happens in the background. A
    // persist failure IS a real 500 (GitHub should re-deliver — we lost nothing yet).
    let eventId: string;
    try {
      const persisted = await runWithOrgScope(deps.pool, source.orgId, (client) =>
        pgRepositories.webhookEvents.persist(client, {
          sourceId: source.id,
          orgId: source.orgId,
          eventType: event,
          deliveryId: c.req.header("x-github-delivery") ?? null,
          payload,
        }),
      );
      eventId = persisted.id;
      // Best-effort immediate processing so the happy path lands quickly — but it
      // runs DETACHED (not awaited) so a slow triage never holds the 202, and any
      // failure is left to the sweeper. The persisted row is the durable guarantee.
      void processWebhookEvent(processorDeps, persisted).catch((error: unknown) => {
        log.error(
          "background processing of webhook event failed (sweeper will re-drive)",
          {
            eventId: persisted.id,
          },
          error,
        );
      });
    } catch (error) {
      // Persistence failed — nothing durable landed. Return 500 so GitHub re-delivers.
      return c.json({ event, outcome: "persist_failed", message: messageOf(error) }, 500);
    }

    return c.json({ event, outcome: "accepted", eventId }, 202);
  });

  return app;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
