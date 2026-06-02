// P1d autonomous intake — the GitHub issues WEBHOOK RECEIVER (autonomy-engine.md
// §1d). GitHub posts an `issues` event here; we resolve the configured inbox
// SOURCE (by id in the path), VERIFY the signature against that source's secret
// (mandatory — no unauthenticated intake), map the payload to an ingest item, and
// run the SHARED intake pipeline: real-LLM triage → an `auto_routable` issue is
// INSERTED INTO THE DAG with deps + priority; everything else lands in the
// candidate inbox for operator review.
//
// The receiver is NOT org-keyed in the path (GitHub does not send a tenant id),
// so it resolves the source + its org server-side, system-scoped, and runs the
// DAG insert under that org's RLS scope via the intake system actor. This route
// mounts at root alongside the CI webhook receiver.

import { Hono } from "hono";
import type pg from "pg";
import { runWithSystemScope } from "@tanren/db";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import {
  intakeItem,
  mapGithubIssueWebhook,
  verifyGithubSignature,
  type IntakeOutcome,
} from "../../engine/forge/intake/index.js";
import { intakeAutoRouteDeps } from "../../engine/forge/intake/index.js";
import { getSource, type InboxSource, type TriageAnswerer } from "../../engine/forge/inbox/index.js";
import type { ForgeAnswererTarget } from "../../engine/forge/providerFactory.js";
import { z } from "zod";

// The webhook secret ref the source carries on its `config`. A source with no
// `webhookSecretRef` cannot receive a webhook (the receiver rejects it 401).
const WebhookSourceConfig = z.object({ webhookSecretRef: z.string().min(1).optional() }).passthrough();

export interface IssueWebhookRouteDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  // The per-source triage answerer factory (real provider answerer in prod).
  answererFactory: (target: ForgeAnswererTarget) => TriageAnswerer;
}

/** Resolve a source system-scoped (the receiver has no tenant context in the path). */
async function resolveSource(pool: pg.Pool, sourceId: string): Promise<InboxSource | undefined> {
  return runWithSystemScope(pool, (client) => getSource(client, sourceId));
}

export function createIssueWebhookRoutes(deps: IssueWebhookRouteDeps) {
  const app = new Hono<ActorContextEnv>();

  app.post("/github/webhooks/issues/:sourceId", async (c) => {
    const event = c.req.header("x-github-event") ?? "";
    // The signature is computed over the RAW body — read text, then parse.
    const rawBody = await c.req.text();

    const source = await resolveSource(deps.pool, c.req.param("sourceId"));
    if (source === undefined) return c.json({ error: "source_not_found" }, 404);

    // Mandatory signature verification (§1d). Resolve the source's secret; a
    // source with no secret, or a bad signature, is rejected — no intake.
    const config = WebhookSourceConfig.safeParse(source.config);
    const secretRef = config.success ? config.data.webhookSecretRef : undefined;
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

    const mapped = mapGithubIssueWebhook(payload, source.projectId);
    if (mapped.kind === "skip") return c.json({ event, outcome: "skipped", reason: mapped.reason }, 202);

    const outcome = await runIntake(deps, source, mapped.item);
    return c.json(
      outcome.kind === "auto_routed"
        ? { event, outcome: "auto_routed", candidateId: outcome.candidate.id, specId: outcome.specId }
        : { event, outcome: "inboxed", candidateId: outcome.candidate.id },
      200,
    );
  });

  return app;
}

async function runIntake(
  deps: IssueWebhookRouteDeps,
  source: InboxSource,
  item: Parameters<typeof intakeItem>[2],
): Promise<IntakeOutcome> {
  return intakeItem(
    {
      pool: deps.pool,
      answerer: deps.answererFactory({
        orgId: source.orgId,
        ...(source.projectId === null ? {} : { projectId: source.projectId }),
      }),
      autoRoute: intakeAutoRouteDeps(),
    },
    source,
    item,
  );
}
