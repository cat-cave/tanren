export interface ProjectDerivationFakeRow {
  org_id: string;
  id: string;
  project_id: string;
  idempotency_fingerprint: string;
  phase: string;
  status: string;
  sanitized_input: Record<string, unknown>;
  sanitized_error: Record<string, unknown> | null;
  template_receipt: Record<string, unknown> | null;
  result_receipt: Record<string, unknown>;
  ownership_receipt: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

interface QueryResult {
  rows: unknown[];
  rowCount: number;
}

export function handleProjectDerivationQuery(
  rows: Map<string, ProjectDerivationFakeRow>,
  sql: string,
  params: unknown[],
): QueryResult | undefined {
  if (sql.startsWith("SELECT") && sql.includes("FROM project_derivations")) {
    if (sql.includes("AND id = $2")) return single(rows.get(`${String(params[0])}:${String(params[1])}`));
    if (sql.includes("idempotency_fingerprint = $2")) {
      return single(
        [...rows.values()].find(
          (item) => item.org_id === String(params[0]) && item.idempotency_fingerprint === String(params[1]),
        ),
      );
    }
    const row = [...rows.values()]
      .filter((item) => item.org_id === String(params[0]) && item.project_id === String(params[1]))
      .sort((left, right) => right.created_at.getTime() - left.created_at.getTime())[0];
    return single(row);
  }
  if (sql.startsWith("INSERT INTO project_derivations")) {
    const existing = [...rows.values()].find(
      (item) => item.org_id === String(params[0]) && item.idempotency_fingerprint === String(params[3]),
    );
    if (existing !== undefined) {
      existing.updated_at = new Date();
      return single(existing);
    }
    const row: ProjectDerivationFakeRow = {
      org_id: String(params[0]),
      id: String(params[1]),
      project_id: String(params[2]),
      idempotency_fingerprint: String(params[3]),
      phase: "shell",
      status: "in_progress",
      sanitized_input: JSON.parse(String(params[4])) as Record<string, unknown>,
      ownership_receipt: JSON.parse(String(params[5])) as Record<string, unknown>,
      template_receipt: params[6] === null ? null : (JSON.parse(String(params[6])) as Record<string, unknown>),
      result_receipt: {},
      sanitized_error: null,
      created_at: new Date(),
      updated_at: new Date(),
      completed_at: null,
    };
    rows.set(`${row.org_id}:${row.id}`, row);
    return single(row);
  }
  if (!sql.startsWith("UPDATE project_derivations")) return undefined;
  const row = rows.get(`${String(params[0])}:${String(params[1])}`);
  if (row === undefined || row.status !== "in_progress") return { rows: [], rowCount: 0 };
  if (sql.includes("template_receipt =")) {
    row.template_receipt = JSON.parse(String(params[2])) as Record<string, unknown>;
    row.phase = String(params[3]);
    row.sanitized_error = null;
  } else if (sql.includes("result_receipt = jsonb_set")) {
    row.result_receipt[String(params[2])] = JSON.parse(String(params[3])) as unknown;
    row.phase = String(params[4]);
    row.sanitized_error = null;
  } else if (sql.includes("sanitized_error = $3")) {
    row.sanitized_error = JSON.parse(String(params[2])) as Record<string, unknown>;
    row.updated_at = new Date();
    return { rows: [], rowCount: 1 };
  } else if (sql.includes("status = 'succeeded'")) {
    row.phase = "activate";
    row.status = "succeeded";
    row.sanitized_error = null;
    row.completed_at ??= new Date();
  }
  row.updated_at = new Date();
  return single(row);
}

function single(row: ProjectDerivationFakeRow | undefined): QueryResult {
  return row === undefined ? { rows: [], rowCount: 0 } : { rows: [row], rowCount: 1 };
}
