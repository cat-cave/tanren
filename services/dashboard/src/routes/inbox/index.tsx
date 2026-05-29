/**
 * P3-0022 candidate-inbox mount, registered through the append-only screen
 * registry. Composes P3-0014 (accept routes a candidate into the discovery
 * flow — the "accept · open in discovery" action links to the project's
 * discovery surface) and P3-0010 (the per-candidate triage read-out).
 *
 * Routes registered:
 *   GET  /inbox                                source list + candidate stream
 *   POST /inbox/candidates/:id/fold            fold into a live run
 *   POST /inbox/candidates/:id/dismiss         dismiss
 *   POST /inbox/candidates/:id/close-duplicate close as duplicate
 *
 * The inbox client is its OWN api module (`api/inboxClient.ts`) per the P2B
 * integration lesson; the route instantiates it with the forwarded cookie.
 * Accept (→ discovery) is a navigation, not a write here — the discovery
 * surface owns the spec-creation hand-off (P3-0014).
 */

import type { Context, Hono } from "hono";
import { InboxClient } from "../../api/inboxClient.js";
import type { InboxSnapshot } from "../../api/inboxTypes.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import { InboxBody } from "../../components/inbox/InboxBody.js";

const EMPTY: InboxSnapshot = { sources: [], candidates: [] };

function clientFor(c: Context, deps: ShellDeps): InboxClient {
  return new InboxClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie")
  });
}

export function mountInboxScreens(app: Hono, deps: ShellDeps): void {
  app.get("/inbox", async (c) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "inbox" });
    if (ctx.org === undefined) {
      return renderShell(
        c,
        ctx,
        { title: "tanren · candidate inbox" },
        <InboxBody orgId="" snapshot={EMPTY} error="link an org to ingest issue sources." />
      );
    }
    const snapshot = (await clientFor(c, deps).snapshot(ctx.org.id)) ?? EMPTY;
    return renderShell(c, ctx, { title: "tanren · candidate inbox" }, <InboxBody orgId={ctx.org.id} snapshot={snapshot} />);
  });

  for (const verb of ["fold", "dismiss", "close-duplicate"] as const) {
    app.post(`/inbox/candidates/:id/${verb}`, async (c) => {
      const ctx = await loadShellContext(c, deps, { activeNavId: "inbox" });
      if (ctx.org !== undefined) {
        await clientFor(c, deps).resolve(ctx.org.id, c.req.param("id"), verb);
      }
      return c.redirect("/inbox");
    });
  }
}
