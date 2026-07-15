import { describe, expect, it } from "vitest";
import { runScopedOrgRead, type ScopedTxClient } from "./plane-split-tx.js";

type Call = { op: "query" | "release"; sql?: string };

function trackingClient(options: { failOnSql?: (sql: string) => Error | undefined; rollbackError?: Error }): {
  client: ScopedTxClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const client: ScopedTxClient = {
    async query(sql: string) {
      calls.push({ op: "query", sql });
      if (sql === "ROLLBACK" && options.rollbackError !== undefined) {
        throw options.rollbackError;
      }
      const injected = options.failOnSql?.(sql);
      if (injected !== undefined) throw injected;
      return { rowCount: 0, rows: [] };
    },
    release() {
      calls.push({ op: "release" });
    },
  };
  return { client, calls };
}

describe("runScopedOrgRead", () => {
  it("commits and releases on success without ROLLBACK", async () => {
    const { client, calls } = trackingClient({});
    const result = await runScopedOrgRead(client, "org_x", async () => 42);
    expect(result).toBe(42);
    expect(calls.map((c) => c.op)).toEqual(["query", "query", "query", "release"]);
    expect(calls.filter((c) => c.op === "query").map((c) => c.sql)).toEqual([
      "BEGIN",
      "SELECT set_config('app.current_org_id', $1, true)",
      "COMMIT",
    ]);
  });

  it("on mid-probe failure, ROLLBACK precedes release and original error is preserved", async () => {
    const probeError = new Error("injected mid-probe failure");
    const { client, calls } = trackingClient({
      failOnSql: (sql) => (sql.includes("FROM runs") ? probeError : undefined),
    });
    await expect(
      runScopedOrgRead(client, "org_x", async () => {
        await client.query("SELECT status FROM runs WHERE run_id = $1", ["run_1"]);
        return "unreachable";
      }),
    ).rejects.toBe(probeError);

    const ops = calls.map((c) => (c.op === "query" ? c.sql : c.op));
    const rollbackAt = ops.indexOf("ROLLBACK");
    const releaseAt = ops.indexOf("release");
    expect(rollbackAt).toBeGreaterThan(-1);
    expect(releaseAt).toBeGreaterThan(-1);
    expect(rollbackAt).toBeLessThan(releaseAt);
    // No dirty transaction returned: release is last, after ROLLBACK.
    expect(ops.at(-1)).toBe("release");
    expect(ops).not.toContain("COMMIT");
  });

  it("does not mask the original error when ROLLBACK itself fails", async () => {
    const probeError = new Error("probe boom");
    const { client, calls } = trackingClient({
      failOnSql: (sql) => (sql.includes("FROM runs") ? probeError : undefined),
      rollbackError: new Error("rollback boom"),
    });
    await expect(
      runScopedOrgRead(client, null, async () => {
        await client.query("SELECT status FROM runs WHERE run_id = $1", ["run_1"]);
        return "unreachable";
      }),
    ).rejects.toBe(probeError);
    expect(calls.some((c) => c.op === "query" && c.sql === "ROLLBACK")).toBe(true);
    expect(calls.some((c) => c.op === "release")).toBe(true);
  });

  it("releases without ROLLBACK when BEGIN fails", async () => {
    const beginError = new Error("begin failed");
    const { client, calls } = trackingClient({
      failOnSql: (sql) => (sql === "BEGIN" ? beginError : undefined),
    });
    await expect(runScopedOrgRead(client, "org_x", async () => "unreachable")).rejects.toBe(beginError);
    expect(calls.map((c) => (c.op === "query" ? c.sql : c.op))).toEqual(["BEGIN", "release"]);
  });
});
