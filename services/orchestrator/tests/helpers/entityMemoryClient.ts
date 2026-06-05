// Tiny in-memory pg substitute that pattern-matches the SQL emitted by the
// entity stores. Deliberately small: exercises decode/encode and
// cycle detection, not a Postgres replacement.

interface StubResult {
  rowCount: number;
  rows: ReadonlyArray<Record<string, unknown>>;
}

export class EntityMemoryClient {
  readonly queries: Array<{ sql: string; params: ReadonlyArray<unknown> }> = [];
  personas: Map<string, Record<string, unknown>> = new Map();
  behaviors: Map<string, Record<string, unknown>> = new Map();
  milestones: Map<string, Record<string, unknown>> = new Map();
  specBehaviors: Set<string> = new Set();
  specMilestones: Map<string, string> = new Map();
  specDependencies: Set<string> = new Set();
  now: Date = new Date("2026-01-01T00:00:00Z");

  async query(sql: string, params: ReadonlyArray<unknown> = []): Promise<StubResult> {
    this.queries.push({ sql, params });
    const trimmed = sql.trim();

    if (trimmed.startsWith("INSERT INTO personas")) {
      return this.insertPersona(params);
    }
    if (trimmed.startsWith("SELECT") && trimmed.includes("FROM personas WHERE id = $1")) {
      const row = this.personas.get(String(params[0]));
      return single(row);
    }
    if (trimmed.includes("FROM personas") && trimmed.includes("WHERE org_id = $1 AND (scope = 'org'")) {
      const orgId = String(params[0]);
      const projectId = String(params[1]);
      const rows = [...this.personas.values()].filter(
        (p) => p.org_id === orgId && (p.scope === "org" || p.project_id === projectId),
      );
      return { rowCount: rows.length, rows };
    }
    if (trimmed.includes("FROM personas") && trimmed.includes("WHERE org_id = $1")) {
      const orgId = String(params[0]);
      const rows = [...this.personas.values()].filter((p) => p.org_id === orgId);
      return { rowCount: rows.length, rows };
    }

    if (trimmed.startsWith("INSERT INTO behaviors")) {
      return this.insertBehavior(params);
    }
    if (trimmed.startsWith("SELECT") && trimmed.includes("FROM behaviors WHERE id = $1")) {
      const row = this.behaviors.get(String(params[0]));
      return single(row);
    }
    if (trimmed.startsWith("SELECT") && trimmed.includes("FROM behaviors WHERE persona_id = $1")) {
      const personaId = String(params[0]);
      const rows = [...this.behaviors.values()].filter((b) => b.persona_id === personaId);
      return { rowCount: rows.length, rows };
    }
    if (trimmed.includes("FROM behaviors b") && trimmed.includes("INNER JOIN spec_behaviors")) {
      const specId = String(params[0]);
      const behaviorIds = [...this.specBehaviors]
        .filter((k) => k.startsWith(`${specId}::`))
        .map((k) => k.split("::")[1]);
      const rows = behaviorIds
        .map((bid) => this.behaviors.get(bid))
        .filter((b): b is Record<string, unknown> => b !== undefined);
      return { rowCount: rows.length, rows };
    }

    if (trimmed.startsWith("INSERT INTO spec_behaviors")) {
      this.specBehaviors.add(`${String(params[0])}::${String(params[1])}`);
      return { rowCount: 1, rows: [] };
    }
    if (trimmed.startsWith("DELETE FROM spec_behaviors")) {
      this.specBehaviors.delete(`${String(params[0])}::${String(params[1])}`);
      return { rowCount: 1, rows: [] };
    }

    if (trimmed.startsWith("INSERT INTO milestones")) {
      return this.insertMilestone(params);
    }
    if (trimmed.startsWith("SELECT") && trimmed.includes("FROM milestones WHERE id = $1")) {
      const row = this.milestones.get(String(params[0]));
      return single(row);
    }
    if (trimmed.includes("FROM milestones") && trimmed.includes("WHERE project_id = $1")) {
      const projectId = String(params[0]);
      const rows = [...this.milestones.values()]
        .filter((m) => m.project_id === projectId)
        .sort((a, b) => (a.order_index as number) - (b.order_index as number));
      return { rowCount: rows.length, rows };
    }
    if (trimmed.includes("FROM milestones m") && trimmed.includes("INNER JOIN spec_milestones")) {
      const specId = String(params[0]);
      const milestoneId = this.specMilestones.get(specId);
      if (milestoneId === undefined) return { rowCount: 0, rows: [] };
      const row = this.milestones.get(milestoneId);
      return single(row);
    }

    if (trimmed.startsWith("DELETE FROM spec_milestones WHERE spec_id = $1")) {
      this.specMilestones.delete(String(params[0]));
      return { rowCount: 1, rows: [] };
    }
    if (trimmed.startsWith("INSERT INTO spec_milestones")) {
      this.specMilestones.set(String(params[0]), String(params[1]));
      return { rowCount: 1, rows: [] };
    }

    if (trimmed.startsWith("SELECT to_spec_id FROM spec_dependencies WHERE from_spec_id = $1")) {
      const from = String(params[0]);
      const rows = [...this.specDependencies]
        .filter((k) => k.startsWith(`${from}->`))
        .map((k) => ({ to_spec_id: k.split("->")[1] }));
      return { rowCount: rows.length, rows };
    }
    if (trimmed.startsWith("INSERT INTO spec_dependencies")) {
      const key = `${String(params[0])}->${String(params[1])}`;
      this.specDependencies.add(key);
      const row = {
        from_spec_id: String(params[0]),
        to_spec_id: String(params[1]),
        created_at: this.now,
      };
      return { rowCount: 1, rows: [row] };
    }
    if (trimmed.startsWith("DELETE FROM spec_dependencies")) {
      const key = `${String(params[0])}->${String(params[1])}`;
      this.specDependencies.delete(key);
      return { rowCount: 1, rows: [] };
    }
    if (
      trimmed.startsWith("SELECT") &&
      trimmed.includes("FROM spec_dependencies") &&
      trimmed.includes("WHERE from_spec_id = $1")
    ) {
      const from = String(params[0]);
      const rows = [...this.specDependencies]
        .filter((k) => k.startsWith(`${from}->`))
        .map((k) => ({ from_spec_id: from, to_spec_id: k.split("->")[1], created_at: this.now }));
      return { rowCount: rows.length, rows };
    }
    if (
      trimmed.startsWith("SELECT") &&
      trimmed.includes("FROM spec_dependencies") &&
      trimmed.includes("WHERE to_spec_id = $1")
    ) {
      const to = String(params[0]);
      const rows = [...this.specDependencies]
        .filter((k) => k.endsWith(`->${to}`))
        .map((k) => ({ from_spec_id: k.split("->")[0], to_spec_id: to, created_at: this.now }));
      return { rowCount: rows.length, rows };
    }

    return { rowCount: 0, rows: [] };
  }

