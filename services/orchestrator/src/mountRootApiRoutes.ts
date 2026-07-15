// The root-level API handlers, extracted from `buildApp` in main.ts:
// project/spec creation, the auth-bundle + GitHub credential imports, the
// per-run draft-PR action, and the `/runs/:runId` debug read.
// main.ts keeps app construction, auth wiring, and the feature-route mount
// table; this module owns these root endpoints and the schema/workflow/error
// deps they pull.

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type { Hono } from "hono";
import type pg from "pg";
import type { ActorContext } from "./auth/index.js";
import { orgScopingPool } from "./engine/data/orgScopedDb.js";
import { draftPrInputSchema, projectInputSchema, runInputSchema, specInputSchema } from "./inputSchemas.js";
import type { SecretStore, CommandSubstrate } from "./engine/contracts/index.js";
import { parseRawViewOptIn, redactEventRows } from "./routes/runs/redaction.js";
import type { GitHubHttpClient } from "./engine/providers/github.js";
import type { GithubAppTokenMinter } from "./engine/providers/githubAppTokenMinter.js";
import {
  DraftPrRunnerNotFoundError,
  DraftPrRunNotFoundError,
  publishDraftPullRequestForRun,
} from "./engine/workflow/githubDraftPr.js";
import {
  createProject,
  createQueuedRunFromSpec,
  createSpec,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  SpecDependenciesBlockedError,
  SpecNotRunnableError,
  SpecNotFoundError,
} from "./engine/workflow/projectSpec.js";
import type { ActorContextEnv } from "./middleware/auth.js";
import { checkGenericProjectCreateConfig } from "./routes/projects/createConfigGuard.js";

export interface RootApiDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  /** The shared (timed) GitHub HTTP client the per-run route host seams build over. */
  githubHttp: GitHubHttpClient;
  githubAppMinter: GithubAppTokenMinter;
  identitySecretRef: string;
  // The per-run draft-PR route pushes the runner workspace branch over this
  // substrate (the orchestrator wraps a TimedCommandSubstrate(SshCommandSubstrate)).
  ssh: CommandSubstrate;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function actorOf(c: { var: { actor?: ActorContext } }): ActorContext | undefined {
  return c.var.actor;
}

/**
 * Register the root API endpoints on `app`. Registration order matches
 * the prior inline block in `buildApp`; behavior is identical.
 */
