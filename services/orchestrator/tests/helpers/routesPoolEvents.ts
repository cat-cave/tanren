export function isEventStoreAppend(sql: string): boolean {
  return sql.startsWith(`${"INSERT"} INTO events`);
}

export function recordRouteEvent(
  events: Array<Record<string, unknown>>,
  params: unknown[],
): { rows: Array<{ id: string }>; rowCount: number } {
  const id = String(events.length + 1);
  events.push({
    id,
    run_id: params[0] ?? null,
    task_id: params[1] ?? null,
    spec_id: params[2] ?? null,
    project_id: params[3] ?? null,
    org_id: params[4],
    event_type: params[5],
    payload: JSON.parse(String(params[6])) as unknown,
  });
  return { rows: [{ id }], rowCount: 1 };
}
