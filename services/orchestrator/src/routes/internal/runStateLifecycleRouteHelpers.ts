// Shared helpers for lifecycle write routes: authn + Zod parse + org-scoped apply.
// Keeps registerRunStateLifecycleRoutes under the max-lines-per-function cap.

import { runWithOrgScope } from "@tanren/db";
import type { Context, Hono } from "hono";
import type { z } from "zod";
import type { RunStateWriteRouteDeps } from "./internalWriteShared.js";
import { verifyInternalPeer } from "./internalWriteShared.js";

type OrgScopedClient = Parameters<Parameters<typeof runWithOrgScope>[2]>[0];

/** POST that authenticates, parses a body with orgId, applies under org scope, returns 204. */
export function registerOrgScopedVoidPost<T extends { orgId: string }>(
  app: Hono,
  deps: RunStateWriteRouteDeps,
  path: string,
  schema: z.ZodType<T>,
  invalidError: string,
  apply: (client: OrgScopedClient, data: T) => Promise<void>,
): void {
  app.post(path, async (c: Context) => {
    if (!verifyInternalPeer(deps.verifier, c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const parsed = schema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: invalidError, issues: parsed.error.issues }, 400);
    }
    await runWithOrgScope(deps.pool, parsed.data.orgId, (client) => apply(client, parsed.data));
    return c.body(null, 204);
  });
}

/** POST that authenticates, parses, applies under org scope, returns JSON body. */
export function registerOrgScopedJsonPost<T extends { orgId: string }, R>(
  app: Hono,
  deps: RunStateWriteRouteDeps,
  path: string,
  schema: z.ZodType<T>,
  invalidError: string,
  apply: (client: OrgScopedClient, data: T) => Promise<R>,
): void {
  app.post(path, async (c: Context) => {
    if (!verifyInternalPeer(deps.verifier, c)) {
      return c.json({ error: "untrusted_peer" }, 401);
    }
    const parsed = schema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: invalidError, issues: parsed.error.issues }, 400);
    }
    const result = await runWithOrgScope(deps.pool, parsed.data.orgId, (client) => apply(client, parsed.data));
    return c.json(result as Record<string, unknown>);
  });
}
