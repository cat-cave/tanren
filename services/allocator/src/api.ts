import { Hono } from "hono";
import { z } from "zod";
import type { RunnerLifecycle } from "./runnerLifecycle.js";

export interface AllocatorApiOptions {
  lifecycle: RunnerLifecycle;
  /** Bearer token required on /allocate and /release calls. */
  authToken: string;
  /** Liveness probe for the docker daemon. */
  dockerPing: () => Promise<boolean>;
}

const allocateSchema = z.object({
  // runId/projectId are the runner's naming HANDLE (container + volume names).
  // For a runless Forge ideation allocation they are still a non-empty synthetic
  // handle, but the persisted runners row's run_id/project_id columns are NULL
  // (see `runless`), so they need not be real `runs` / `projects` rows.
  runId: z.string().min(1),
  projectId: z.string().min(1),
  runnerImage: z.string().min(1),
  // De-priv: the allocator SERVICE persists a tenant `runners` row, so it
  // REQUIRES the run's org and writes the row under that org's RLS scope. A
  // request without an org is rejected — the service can never write off-RLS.
  orgId: z.string().min(1),
  // RUNLESS Forge ideation marker. When true, the persisted runners row's
  // run_id is written as NULL (no `runs` row) so the insert does not violate the
  // run_id→runs foreign key (the synthetic handle is NOT a real run). org_id is
  // still required and real.
  runless: z.boolean().default(false),
  // The value to persist to project_id when `runless`: the REAL project id for a
  // project-scoped Forge surface (preserves attribution), or null/absent for the
  // project-less greenfield interview. Ignored when `runless` is false.
  persistedProjectId: z.string().min(1).nullish(),
});

const releaseSchema = z.object({
  runnerId: z.string().min(1),
  reason: z.enum(["completed", "failed", "abandoned"]),
});

export function createAllocatorApi(options: AllocatorApiOptions): Hono {
  const app = new Hono();

  app.get("/healthz", async (c) => {
    const ok = await options.dockerPing();
    return c.json({ service: "allocator", ok }, ok ? 200 : 503);
  });

  app.use("/allocate", requireBearer(options.authToken));
  app.use("/release", requireBearer(options.authToken));

  app.post("/allocate", async (c) => {
    const parsed = allocateSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_allocate_request", issues: parsed.error.issues }, 400);
    }
    try {
      const result = await options.lifecycle.allocate(parsed.data);
      return c.json(result, 201);
    } catch (error) {
      return c.json({ error: "allocate_failed", message: messageFromError(error) }, 500);
    }
  });

  app.post("/release", async (c) => {
    const parsed = releaseSchema.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) {
      return c.json({ error: "invalid_release_request", issues: parsed.error.issues }, 400);
    }
    try {
      const result = await options.lifecycle.release(parsed.data.runnerId, parsed.data.reason);
      return c.json(result, 200);
    } catch (error) {
      return c.json({ error: "release_failed", message: messageFromError(error) }, 500);
    }
  });

  return app;
}

function requireBearer(token: string) {
  return async (
    c: {
      req: { header: (name: string) => string | undefined };
      json: (body: unknown, status: number) => unknown;
    },
    next: () => Promise<void>,
  ) => {
    const provided = c.req.header("authorization");
    if (provided !== `Bearer ${token}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
