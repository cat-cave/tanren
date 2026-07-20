// no_silent_fallbacks — the native-queue batch cap.
//
// `maxBatchSize` is the per-project batch cap (the single config source of truth). A
// PRESENT-but-CORRUPT project config silently capping at the schema default is a
// wrong-CAP fallback — so a parse failure PROPAGATES. An ABSENT config (`{}`) is not
// corruption and legitimately uses the default cap.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_BATCH_SIZE } from "../src/engine/config/shared.js";
import { resolveMaxBatchSize } from "../src/engine/merge/batchMaxSize.js";

function fakePoolReturningConfig(config: unknown): pg.Pool {
  const query = async (sql: string) => {
    const trimmed = sql.trim().toUpperCase();
    if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (trimmed.startsWith("SELECT CONFIG FROM PROJECTS")) {
      return { rows: [{ config }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release: () => {} } as unknown as pg.PoolClient;
  return { connect: async () => client, query } as unknown as pg.Pool;
}

describe("resolveMaxBatchSize — corrupt cap PROPAGATES, never masked as the default", () => {
  it("THROWS on a corrupt present config (a wrong-cap silent fallback would be masked)", async () => {
    await expect(resolveMaxBatchSize(fakePoolReturningConfig({ version: 99 }), "project_corrupt")).rejects.toThrow(
      /unknown config version/iu,
    );
  });

  it("an ABSENT config ({}) uses the default cap (legitimate)", async () => {
    await expect(resolveMaxBatchSize(fakePoolReturningConfig({}), "project_fresh")).resolves.toBe(
      DEFAULT_MAX_BATCH_SIZE,
    );
  });

  it("a clean config returns its configured cap", async () => {
    await expect(
      resolveMaxBatchSize(fakePoolReturningConfig({ version: 1, maxBatchSize: 9 }), "project_clean"),
    ).resolves.toBe(9);
  });
});
