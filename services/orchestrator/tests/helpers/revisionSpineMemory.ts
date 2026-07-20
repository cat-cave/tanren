// rv-1 — in-memory stub for the append-only persona/behavior revision spine, so
// the DB-less derive-path tests (which mint revisions at spec-freeze) don't need a
// real Postgres. Pattern-matches the SQL that behaviorRevisionStore.ts emits.
// Returns `undefined` for any SQL it does not own (caller falls through).

interface StubResult {
  rows: unknown[];
  rowCount: number;
}

type Row = Record<string, unknown>;

function insertPersonaRevision(store: Map<string, Row>, params: readonly unknown[]): StubResult {
  const row: Row = {
    id: params[0],
    org_id: params[1],
    project_id: params[2] ?? null,
    persona_id: params[3],
    scope: params[4],
    revision_number: params[5],
    name: params[6],
    description: params[7],
    attributes: JSON.parse(String(params[8])),
    content_digest: params[9],
    authoring_provenance: JSON.parse(String(params[10])),
    supersedes_id: params[11] ?? null,
    status: "active",
    created_at: new Date().toISOString(),
  };
  store.set(String(params[0]), row);
  return { rows: [row], rowCount: 1 };
}

function insertBehaviorRevision(store: Map<string, Row>, params: readonly unknown[]): StubResult {
  /* eslint-disable unicorn/no-thenable */
  const row: Row = {
    id: params[0],
    org_id: params[1],
    project_id: params[2] ?? null,
    behavior_id: params[3],
    persona_revision_id: params[4],
    revision_number: params[5],
    title: params[6],
    given: params[7],
    when: params[8],
    then: params[9],
    acceptance: JSON.parse(String(params[10])),
    content_digest: params[11],
    design_contract_digest: params[12] ?? null,
    authoring_provenance: JSON.parse(String(params[13])),
    supersedes_id: params[14] ?? null,
    status: "active",
    created_at: new Date().toISOString(),
  };
  /* eslint-enable unicorn/no-thenable */
  store.set(String(params[0]), row);
  return { rows: [row], rowCount: 1 };
}

function supersede(store: Map<string, Row>, params: readonly unknown[]): StubResult {
  const row = store.get(String(params[1]));
  if (row === undefined || row.org_id !== params[0] || row.status !== "active") return { rows: [], rowCount: 0 };
  row.status = "superseded";
  return { rows: [], rowCount: 1 };
}

function selectRevision(
  store: Map<string, Row>,
  lineageCol: string,
  sql: string,
  params: readonly unknown[],
): StubResult {
  if (sql.includes("AND id = $2")) {
    const row = store.get(String(params[1]));
    const hit = row !== undefined && row.org_id === params[0] ? row : undefined;
    return hit === undefined ? { rows: [], rowCount: 0 } : { rows: [hit], rowCount: 1 };
  }
  let rows = [...store.values()].filter((r) => r.org_id === params[0]);
  rows = sql.includes("content_digest = $2")
    ? rows.filter((r) => r.content_digest === params[1])
    : rows.filter((r) => r[lineageCol] === params[1]);
  if (sql.includes("status = 'active'")) rows = rows.filter((r) => r.status === "active");
  rows.sort((a, b) => (b.revision_number as number) - (a.revision_number as number));
  return rows[0] === undefined ? { rows: [], rowCount: 0 } : { rows: [rows[0]], rowCount: 1 };
}

/** Build a handler closing over fresh persona/behavior revision maps. */
export function createRevisionSpineStub(): (sql: string, params: readonly unknown[]) => StubResult | undefined {
  const personaRevisions = new Map<string, Row>();
  const behaviorRevisions = new Map<string, Row>();
  return (sql, params) => {
    if (sql.startsWith("INSERT INTO persona_revisions")) return insertPersonaRevision(personaRevisions, params);
    if (sql.startsWith("INSERT INTO behavior_revisions")) return insertBehaviorRevision(behaviorRevisions, params);
    if (sql.startsWith("UPDATE persona_revisions SET status")) return supersede(personaRevisions, params);
    if (sql.startsWith("UPDATE behavior_revisions SET status")) return supersede(behaviorRevisions, params);
    if (sql.includes("FROM persona_revisions")) return selectRevision(personaRevisions, "persona_id", sql, params);
    if (sql.includes("FROM behavior_revisions")) return selectRevision(behaviorRevisions, "behavior_id", sql, params);
  };
}