export function mountRootApiRoutes(app: Hono<ActorContextEnv>, deps: RootApiDeps): void {
  const { pool, secrets, githubHttp, githubAppMinter, identitySecretRef } = deps;
  // RLS HTTP-route scoping: these root handlers are RESOURCE-keyed (no `:orgId`
  // path segment), so the auth middleware resolves the request's org from the
  // addressed spec/run/project and publishes it on the `runWithJobOrgId` ambient.
  // The per-run workflow handler (`draft-pr`) issues raw `pool.query`
  // against tenant tables (`runs`/`runners`/`tasks`), so it runs on this
  // org-scoping pool: each `.query` opens a SHORT `runWithOrgScope` from the
  // ambient org id, so the enforced `tanren_app` policies admit the rows. (The
  // creation handlers — `createProject`/`createSpec`/`createQueuedRunFromSpec` —
  // self-scope from the now-correctly-resolved `actor.orgId` via their own
  // `runWithOrgScope`, so they keep the bare pool; `GET /runs/:runId` resolves
  // its run's org via the system scope itself.)
  const scopedPool = orgScopingPool(pool);

  app.post("/projects", async (c) => {
    const parsed = projectInputSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_project", issues: parsed.error.issues }, 400);
    }
    const configCheck = checkGenericProjectCreateConfig(parsed.data.config);
    if (!configCheck.ok) {
      return c.json(configCheck.response, 400);
    }
    // Keep raw key presence intact for createProject's identical inner guard;
    // default-expanded values must not be mistaken for caller-supplied settings.
    return c.json(await createProject(pool, parsed.data, actorOf(c)), 201);
  });

  app.post("/specs", async (c) => {
    const parsed = specInputSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_spec", issues: parsed.error.issues }, 400);
    }
    try {
      return c.json(await createSpec(pool, parsed.data, actorOf(c)), 201);
    } catch (error) {
      if (error instanceof ProjectNotFoundError) {
        return c.json({ error: "project_not_found", message: error.message }, 404);
      }
      if (error instanceof ProjectAccessDeniedError) {
        return c.json({ error: "project_access_denied", message: error.message }, 403);
      }
      if (error instanceof SpecNotFoundError) {
        return c.json({ error: "spec_dependency_not_found", message: error.message }, 404);
      }
      throw error;
    }
  });

  app.post("/specs/:specId/runs", async (c) => {
    const parsed = runInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_run", issues: parsed.error.issues }, 400);
    }
    try {
      return c.json(
        await createQueuedRunFromSpec(pool, { specId: c.req.param("specId"), ...parsed.data }, actorOf(c)),
        201,
      );
    } catch (error) {
      if (error instanceof SpecNotFoundError) {
        return c.json({ error: "spec_not_found", message: error.message }, 404);
      }
      if (error instanceof ProjectAccessDeniedError) {
        return c.json({ error: "project_access_denied", message: error.message }, 403);
      }
      if (error instanceof SpecDependenciesBlockedError) {
        return c.json({ error: "spec_dependencies_blocked", message: error.message }, 409);
      }
      if (error instanceof SpecNotRunnableError) {
        return c.json({ error: "spec_not_runnable", message: error.message }, 409);
      }
      throw error;
    }
  });

  // Credential import is ONLY the org-scoped surface (`/orgs/:orgId/credentials`,
  // `/credentials/me` in `createCredentialRoutes`): each import derives a
  // tenant-namespaced ref AND records a durable registry entry. There are no
  // unscoped top-level `/credentials/<slug>/import` routes.

  app.post("/runs/:runId/github/draft-pr", async (c) => {
    const parsed = draftPrInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_draft_pr", issues: parsed.error.issues }, 400);
    }
    try {
      return c.json(
        await publishDraftPullRequestForRun({
          pool: scopedPool,
          secrets,
          githubHttp,
          ssh: deps.ssh,
          runId: c.req.param("runId"),
          identitySecretRef,
          githubAppMinter,
          ...parsed.data,
        }),
        201,
      );
    } catch (error) {
      if (error instanceof DraftPrRunNotFoundError) {
        return c.json({ error: "run_not_found", message: error.message }, 404);
      }
      if (error instanceof DraftPrRunnerNotFoundError) {
        return c.json({ error: "runner_not_found", message: error.message }, 409);
      }
      return c.json({ error: "github_draft_pr_failed", message: messageFromError(error) }, 502);
    }
  });

  app.get("/runs/:runId", async (c) => {
    const runId = c.req.param("runId");
    // RLS R3b: this legacy debug route has no `:orgId` path param, so resolve the
    // run's org via the BYPASSRLS system scope FIRST (a cross-org bootstrap read),
    // then run every tenant read under that org's scope so the enforced policies
    // admit them. A run with no resolvable org (gone / legacy null) is 404.
    const orgRow = await runWithSystemScope(pool, (client) =>
      client.query<{ org_id: string | null }>("SELECT org_id FROM runs WHERE run_id = $1", [runId]),
    );
    const orgId = orgRow.rows[0]?.org_id ?? null;
    if (orgId === null) {
      return c.json({ error: "run_not_found" }, 404);
    }

    const payload = await runWithOrgScope(pool, orgId, async (client): Promise<Record<string, unknown> | undefined> => {
      const run = await client.query("SELECT * FROM runs WHERE run_id = $1", [runId]);
      if (run.rowCount === 0) {
        return undefined;
      }
      const tasks = await client.query(
        `SELECT * FROM tasks
         WHERE run_id = $1
         ORDER BY CASE kind WHEN 'plan' THEN 1 WHEN 'write' THEN 2 WHEN 'check' THEN 3 WHEN 'audit' THEN 4 WHEN 'ci' THEN 5 ELSE 99 END,
                  started_at ASC NULLS FIRST,
                  task_id ASC`,
        [runId],
      );
      const events = await client.query("SELECT * FROM events WHERE run_id = $1 ORDER BY ts ASC, id ASC", [runId]);
      const costs = await client.query(
        "SELECT * FROM cost_records WHERE run_id = $1 ORDER BY recorded_at ASC, id ASC",
        [runId],
      );
      const { events: serializedEvents } = await redactEventRows({
        // The shared pool — but we are inside this run's `runWithOrgScope`, so the
        // audit event store self-routes through the ambient org-scoped client.
        pool,
        rows: events.rows,
        runId,
        actor: actorOf(c),
        rawView: parseRawViewOptIn(c),
      });
      return { run: run.rows[0], tasks: tasks.rows, events: serializedEvents, costs: costs.rows };
    });
    if (payload === undefined) {
      return c.json({ error: "run_not_found" }, 404);
    }
    return c.json(payload);
  });
}
