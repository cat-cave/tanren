/**
 * Bounded org-cost read model. Cost persistence stays behind CostStore and run
 * projection persistence stays behind RunStore; this module only coordinates
 * their keyset pages and owns the opaque dual-stream cursor.
 */

import type pg from "pg";
import { z } from "zod";
import { CostStore, RunStore } from "../../engine/repositories/index.js";
import { systemActor } from "../../engine/state/actor.js";
import { InvalidCursorError, OrgCosts, parsePageSize } from "./contract.js";
import type { OrgCosts as OrgCostsType } from "./contract.js";
import { decodeCostRow, decodeRunListItem } from "./list.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

const BigintText = z.string().regex(/^\d+$/u);
const StreamKey = z
  .object({
    ts: z.coerce.date(),
    id: z.string().min(1),
  })
  .strict();
const EncodedOrgCostsCursor = z
  .object({
    version: z.literal(1),
    orgId: z.string().min(1),
    cost: StreamKey.extend({ id: BigintText }).nullable(),
    run: StreamKey.nullable(),
    costsDone: z.boolean(),
    runsDone: z.boolean(),
  })
  .strict()
  .superRefine((cursor, context) => {
    if (cursor.costsDone && cursor.cost !== null) {
      context.addIssue({ code: "custom", path: ["cost"], message: "completed cost stream must not carry a key" });
    }
    if (cursor.runsDone && cursor.run !== null) {
      context.addIssue({ code: "custom", path: ["run"], message: "completed run stream must not carry a key" });
    }
  });
type OrgCostsCursor = z.infer<typeof EncodedOrgCostsCursor>;

function decodeOrgCostsCursor(value: string | undefined, orgId: string): OrgCostsCursor {
  if (value === undefined || value === "") {
    return { version: 1, orgId, cost: null, run: null, costsDone: false, runsDone: false };
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new InvalidCursorError("org costs cursor is not canonical base64");
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    const cursor = EncodedOrgCostsCursor.parse(parsed);
    if (cursor.orgId !== orgId) throw new InvalidCursorError("org costs cursor belongs to another org");
    if (cursor.cost !== null && BigInt(cursor.cost.id) > 9_223_372_036_854_775_807n) {
      throw new InvalidCursorError("org costs cost id out of range");
    }
    return cursor;
  } catch (error) {
    if (error instanceof InvalidCursorError) throw error;
    throw new InvalidCursorError("malformed org costs cursor");
  }
}

function encodeOrgCostsCursor(cursor: OrgCostsCursor): string {
  return Buffer.from(
    JSON.stringify({
      ...cursor,
      cost: cursor.cost === null ? null : { ts: cursor.cost.ts.toISOString(), id: cursor.cost.id },
      run: cursor.run === null ? null : { ts: cursor.run.ts.toISOString(), id: cursor.run.id },
    }),
    "utf8",
  ).toString("base64");
}

function exactCostId(value: number | string): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new TypeError("unsafe cost id at database boundary");
  }
  const text = String(value);
  if (!/^\d+$/u.test(text) || BigInt(text) > 9_223_372_036_854_775_807n) {
    throw new TypeError("invalid cost id at database boundary");
  }
  return BigInt(text).toString();
}

export interface OrgCostsPageArgs {
  orgId: string;
  cursor: string | undefined;
  pageSize: string | undefined;
}

/** Fetch at most `2 * (pageSize + 1)` rows and return one opaque progress cursor. */
export async function fetchOrgCostsPage(pool: QueryClient, args: OrgCostsPageArgs): Promise<OrgCostsType> {
  const limit = parsePageSize(args.pageSize);
  const cursor = decodeOrgCostsCursor(args.cursor, args.orgId);
  const [costRows, runRows] = await Promise.all([
    cursor.costsDone
      ? Promise.resolve([])
      : CostStore.selectPageForOrg(
          pool,
          {
            orgId: args.orgId,
            cursor: cursor.cost === null ? undefined : { ts: cursor.cost.ts, id: cursor.cost.id },
            limit,
          },
          systemActor,
        ),
    cursor.runsDone
      ? Promise.resolve([])
      : RunStore.selectCostListPageForOrg(
          pool,
          {
            orgId: args.orgId,
            cursor: cursor.run === null ? undefined : { startedAt: cursor.run.ts, runId: cursor.run.id },
            limit,
          },
          systemActor,
        ),
  ]);

  const costs = costRows.slice(0, limit).map((row) => decodeCostRow(row));
  const runs = runRows.slice(0, limit).map((row) => decodeRunListItem(row));
  const costsHaveMore = !cursor.costsDone && costRows.length > limit;
  const runsHaveMore = !cursor.runsDone && runRows.length > limit;
  const next: OrgCostsCursor = {
    version: 1,
    orgId: args.orgId,
    costsDone: cursor.costsDone || !costsHaveMore,
    runsDone: cursor.runsDone || !runsHaveMore,
    cost:
      costsHaveMore && costs.at(-1) !== undefined
        ? { ts: costs.at(-1)!.recordedAt, id: exactCostId(costs.at(-1)!.id) }
        : null,
    run: runsHaveMore && runs.at(-1) !== undefined ? { ts: runs.at(-1)!.startedAt, id: runs.at(-1)!.runId } : null,
  };
  const nextCursor = next.costsDone && next.runsDone ? null : encodeOrgCostsCursor(next);
  return OrgCosts.parse({ orgId: args.orgId, costs, runs, nextCursor });
}
