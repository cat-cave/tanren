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
  runId: z.string().min(1),
  projectId: z.string().min(1),
  runnerImage: z.string().min(1),
  vaultRefs: z.array(z.string().min(1)).default([])
});

const releaseSchema = z.object({
  runnerId: z.string().min(1),
  reason: z.enum(["completed", "failed", "abandoned"])
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
    const parsed = allocateSchema.safeParse(await c.req.json().catch(() => undefined));
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
    const parsed = releaseSchema.safeParse(await c.req.json().catch(() => undefined));
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
  return async (c: { req: { header: (name: string) => string | undefined }; json: (body: unknown, status: number) => unknown }, next: () => Promise<void>) => {
    const provided = c.req.header("authorization");
    if (provided !== `Bearer ${token}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
    return undefined;
  };
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
