import type pg from "pg";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_BATCH_SIZE } from "../src/engine/contracts/batchMergeCoordinator.js";
import { IntegrationGraphScheduler } from "../src/engine/merge/integrationGraphScheduler.js";
import { buildIntegrationGraphScheduler } from "../src/engine/merge/integrationGraphSchedulerBuild.js";
import type { BuildMergeCoordinatorDeps } from "../src/engine/merge/coordinatorBuild.js";

class ConfigPool {
  public async query(sql: string): Promise<{ rows: Array<{ config: unknown }>; rowCount: number }> {
    if (sql.includes("SELECT config FROM projects")) return { rows: [{ config: {} }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }

  public async connect(): Promise<this> {
    return this;
  }

  public release(): void {}

  public asPgPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}

describe("IntegrationGraphScheduler production assembly", () => {
  it("uses the production scheduler builder and real project cap resolver; no default selector remains", async () => {
    const scheduler = buildIntegrationGraphScheduler({
      pool: new ConfigPool().asPgPool(),
    } as BuildMergeCoordinatorDeps);

    const decision = await scheduler.schedule({
      projectId: "project_schedule",
      entries: [],
      mergedSpecIds: new Set(),
      mergingInFlight: false,
    });

    expect(scheduler).toBeInstanceOf(IntegrationGraphScheduler);
    expect(decision.formation.batch).toEqual([]);
    expect(decision.plan.dynamicCapacity.maximum).toBe(DEFAULT_MAX_BATCH_SIZE);
    expect(decision.plan.blockers).toEqual(["no_eligible_candidate"]);
  });
});