  private insertPersona(params: ReadonlyArray<unknown>): StubResult {
    const id = String(params[0]);
    const row = {
      id,
      scope: String(params[1]),
      org_id: String(params[2]),
      project_id: (params[3] as string | null) ?? null,
      name: String(params[4]),
      description: String(params[5]),
      metadata: JSON.parse(String(params[6])),
      created_at: this.now,
      updated_at: this.now,
    };
    this.personas.set(id, row);
    return { rowCount: 1, rows: [row] };
  }

  private insertBehavior(params: ReadonlyArray<unknown>): StubResult {
    const id = String(params[0]);
    /* eslint-disable unicorn/no-thenable */
    const row = {
      id,
      persona_id: String(params[1]),
      title: String(params[2]),
      given: String(params[3]),
      when: String(params[4]),
      then: String(params[5]),
      description: (params[6] as string | null) ?? null,
      metadata: JSON.parse(String(params[7])),
      created_at: this.now,
      updated_at: this.now,
    };
    /* eslint-enable unicorn/no-thenable */
    this.behaviors.set(id, row);
    return { rowCount: 1, rows: [row] };
  }

  private insertMilestone(params: ReadonlyArray<unknown>): StubResult {
    const id = String(params[0]);
    const row = {
      id,
      project_id: String(params[1]),
      label: String(params[2]),
      name: String(params[3]),
      description: (params[4] as string | null) ?? null,
      order_index: params[5] as number,
      eta: (params[6] as Date | null) ?? null,
      status: String(params[7]),
      created_at: this.now,
      updated_at: this.now,
    };
    for (const existing of this.milestones.values()) {
      if (existing.project_id === row.project_id && existing.label === row.label) {
        throw new Error("duplicate milestone label in project");
      }
      if (existing.project_id === row.project_id && existing.order_index === row.order_index) {
        throw new Error("duplicate milestone order_index in project");
      }
    }
    this.milestones.set(id, row);
    return { rowCount: 1, rows: [row] };
  }
}

function single(row: Record<string, unknown> | undefined): StubResult {
  return { rowCount: row === undefined ? 0 : 1, rows: row === undefined ? [] : [row] };
}
