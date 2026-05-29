import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createDoctorRoutes, DoctorReport, runDoctor } from "../src/routes/doctor/index.js";
import { RoutesPool } from "./helpers/routesPool.js";

class DoctorPool extends RoutesPool {
  override async query(sql: string): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.startsWith("SELECT 1")) return { rows: [{ ok: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }
}

describe("/doctor route", () => {
  it("matches the DoctorReport zod shape", async () => {
    const pool = new DoctorPool();
    const report = await runDoctor({
      pool: pool.asPgPool(),
      vaultHealthCheck: async () => ({ ok: true, status: 200 }),
    });
    expect(() => DoctorReport.parse(report)).not.toThrow();
    expect(report.checks.map((check) => check.name)).toEqual(["postgres", "vault"]);
    expect(report.ok).toBe(true);
  });

  it("marks vault as fail when the health check returns not-ok", async () => {
    const pool = new DoctorPool();
    const report = await runDoctor({
      pool: pool.asPgPool(),
      vaultHealthCheck: async () => ({ ok: false, status: 503 }),
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "vault")?.status).toBe("fail");
  });

  it("returns the report from the HTTP endpoint without auth", async () => {
    const pool = new DoctorPool();
    const app = new Hono<ActorContextEnv>();
    app.route(
      "/",
      createDoctorRoutes({
        pool: pool.asPgPool(),
        vaultHealthCheck: async () => ({ ok: true, status: 200 }),
      }),
    );
    const response = await app.request("/doctor");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; checks: Array<{ name: string }> };
    expect(body.ok).toBe(true);
    expect(body.checks.length).toBeGreaterThan(0);
  });

  it("captures latencyMs on every check", async () => {
    const pool = new DoctorPool();
    const report = await runDoctor({
      pool: pool.asPgPool(),
      vaultHealthCheck: async () => ({ ok: true, status: 200 }),
      githubAppCheck: async () => ({ ok: true, detail: "github app reachable" }),
      runnerImageCheck: async () => ({ ok: false, detail: "image missing" }),
    });
    expect(report.checks.every((check) => typeof check.latencyMs === "number")).toBe(true);
    expect(report.checks.find((check) => check.name === "runner_image")?.status).toBe("warn");
  });
});
