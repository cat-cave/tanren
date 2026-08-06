import { runWithOrgScope } from "../src/orgScope.js";
import { describe, expect, it } from "vitest";

class ScopePool {
  public readonly queries: string[] = [];
  public connects = 0;

  public async connect(): Promise<this> {
    this.connects += 1;
    return this;
  }

  public async query(sql: string): Promise<{ rows: unknown[]; rowCount: number }> {
    this.queries.push(sql);
    return { rows: [], rowCount: 0 };
  }

  public release(): void {}
}

describe("nested organization scopes", () => {
  it("reuses one same-org transaction, rejects cross-org borrowing, and rolls back", async () => {
    const fake = new ScopePool();
    const pool = fake as never;
    await expect(
      runWithOrgScope(pool, "org_eager", async (outer) => {
        await expect(runWithOrgScope(pool, "org_other", async () => {})).rejects.toThrow(
          "cannot enter org scope org_other from active scope org_eager",
        );
        await runWithOrgScope(pool, "org_eager", async (inner) => {
          expect(inner).toBe(outer);
          await inner.query("INSERT PROVISIONAL PROOF");
          throw new Error("ready CAS failed");
        });
      }),
    ).rejects.toThrow("ready CAS failed");

    expect(fake.connects).toBe(1);
    expect(fake.queries).toEqual([
      "BEGIN",
      "SET LOCAL app.current_org_id = 'org_eager'",
      "INSERT PROVISIONAL PROOF",
      "ROLLBACK",
    ]);
  });
});
