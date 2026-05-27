import { serve } from "@hono/node-server";
import { createDbPool, migrate } from "@tanren/db";
import { Hono } from "hono";
import { loginUrl, useSession } from "./auth/index.js";

const port = Number(process.env.DASHBOARD_PORT ?? 3000);
const orchestratorUrl = process.env.ORCHESTRATOR_URL ?? "http://localhost:3100";
const requireAuth = process.env.TANREN_REQUIRE_AUTH === "1";
const pool = createDbPool();

function Layout(props: { title: string; children: unknown }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <style>{`
          body { font-family: system-ui, sans-serif; margin: 2rem; color: #1f2933; background: #f7f9fb; }
          main { max-width: 960px; margin: 0 auto; }
          table { border-collapse: collapse; width: 100%; background: white; }
          th, td { border-bottom: 1px solid #d9e2ec; padding: 0.65rem; text-align: left; }
          code { background: #e6eef6; padding: 0.1rem 0.25rem; border-radius: 4px; }
          .panel { background: white; border: 1px solid #d9e2ec; padding: 1rem; margin: 1rem 0; }
        `}</style>
      </head>
      <body>
        <main>{props.children}</main>
      </body>
    </html>
  );
}

export async function createApp() {
  await migrate(pool);
  const app = new Hono();

  app.get("/healthz", async (c) => {
    const dbResult = await pool.query("SELECT 1 AS ok");
    const orchestrator = await fetch(`${orchestratorUrl}/healthz`).then((r) => r.ok).catch(() => false);
    return c.json({ service: "dashboard", ok: dbResult.rows[0]?.ok === 1, orchestrator });
  });

  app.use("*", async (c, next) => {
    if (c.req.path === "/healthz" || c.req.path === "/auth/login") {
      return next();
    }
    if (!requireAuth) {
      return next();
    }
    const session = await useSession(c.req.header("cookie"), { orchestratorUrl });
    if (session === undefined) {
      return c.redirect("/auth/login");
    }
    return next();
  });

  app.get("/auth/login", (c) => c.redirect(loginUrl(orchestratorUrl, c.req.query("next") ?? "/")));

  app.get("/", async (c) => {
    const runs = await pool.query("SELECT run_id, outcome, started_at, ended_at FROM runs ORDER BY started_at DESC LIMIT 10");
    const costs = await pool.query("SELECT coalesce(sum(cost_usd), 0)::text AS total FROM cost_records");

    return c.html(
      <Layout title="Tanren">
        <h1>Tanren</h1>
        <section class="panel">
          <h2>Hello-world baseline</h2>
          <p>Orchestrator: <code>{orchestratorUrl}</code></p>
          <p>Total synthetic cost: <code>${costs.rows[0]?.total ?? "0"}</code></p>
        </section>
        <section>
          <h2>Recent runs</h2>
          <table>
            <thead>
              <tr><th>Run</th><th>Outcome</th><th>Started</th><th>Ended</th></tr>
            </thead>
            <tbody>
              {runs.rows.map((run) => (
                <tr>
                  <td><a href={`/runs/${run.run_id}`}>{run.run_id}</a></td>
                  <td>{run.outcome ?? "running"}</td>
                  <td>{String(run.started_at)}</td>
                  <td>{run.ended_at ? String(run.ended_at) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </Layout>
    );
  });

  app.get("/runs/:runId", async (c) => {
    const runId = c.req.param("runId");
    const run = await pool.query("SELECT * FROM runs WHERE run_id = $1", [runId]);
    const events = await pool.query("SELECT event_type, payload, ts FROM events WHERE run_id = $1 ORDER BY ts ASC, id ASC", [runId]);
    if (run.rowCount === 0) {
      return c.notFound();
    }

    return c.html(
      <Layout title={`Tanren ${runId}`}>
        <h1>Run <code>{runId}</code></h1>
        <p>Outcome: <code>{run.rows[0].outcome ?? "running"}</code></p>
        <table>
          <thead>
            <tr><th>Time</th><th>Event</th><th>Payload</th></tr>
          </thead>
          <tbody>
            {events.rows.map((event) => (
              <tr>
                <td>{String(event.ts)}</td>
                <td>{event.event_type}</td>
                <td><code>{JSON.stringify(event.payload)}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Layout>
    );
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await createApp();
  serve({ fetch: app.fetch, port });
  console.log(`dashboard listening on :${port}`);
}
