export type GithubPushIntentRow = Record<string, unknown>;

export type GithubPushIntentQueryResult = { rows: unknown[]; rowCount: number };

export function single<T>(row: T | undefined): GithubPushIntentQueryResult {
  return row === undefined ? { rows: [], rowCount: 0 } : { rows: [row], rowCount: 1 };
}

/** Models the durable table's pending uniqueness and org-scoped reads for SQL fakes. */
export function routeGithubPushIntentQuery(
  pushIntents: Map<string, GithubPushIntentRow>,
  sql: string,
  params: readonly unknown[] = [],
): GithubPushIntentQueryResult | undefined {
  const trimmed = sql.trim();
  if (trimmed.includes("FROM github_push_intents") && trimmed.includes("status = 'pending'")) {
    const match = [...pushIntents.values()].find(
      (row) =>
        row.org_id === params[0] && row.spec_id === params[1] && row.branch === params[2] && row.status === "pending",
    );
    return { rows: match === undefined ? [] : [match], rowCount: match === undefined ? 0 : 1 };
  }
  if (trimmed.includes("FROM github_push_intents") && trimmed.includes("intent_id = $2")) {
    const row = pushIntents.get(String(params[1]));
    return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
  }
  if (trimmed.startsWith("INSERT INTO github_push_intents")) {
    const intentId = String(params[0]);
    const hasPending = [...pushIntents.values()].some(
      (row) =>
        row.org_id === params[1] && row.spec_id === params[4] && row.branch === params[6] && row.status === "pending",
    );
    if (!pushIntents.has(intentId) && !hasPending) {
      pushIntents.set(intentId, {
        intent_id: intentId,
        org_id: params[1],
        project_id: params[2],
        run_id: params[3],
        spec_id: params[4],
        repo_url: params[5],
        branch: params[6],
        intended_sha: params[7],
        source_ref: params[8],
        lease_predecessor_sha: params[9],
        status: "pending",
      });
    }
    return { rows: [], rowCount: 1 };
  }
  if (trimmed.startsWith("UPDATE github_push_intents")) {
    const row = pushIntents.get(String(params[1]));
    if (row?.status === "pending" && row.intended_sha === params[2]) row.status = "completed";
    return { rows: [], rowCount: 1 };
  }
  return undefined;
}
