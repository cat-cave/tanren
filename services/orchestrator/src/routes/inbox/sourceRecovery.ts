import { runWithOrgScope } from "@tanren/db";
import type { Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { InboxStore } from "../../engine/repositories/inbox.js";
import { InboxSourceLifecycleStore } from "../../engine/repositories/inboxSourceLifecycle.js";
import { bindOrgGithubCredentialRefs, migrateOrgConfig } from "../../engine/config/orgConfig.js";
import { PgEventStore } from "../../engine/eventStore.js";
import type { InboxSource } from "../../engine/forge/inbox/types.js";
import { PgIntegrationAuthority } from "../../engine/integrations/integrationAuthorityImpl.js";
import { systemActor } from "../../engine/state/actor.js";
import { actorIsOrgAdmin } from "../orgs/access.js";

const RecoverSourceBody = z.object({ expectedObservedAt: z.string().datetime() }).strict();

/** Authorized compare-and-set recovery; provider config and webhook metadata survive. */
export async function handleSourceRecovery(
  c: Context<ActorContextEnv>,
  pool: pg.Pool,
  orgId: string,
  sourceId: string,
  actor: ActorContext,
): Promise<Response> {
  if (!actorIsOrgAdmin(actor, orgId)) return c.json({ error: "org_admin_required" }, 403);
  const parsed = RecoverSourceBody.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "invalid_source_recovery", issues: parsed.error.issues }, 400);

  try {
    const source = await runWithOrgScope(pool, orgId, async (client) => {
      const current = await InboxStore.getSource(client, sourceId);
      if (current === undefined || current.orgId !== orgId) return undefined;
      if (current.state !== "needs_attention" || current.attention?.observedAt !== parsed.data.expectedObservedAt) {
        return null;
      }
      const repair = await resolveRecoveryCredential(client, current);
      const recovered = await InboxSourceLifecycleStore.recover(
        client,
        { id: sourceId, orgId },
        parsed.data.expectedObservedAt,
      );
      if (!recovered) return null;
      await new PgEventStore(client).append({
        orgId,
        ...(current.projectId === null ? {} : { projectId: current.projectId }),
        eventType: "credential.configured",
        payload: { ...repair, redacted: true },
      });
      return InboxStore.getSource(client, sourceId);
    });
    if (source === undefined) return c.json({ error: "source_not_found" }, 404);
    if (source === null) return c.json({ error: "source_recovery_conflict" }, 409);
    return c.json({ source }, 200);
  } catch {
    return c.json({ error: "source_recovery_invalid" }, 409);
  }
}

async function resolveRecoveryCredential(
  client: Pick<pg.PoolClient, "query">,
  source: InboxSource,
): Promise<{
  provider: string;
  credentialKind: "github_app" | "github_token" | "opaque";
  ref: string;
}> {
  if (source.kind === "issues") {
    const result = await client.query<{ config: unknown }>("SELECT config FROM organizations WHERE id = $1", [
      source.orgId,
    ]);
    const row = result.rows[0];
    if (row === undefined) throw new Error("source organization no longer exists");
    const config = bindOrgGithubCredentialRefs(migrateOrgConfig(row.config), source.orgId);
    if (config.github_app !== undefined) {
      return { provider: "github", credentialKind: "github_app", ref: config.github_app.credentialRef };
    }
    const ref = config.defaultCredentials?.github_token;
    if (ref === undefined) throw new Error("organization GitHub credential is still unavailable");
    return { provider: "github", credentialKind: "github_token", ref };
  }
  if (source.kind === "errors" && source.projectId !== null) {
    if (source.config === null) throw new Error("source config must be repaired before recovery");
    const result = await new PgIntegrationAuthority().authorizeOperation(client, {
      orgId: source.orgId,
      projectId: source.projectId,
      providerKind: "sentry",
      capability: "errors",
      operation: "intake",
      target: { resourceId: source.config.project },
      actor: systemActor,
    });
    if (result.status !== "eligible") throw new Error("Sentry intake authority is still unavailable");
    return { provider: "sentry", credentialKind: "opaque", ref: result.lease.credentialRef };
  }
  throw new Error("this source kind has no recoverable credential authority");
}
