// In-memory pg substitute scoped to the P2A-0019 Forge thread/turn stores
// and the embedded scope checks. Mirrors the entity/routes memory clients;
// only the SQL fragments emitted by the forge layer are handled.

interface QueryResult {
  rowCount: number;
  rows: ReadonlyArray<Record<string, unknown>>;
}

interface ThreadRow {
  id: string;
  org_id: string;
  project_id: string | null;
  run_id: string | null;
  scope: string;
  title: string | null;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}

interface TurnRow {
  id: string;
  thread_id: string;
  turn_index: number;
  source: unknown;
  audience: string;
  author_kind: string;
  render: unknown;
  created_at: Date;
}

interface ProposalRow {
  id: string;
  org_id: string;
  thread_id: string;
  proposing_turn_id: string;
  tool_name: string;
  args: unknown;
  rationale: string;
  status: string;
  proposed_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  result: unknown;
  error: string | null;
}

export class ForgeMemoryClient {
  readonly threads = new Map<string, ThreadRow>();
  readonly turns: TurnRow[] = [];
  readonly proposals: ProposalRow[] = [];
  readonly queries: Array<{ sql: string; params: ReadonlyArray<unknown> }> = [];
  now: Date = new Date("2026-01-01T00:00:00Z");

  async query(sql: string, params: ReadonlyArray<unknown> = []): Promise<QueryResult> {
    this.queries.push({ sql, params });
    const trimmed = sql.trim();
    if (trimmed.startsWith("INSERT INTO forge_threads")) {
      const row: ThreadRow = {
        id: String(params[0]),
        org_id: String(params[1]),
        project_id: params[2] === null || params[2] === undefined ? null : String(params[2]),
        run_id: params[3] === null || params[3] === undefined ? null : String(params[3]),
        scope: String(params[4]),
        title: params[5] === null || params[5] === undefined ? null : String(params[5]),
        created_at: this.now,
        updated_at: this.now,
        closed_at: null,
      };
      this.threads.set(row.id, row);
      return single(row);
    }
    if (trimmed.startsWith("SELECT") && trimmed.includes("FROM forge_threads WHERE id = $1")) {
      const row = this.threads.get(String(params[0]));
      return single(row);
    }
    if (trimmed.includes("FROM forge_threads") && trimmed.includes("org_id = $1 AND project_id = $2 AND run_id = $3")) {
      const rows = [...this.threads.values()].filter(
        (t) => t.org_id === params[0] && t.project_id === params[1] && t.run_id === params[2],
      );
      return { rows, rowCount: rows.length };
    }
    if (trimmed.includes("FROM forge_threads") && trimmed.includes("org_id = $1 AND project_id = $2")) {
      const rows = [...this.threads.values()].filter((t) => t.org_id === params[0] && t.project_id === params[1]);
      return { rows, rowCount: rows.length };
    }
    if (trimmed.startsWith("UPDATE forge_threads SET updated_at")) {
      const t = this.threads.get(String(params[0]));
      if (t !== undefined) t.updated_at = new Date(this.now.getTime() + 1);
      return { rows: [], rowCount: t === undefined ? 0 : 1 };
    }
    if (trimmed.startsWith("UPDATE forge_threads SET closed_at")) {
      const t = this.threads.get(String(params[0]));
      if (t !== undefined) {
        t.closed_at = this.now;
        t.updated_at = this.now;
        return single(t);
      }
      return { rows: [], rowCount: 0 };
    }
    if (trimmed.startsWith("SELECT COALESCE(MAX(turn_index)")) {
      const threadId = String(params[0]);
      const max = this.turns
        .filter((t) => t.thread_id === threadId)
        .reduce<number>((m, t) => Math.max(m, t.turn_index), -1);
      return { rows: [{ next_index: max + 1 }], rowCount: 1 };
    }
    if (trimmed.startsWith("INSERT INTO forge_turns")) {
      const row: TurnRow = {
        id: String(params[0]),
        thread_id: String(params[1]),
        turn_index: Number(params[2]),
        source: JSON.parse(String(params[3])),
        audience: String(params[4]),
        author_kind: String(params[5]),
        render: JSON.parse(String(params[6])),
        created_at: this.now,
      };
      this.turns.push(row);
      return single(row);
    }
    if (
      trimmed.startsWith("SELECT") &&
      trimmed.includes("FROM forge_turns") &&
      trimmed.includes("WHERE thread_id = $1 AND turn_index > $2")
    ) {
      const threadId = String(params[0]);
      const since = Number(params[1]);
      const limit = Number(params[2]);
      const rows = this.turns
        .filter((t) => t.thread_id === threadId && t.turn_index > since)
        .sort((a, b) => a.turn_index - b.turn_index)
        .slice(0, limit);
      return { rows, rowCount: rows.length };
    }
    if (trimmed.startsWith("SELECT") && trimmed.includes("FROM forge_turns WHERE id = $1")) {
      const row = this.turns.find((t) => t.id === String(params[0]));
      return single(row);
    }
    // ---- P3-0010 forge_action_proposals ----
    if (trimmed.startsWith("INSERT INTO forge_action_proposals")) {
      const row: ProposalRow = {
        id: String(params[0]),
        org_id: String(params[1]),
        thread_id: String(params[2]),
        proposing_turn_id: String(params[3]),
        tool_name: String(params[4]),
        args: JSON.parse(String(params[5])),
        rationale: String(params[6]),
        status: "pending",
        proposed_at: this.now,
        decided_by: null,
        decided_at: null,
        result: null,
        error: null,
      };
      this.proposals.push(row);
      return single(row);
    }
    if (trimmed.startsWith("SELECT") && trimmed.includes("FROM forge_action_proposals WHERE id = $1")) {
      const row = this.proposals.find((p) => p.id === String(params[0]));
      return single(row);
    }
    if (
      trimmed.startsWith("SELECT") &&
      trimmed.includes("FROM forge_action_proposals") &&
      trimmed.includes("WHERE thread_id = $1")
    ) {
      const rows = this.proposals
        .filter((p) => p.thread_id === String(params[0]))
        .sort((a, b) => b.proposed_at.getTime() - a.proposed_at.getTime());
      return { rows, rowCount: rows.length };
    }
    if (trimmed.startsWith("UPDATE forge_action_proposals") && trimmed.includes("status = 'pending'")) {
      // The idempotent decision claim: only transitions a still-pending row.
      const row = this.proposals.find((p) => p.id === String(params[0]) && p.status === "pending");
      if (row === undefined) return { rows: [], rowCount: 0 };
      row.status = String(params[1]);
      row.decided_by = String(params[2]);
      row.decided_at = this.now;
      return single(row);
    }
    if (trimmed.startsWith("UPDATE forge_action_proposals")) {
      // recordOutcome: set executed/failed + result/error.
      const row = this.proposals.find((p) => p.id === String(params[0]));
      if (row === undefined) return { rows: [], rowCount: 0 };
      row.status = String(params[1]);
      row.result = params[2] === null || params[2] === undefined ? null : JSON.parse(String(params[2]));
      row.error = params[3] === null || params[3] === undefined ? null : String(params[3]);
      return single(row);
    }
    return { rows: [], rowCount: 0 };
  }
}

function single<T>(row: T | undefined): QueryResult {
  if (row === undefined) return { rows: [], rowCount: 0 };
  return { rows: [row as unknown as Record<string, unknown>], rowCount: 1 };
}
