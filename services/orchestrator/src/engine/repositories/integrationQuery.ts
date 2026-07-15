/** Narrow SQL port shared by the integration repositories and their structural fakes. */
export interface IntegrationQueryResult {
  rows: unknown[];
  rowCount: number | null;
}

export interface IntegrationQueryClient {
  query(sql: string, params?: unknown[]): Promise<IntegrationQueryResult>;
}
