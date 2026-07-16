/**
 * candidate-inbox mount, registered through the append-only screen
 * registry. Composes the discovery accept (routes a candidate into the discovery
 * flow — the "accept · open in discovery" action links to the project's
 * discovery surface) and the conversation read (the per-candidate triage read-out).
 *
 * Routes registered:
 *   GET  /inbox                                source list + candidate stream
 *   POST /inbox/candidates/:id/fold            fold into a live run
 *   POST /inbox/candidates/:id/dismiss         dismiss
 *   POST /inbox/candidates/:id/close-duplicate close as duplicate
 *   POST /inbox/sources/:id/recover             retry a repaired terminal source
 *
 * The inbox client is its OWN api module (`api/inboxClient.ts`) per the screen-isolation
 * integration lesson; the route instantiates it with the forwarded cookie.
 * Accept (→ discovery) is a navigation, not a write here — the discovery
 * surface owns the spec-creation hand-off.
 */

import type { Context, Hono } from "hono";
import { clientDepsFor } from "../../api/clientDeps.js";
import { InboxClient } from "../../api/inboxClient.js";
import type { InboxSnapshot } from "../../api/inboxTypes.js";
import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
import { InboxBody } from "../../components/inbox/InboxBody.js";

const EMPTY: InboxSnapshot = { sources: [], candidates: [] };

function readClient(c: Context, deps: ShellDeps): InboxClient {
  return new InboxClient({
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader: c.req.header("cookie"),
  });
}

async function writeClient(c: Context, deps: ShellDeps): Promise<InboxClient> {
  return new InboxClient(await clientDepsFor(c, deps));
}

export function mountInboxScreens(app: Hono, deps: ShellDeps): void {
  app.get("/inbox", async (c) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "inbox" });
    if (ctx.org === undefined) {
      return renderShell(
        c,
        ctx,
        { title: "tanren · candidate inbox" },
        <InboxBody orgId="" snapshot={EMPTY} error="link an org to ingest issue sources." csrfToken={ctx.csrfToken} />,
      );
    }
    const snapshot = (await readClient(c, deps).snapshot(ctx.org.id)) ?? EMPTY;
    return renderShell(
      c,
      ctx,
      { title: "tanren · candidate inbox" },
      <InboxBody orgId={ctx.org.id} snapshot={snapshot} csrfToken={ctx.csrfToken} />,
    );
  });

  for (const verb of ["fold", "dismiss", "close-duplicate"] as const) {
    app.post(`/inbox/candidates/:id/${verb}`, async (c) => {
      const ctx = await loadShellContext(c, deps, { activeNavId: "inbox" });
      if (ctx.org !== undefined) {
        await (await writeClient(c, deps)).resolve(ctx.org.id, c.req.param("id"), verb);
      }
      return c.redirect("/inbox");
    });
  }

  app.post("/inbox/sources/:id/recover", async (c) => {
    const ctx = await loadShellContext(c, deps, { activeNavId: "inbox" });
    if (ctx.org !== undefined) {
      const body = await c.req.parseBody();
      const expectedObservedAt = body["expectedObservedAt"];
      if (typeof expectedObservedAt === "string") {
        await (await writeClient(c, deps)).recover(ctx.org.id, c.req.param("id"), expectedObservedAt);
      }
    }
    return c.redirect("/inbox");
  });
}
