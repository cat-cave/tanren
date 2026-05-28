// P2A-0013: /doctor JSON endpoint. Mirrors the CLI `tanren doctor` output by
// reusing the same check functions. Both surfaces wire through `runDoctor`.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import type { ActorContextEnv } from "../../middleware/auth.js";

interface DoctorRoutesOptions {
  pool: pg.Pool;
  secrets?: SecretStore;
  vaultHealthCheck?: () => Promise<{ ok: boolean; status: number }>;
  /** Optional ping against the runner identity / SSH substrate. */
  runnerSshCheck?: () => Promise<{ ok: boolean; detail: string }>;
  /** Optional probe for GitHub App reachability. */
  githubAppCheck?: () => Promise<{ ok: boolean; detail: string }>;
  /** Optional runner image availability probe (e.g. docker inspect). */
  runnerImageCheck?: () => Promise<{ ok: boolean; detail: string }>;
}

export const DoctorCheckStatus = z.enum(["ok", "warn", "fail"]);
export type DoctorCheckStatus = z.infer<typeof DoctorCheckStatus>;

export const DoctorCheck = z.object({
  name: z.string(),
  status: DoctorCheckStatus,
  detail: z.string(),
  latencyMs: z.number().int().nullable()
});
export type DoctorCheck = z.infer<typeof DoctorCheck>;

export const DoctorReport = z.object({
  ok: z.boolean(),
  checks: z.array(DoctorCheck),
  generatedAt: z.string()
});
export type DoctorReport = z.infer<typeof DoctorReport>;

export async function runDoctor(options: DoctorRoutesOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  checks.push(
    await timedCheck("postgres", async () => {
      const result = await options.pool.query<{ ok: number }>("SELECT 1 AS ok");
      return result.rows[0]?.ok === 1
        ? { status: "ok", detail: "SELECT 1 returned" }
        : { status: "fail", detail: "SELECT 1 did not return 1" };
    })
  );

  if (options.vaultHealthCheck !== undefined) {
    checks.push(
      await timedCheck("vault", async () => {
        const result = await options.vaultHealthCheck!();
        return result.ok
          ? { status: "ok", detail: `vault status ${result.status}` }
          : { status: "fail", detail: `vault status ${result.status}` };
      })
    );
  }

  if (options.runnerSshCheck !== undefined) {
    checks.push(
      await timedCheck("runner_ssh", async () => {
        const result = await options.runnerSshCheck!();
        return result.ok
          ? { status: "ok", detail: result.detail }
          : { status: "fail", detail: result.detail };
      })
    );
  }

  if (options.githubAppCheck !== undefined) {
    checks.push(
      await timedCheck("github_app", async () => {
        const result = await options.githubAppCheck!();
        return result.ok
          ? { status: "ok", detail: result.detail }
          : { status: "warn", detail: result.detail };
      })
    );
  }

  if (options.runnerImageCheck !== undefined) {
    checks.push(
      await timedCheck("runner_image", async () => {
        const result = await options.runnerImageCheck!();
        return result.ok
          ? { status: "ok", detail: result.detail }
          : { status: "warn", detail: result.detail };
      })
    );
  }

  const ok = checks.every((check) => check.status === "ok");
  return {
    ok,
    checks,
    generatedAt: new Date().toISOString()
  };
}

async function timedCheck(
  name: string,
  body: () => Promise<{ status: DoctorCheckStatus; detail: string }>
): Promise<DoctorCheck> {
  const start = Date.now();
  try {
    const result = await body();
    return { name, status: result.status, detail: result.detail, latencyMs: Date.now() - start };
  } catch (error) {
    return {
      name,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - start
    };
  }
}

export function createDoctorRoutes(options: DoctorRoutesOptions) {
  const app = new Hono<ActorContextEnv>();

  app.get("/doctor", async (c) => {
    const report = await runDoctor(options);
    return c.json(report);
  });

  return app;
}
