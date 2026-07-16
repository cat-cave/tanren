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
    const recovery = recoveryMessage(c.req.query("recovery"));
    return renderShell(
      c,
      ctx,
      { title: "tanren · candidate inbox" },
      <InboxBody
        orgId={ctx.org.id}
        snapshot={snapshot}
        csrfToken={ctx.csrfToken}
        {...(recovery.kind === "notice" ? { notice: recovery.message } : {})}
        {...(recovery.kind === "error" ? { error: recovery.message } : {})}
      />,
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
    if (ctx.org === undefined) return c.redirect("/inbox?recovery=failed");
    const body = await c.req.parseBody();
    const expectedObservedAt = body["expectedObservedAt"];
    if (typeof expectedObservedAt !== "string") return c.redirect("/inbox?recovery=failed");
    try {
      const result = await (await writeClient(c, deps)).recover(ctx.org.id, c.req.param("id"), expectedObservedAt);
      if (result.ok) return c.redirect("/inbox?recovery=success");
      if (result.error === "source_recovery_conflict") return c.redirect("/inbox?recovery=conflict");
      if (result.error === "source_recovery_not_supported") return c.redirect("/inbox?recovery=not-supported");
    } catch {
      return c.redirect("/inbox?recovery=malformed-response");
    }
    return c.redirect("/inbox?recovery=failed");
  });
}

type RecoveryMessage = { kind: "none" } | { kind: "notice" | "error"; message: string };

function recoveryMessage(value: string | undefined): RecoveryMessage {
  if (value === "success") return { kind: "notice", message: "Source recovery applied. Intake is active again." };
  if (value === "conflict")
    return { kind: "error", message: "Source recovery conflicted with a newer repair state. Refresh and retry." };
  if (value === "not-supported")
    return { kind: "error", message: "This source must be edited or recreated before intake can resume." };
  if (value === "malformed-response")
    return { kind: "error", message: "Source recovery returned an invalid acknowledgement." };
  if (value === "failed") return { kind: "error", message: "Source recovery could not be applied." };
  return { kind: "none" };
}
