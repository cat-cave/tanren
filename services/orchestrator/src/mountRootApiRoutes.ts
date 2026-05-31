// The Phase-1 root-level API handlers, extracted from `buildApp` in main.ts:
// project/spec creation, the auth-bundle + GitHub credential imports, the hello
// fixture trigger, the per-run draft-PR / CI-poll actions, and the legacy
// `/runs/:runId` debug read. main.ts keeps app construction, auth wiring, and
// the feature-route mount table; this module owns these root endpoints and the
// schema/workflow/error deps they pull. Every handler is byte-for-byte the
// prior inline registration, in the same order — behavior is identical.

import { getSystemPool, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type { Hono } from "hono";
import type pg from "pg";
import type { ActorContext } from "./auth/index.js";
import { orgScopingPool } from "./engine/data/orgScopedDb.js";
import {
  ciPollInputSchema,
  draftPrInputSchema,
  githubCredentialImportSchema,
  projectInputSchema,
  runInputSchema,
  specInputSchema,
} from "./inputSchemas.js";
import type { SecretStore } from "./engine/contracts/index.js";
import { FakeJobQueue } from "./engine/contracts/index.js";
import { parseRawViewOptIn, redactEventRows } from "./routes/runs/redaction.js";
import { storeGithubToken } from "./engine/credentials/githubToken.js";
import type { GitHubHttpClient } from "./engine/providers/github.js";
import type { GithubAppTokenMinter } from "./engine/providers/githubAppTokenMinter.js";
import { CiPullRequestNotFoundError, CiRunNotFoundError, pollCiForRun } from "./engine/workflow/ciPolling.js";
import {
  DraftPrRunnerNotFoundError,
  DraftPrRunNotFoundError,
  publishDraftPullRequestForRun,
} from "./engine/workflow/githubDraftPr.js";
import { runHelloWorkflow } from "./engine/workflow/helloRun.js";
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
import { registerAuthBundleImportRoutes } from "./routes/credentials/authBundleImports.js";
import type { ActorContextEnv } from "./middleware/auth.js";

export interface RootApiDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  githubAppMinter: GithubAppTokenMinter;
  identitySecretRef: string;
  helloDependencies: Parameters<typeof runHelloWorkflow>[1];
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function actorOf(c: { var: { actor?: ActorContext } }): ActorContext | undefined {
  return c.var.actor;
}

/**
 * Register the Phase-1 root API endpoints on `app`. Registration order matches
 * the prior inline block in `buildApp`; behavior is identical.
 */
export function mountRootApiRoutes(app: Hono<ActorContextEnv>, deps: RootApiDeps): void {
  const { pool, secrets, githubHttp, githubAppMinter, identitySecretRef } = deps;
  // RLS HTTP-route scoping: these root handlers are RESOURCE-keyed (no `:orgId`
  // path segment), so the auth middleware resolves the request's org from the
  // addressed spec/run/project and publishes it on the `runWithJobOrgId` ambient.
  // The per-run workflow handlers (`draft-pr`, `ci/poll`) issue raw `pool.query`
  // against tenant tables (`runs`/`runners`/`tasks`), so they run on this
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

  // Codex (Phase 1) + Claude/opencode (P3-0012) auth-bundle import routes.
  registerAuthBundleImportRoutes(app, secrets);

  app.post("/credentials/github/import", async (c) => {
    const parsed = githubCredentialImportSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_github_credential", issues: parsed.error.issues }, 400);
    }
    try {
      return c.json(await storeGithubToken(secrets, parsed.data), 201);
    } catch (error) {
      return c.json({ error: "invalid_github_credential", message: messageFromError(error) }, 400);
    }
  });

  app.post("/hello/run", async (c) => {
    // RLS R3b: the hello fixture is cross-org system seeding (its own throwaway
    // fixture org), so it runs on the BYPASSRLS `tanren_system` pool when one is
    // configured, else the runtime pool (inert dev fallback).
    //
    // Plane-split P1: the hello fixture enqueues its own tasks and DRAINS THEM
    // ITSELF in-request, so it runs on a fresh isolated in-process queue —
    // otherwise the standalone run-executor worker (now always polling
    // `job_queue` for `plan` jobs globally) would race it and steal the fixture's
    // `plan` job, breaking `drainHelloQueue`. The durable `job_queue` is proven
    // by the real run path (`smoke-plane-split-worker`). See helloRun.ts.
    const summary = await runHelloWorkflow(getSystemPool() ?? pool, {
      ...deps.helloDependencies,
      jobQueue: new FakeJobQueue(),
    });
    return c.json(summary, 201);
  });

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
          ssh: deps.helloDependencies.ssh,
          runId: c.req.param("runId"),
          identitySecretRef,
          timeoutMs: parsed.data.timeoutMs ?? 30_000,
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

  app.post("/runs/:runId/ci/poll", async (c) => {
    const parsed = ciPollInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid_ci_poll", issues: parsed.error.issues }, 400);
    }
    try {
      return c.json(
        await pollCiForRun({
          pool: scopedPool,
          secrets,
          githubHttp,
          runId: c.req.param("runId"),
          githubAppMinter,
          ...parsed.data,
        }),
        200,
      );
    } catch (error) {
      if (error instanceof CiRunNotFoundError) {
        return c.json({ error: "run_not_found", message: error.message }, 404);
      }
      if (error instanceof CiPullRequestNotFoundError) {
        return c.json({ error: "pull_request_not_found", message: error.message }, 409);
      }
      return c.json({ error: "ci_poll_failed", message: messageFromError(error) }, 502);
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

    const payload = await runWithOrgScope(pool, orgId, async (client) => {
      const run = await client.query("SELECT * FROM runs WHERE run_id = $1", [runId]);
      if (run.rowCount === 0) {
        return;
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
