// In-memory fake `pg.Pool` for the benchmark report/CRUD routes + store. Models
// just enough of the org-scope transaction protocol (`runWithOrgScope` issues
// BEGIN → `SET LOCAL app.current_org_id = '<org>'` → queries → COMMIT) to
// exercise RLS-like tenant isolation WITHOUT a real Postgres: a query inside a
// scoped transaction only sees rows whose owning org matches the SET-LOCAL org,
// so a cross-org read returns zero rows exactly as deny-by-default RLS would.
// `runWithSystemScope` (no SET LOCAL) sees every org — the system bootstrap.

import type pg from "pg";

interface ExperimentRecord {
  experiment_id: string;
  org_id: string;
  title: string;
  knob: string;
  hypothesis: string;
  seed_task_ref: unknown;
  created_at: Date;
}
interface CellRecord {
  cell_id: string;
  experiment_id: string;
  label: string;
  frozen_config: unknown;
  trials_target: number;
}
interface TrialRecord {
  trial_id: string;
  cell_id: string;
  run_id: string;
  trial_index: number;
  accept_result: string | null;
  scorecard: unknown;
}

interface Result {
  rows: Record<string, unknown>[];
  rowCount: number;
}

/** A client checked out from the pool. Carries the per-transaction org GUC. */
class FakeClient {
  private scopedOrg: string | null = null;

  constructor(private readonly store: BenchmarkRoutesPool) {}

  async query(sql: string, params: unknown[] = []): Promise<Result> {
    const text = sql.trim();
    if (text === "BEGIN" || text === "COMMIT" || text.startsWith("ROLLBACK")) return empty();
    const setLocal = /^SET LOCAL app\.current_org_id = '([^']*)'$/u.exec(text);
    if (setLocal !== null) {
      this.scopedOrg = setLocal[1] ?? null;
      return empty();
    }
    return this.store.run(text, params, this.scopedOrg);
  }

  release(): void {
    // no-op
  }
}

function empty(): Result {
  return { rows: [], rowCount: 0 };
}

export class BenchmarkRoutesPool {
  readonly experiments: ExperimentRecord[] = [];
  readonly cells: CellRecord[] = [];
  readonly trials: TrialRecord[] = [];

  async connect(): Promise<FakeClient> {
    return new FakeClient(this);
  }

  /** Direct query (system scope reads call the pool's `.query` w/o a tx). */
  async query(sql: string, params: unknown[] = []): Promise<Result> {
    return this.run(sql.trim(), params, null);
  }

  asPgPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }

  /** True when `scopedOrg` is null (system) or the row's org matches it. */
  private visible(orgId: string, scopedOrg: string | null): boolean {
    return scopedOrg === null || scopedOrg === orgId;
  }

  private cellOrg(cellId: string): string | undefined {
    const cell = this.cells.find((c) => c.cell_id === cellId);
    if (cell === undefined) return undefined;
    return this.experiments.find((e) => e.experiment_id === cell.experiment_id)?.org_id;
  }

  run(text: string, params: unknown[], scopedOrg: string | null): Result {
    // ---- experiments ----
    if (text.startsWith("INSERT INTO experiments")) {
      const [experiment_id, org_id, title, knob, hypothesis, seedJson] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const rec: ExperimentRecord = {
        experiment_id,
        org_id,
        title,
        knob,
        hypothesis,
        seed_task_ref: JSON.parse(seedJson),
        created_at: new Date(),
      };
      this.experiments.push(rec);
      return single(rec);
    }
    if (text.startsWith("SELECT org_id FROM experiments WHERE experiment_id")) {
      const rec = this.experiments.find((e) => e.experiment_id === params[0]);
      return rec === undefined ? empty() : single({ org_id: rec.org_id });
    }
    if (text.startsWith("SELECT 1 FROM experiments WHERE experiment_id")) {
      const rec = this.experiments.find((e) => e.experiment_id === params[0] && this.visible(e.org_id, scopedOrg));
      return rec === undefined ? empty() : single({ "?column?": 1 });
    }
    if (text.startsWith("SELECT experiment_id, org_id, title") && text.includes("ORDER BY created_at DESC")) {
      const rows = this.experiments
        .filter((e) => e.org_id === params[0] && this.visible(e.org_id, scopedOrg))
        .slice()
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      return { rows: rows as unknown as Record<string, unknown>[], rowCount: rows.length };
    }
    if (text.startsWith("SELECT experiment_id, org_id, title")) {
      const rec = this.experiments.find((e) => e.experiment_id === params[0] && this.visible(e.org_id, scopedOrg));
      return rec === undefined ? empty() : single(rec);
    }

    // ---- cells ----
    if (text.startsWith("INSERT INTO experiment_cells")) {
      const [cell_id, experiment_id, label, frozenJson, trials_target] = params as [
        string,
        string,
        string,
        string,
        number,
      ];
      const rec: CellRecord = {
        cell_id,
        experiment_id,
        label,
        frozen_config: JSON.parse(frozenJson),
        trials_target,
      };
      this.cells.push(rec);
      return single(rec);
    }
    if (text.startsWith("SELECT 1 FROM experiment_cells WHERE cell_id")) {
      const org = this.cellOrg(params[0] as string);
      const rec = this.cells.find((c) => c.cell_id === params[0]);
      if (rec === undefined || org === undefined || !this.visible(org, scopedOrg)) return empty();
      return single({ "?column?": 1 });
    }
    if (text.startsWith("SELECT e.org_id") && text.includes("FROM experiment_cells c")) {
      const org = this.cellOrg(params[0] as string);
      return org === undefined ? empty() : single({ org_id: org });
    }
    if (text.startsWith("SELECT cell_id, experiment_id, label") && text.includes("WHERE experiment_id")) {
      const rows = this.cells
        .filter((c) => c.experiment_id === params[0])
        .filter((c) => this.visible(this.cellOrg(c.cell_id) ?? "", scopedOrg))
        .slice()
        .sort((a, b) => a.cell_id.localeCompare(b.cell_id));
      return { rows: rows as unknown as Record<string, unknown>[], rowCount: rows.length };
    }
    if (text.startsWith("SELECT cell_id, experiment_id, label") && text.includes("WHERE cell_id")) {
      const org = this.cellOrg(params[0] as string);
      const rec = this.cells.find((c) => c.cell_id === params[0]);
      if (rec === undefined || org === undefined || !this.visible(org, scopedOrg)) return empty();
      return single(rec);
    }

    // ---- trials ----
    if (text.startsWith("SELECT scorecard FROM experiment_trials WHERE cell_id")) {
      const rows = this.trials
        .filter((t) => t.cell_id === params[0])
        .slice()
        .sort((a, b) => a.trial_index - b.trial_index)
        .map((t) => ({ scorecard: t.scorecard }));
      return { rows, rowCount: rows.length };
    }

    return empty();
  }

  // ---- seed helpers (tests author rows directly) ----
  seedExperiment(rec: Partial<ExperimentRecord> & { experiment_id: string; org_id: string }): void {
    this.experiments.push({
      title: "t",
      knob: "k",
      hypothesis: "h",
      seed_task_ref: { repo: "o/r", sha: "abc", acceptTierHash: "x", corpusTier: 1 },
      created_at: new Date(),
      ...rec,
    });
  }
  seedCell(rec: CellRecord): void {
    this.cells.push(rec);
  }
  seedTrial(rec: TrialRecord): void {
    this.trials.push(rec);
  }
}

function single(row: object): Result {
  return { rows: [row as Record<string, unknown>], rowCount: 1 };
}
