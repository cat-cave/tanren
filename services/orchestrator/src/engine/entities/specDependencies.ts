import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

// P2A-0018: spec dependencies form a DAG. An edge `from -> to` means `from`
// depends on `to` (i.e. `to` must complete first). Cycle detection runs on
// every insert; an attempt that would close a cycle throws
// CyclicSpecDependencyError carrying the printable cycle path.

export const SpecDependencyRow = z.object({
  fromSpecId: z.string().min(1),
  toSpecId: z.string().min(1),
  createdAt: z.date()
});
export type SpecDependencyRow = z.infer<typeof SpecDependencyRow>;

interface RawSpecDependencyRow {
  from_spec_id: unknown;
  to_spec_id: unknown;
  created_at: unknown;
}

const SELECT_DEPENDENCY_COLUMNS = `from_spec_id, to_spec_id, created_at`;

function decodeDependencyRow(raw: RawSpecDependencyRow): SpecDependencyRow {
  return SpecDependencyRow.parse({
    fromSpecId: raw.from_spec_id,
    toSpecId: raw.to_spec_id,
    createdAt: raw.created_at
  });
}

export class CyclicSpecDependencyError extends Error {
  constructor(readonly cycle: ReadonlyArray<string>) {
    super(`cyclic spec dependency: ${cycle.join(" -> ")}`);
    this.name = "CyclicSpecDependencyError";
  }
}

export class SelfSpecDependencyError extends Error {
  constructor(readonly specId: string) {
    super(`spec ${specId} cannot depend on itself`);
    this.name = "SelfSpecDependencyError";
  }
}

// assertNoCycle DFS-walks the existing dependency graph starting from
// `toSpecId` (following `from -> to` edges forward). If it reaches
// `fromSpecId`, adding (fromSpecId -> toSpecId) would close a cycle; we throw
// with the full path so operators can see exactly which edges to remove.
export async function assertNoCycle(
  client: QueryClient,
  fromSpecId: string,
  toSpecId: string
): Promise<void> {
  if (fromSpecId === toSpecId) {
    throw new SelfSpecDependencyError(fromSpecId);
  }
  const visited = new Set<string>();
  // Parents records the edge that first reached a node so we can reconstruct
  // the cycle path.
  const parents = new Map<string, string>();
  const stack: string[] = [toSpecId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);

    if (current === fromSpecId) {
      // Walk back from `fromSpecId` through `parents` to reconstruct the
      // existing path toSpecId -> ... -> fromSpecId. The would-be new edge
      // fromSpecId -> toSpecId closes the cycle, so we render it as
      // fromSpecId -> toSpecId -> ... -> fromSpecId.
      const backtrack: string[] = [fromSpecId];
      let node = fromSpecId;
      while (node !== toSpecId) {
        const parent = parents.get(node);
        if (parent === undefined) break;
        backtrack.push(parent);
        node = parent;
      }
      // backtrack is [fromSpecId, ..., toSpecId]; the existing chain is the
      // reverse, [toSpecId, ..., fromSpecId]. Prepending fromSpecId shows the
      // new edge that would close the cycle.
      // Manual reverse to avoid both Array#reverse (which mutates) and
       // Array#toReversed (which needs a newer lib target).
      const existingChain: string[] = [];
      for (let i = backtrack.length - 1; i >= 0; i--) {
        const entry = backtrack[i];
        if (entry !== undefined) existingChain.push(entry);
      }
      const cyclePath = [fromSpecId, ...existingChain];
      throw new CyclicSpecDependencyError(cyclePath);
    }

    const result = await client.query(
      `SELECT to_spec_id FROM spec_dependencies WHERE from_spec_id = $1`,
      [current]
    );
    for (const row of result.rows as Array<{ to_spec_id: unknown }>) {
      const next = String(row.to_spec_id);
      if (!visited.has(next)) {
        parents.set(next, current);
        stack.push(next);
      }
    }
  }
}

export const SpecDependencyStore = {
  async insert(
    client: QueryClient,
    args: { fromSpecId: string; toSpecId: string },
    _actor: ActorContext
  ): Promise<SpecDependencyRow> {
    await assertNoCycle(client, args.fromSpecId, args.toSpecId);
    const result = await client.query(
      `INSERT INTO spec_dependencies (from_spec_id, to_spec_id)
       VALUES ($1, $2)
       ON CONFLICT (from_spec_id, to_spec_id) DO UPDATE SET created_at = spec_dependencies.created_at
       RETURNING ${SELECT_DEPENDENCY_COLUMNS}`,
      [args.fromSpecId, args.toSpecId]
    );
    return decodeDependencyRow(result.rows[0] as RawSpecDependencyRow);
  },

  async remove(
    client: QueryClient,
    args: { fromSpecId: string; toSpecId: string },
    _actor: ActorContext
  ): Promise<void> {
    await client.query(
      `DELETE FROM spec_dependencies WHERE from_spec_id = $1 AND to_spec_id = $2`,
      [args.fromSpecId, args.toSpecId]
    );
  },

  async listOutgoing(
    client: QueryClient,
    fromSpecId: string,
    _actor: ActorContext
  ): Promise<SpecDependencyRow[]> {
    const result = await client.query(
      `SELECT ${SELECT_DEPENDENCY_COLUMNS} FROM spec_dependencies
       WHERE from_spec_id = $1
       ORDER BY to_spec_id`,
      [fromSpecId]
    );
    return result.rows.map((row) => decodeDependencyRow(row as RawSpecDependencyRow));
  },

  async listIncoming(
    client: QueryClient,
    toSpecId: string,
    _actor: ActorContext
  ): Promise<SpecDependencyRow[]> {
    const result = await client.query(
      `SELECT ${SELECT_DEPENDENCY_COLUMNS} FROM spec_dependencies
       WHERE to_spec_id = $1
       ORDER BY from_spec_id`,
      [toSpecId]
    );
    return result.rows.map((row) => decodeDependencyRow(row as RawSpecDependencyRow));
  }
} as const;
