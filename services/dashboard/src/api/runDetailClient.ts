/** Strict run-detail HTTP boundary used by the product client. */

import { decodeRead, RunDetailReadSchema } from "./readResponseSchemas.js";
import type { RunDetail, RunLocation } from "./types.js";

export type RunDetailResult =
  | { kind: "found"; detail: RunDetail }
  | { kind: "not_found" }
  | { kind: "unavailable"; status: number };

export interface RunDetailFetchDeps {
  orchestratorUrl: string;
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
}

function isExactRunNotFound(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 1 &&
    Reflect.get(value, "error") === "run_not_found"
  );
}

export async function fetchRunDetail(
  deps: RunDetailFetchDeps,
  loc: RunLocation,
  runId: string,
  opts: { rawView?: boolean } = {},
): Promise<RunDetailResult> {
  const query = opts.rawView === true ? "?raw=true" : "";
  const response = await deps
    .fetchImpl(
      `${deps.orchestratorUrl}/orgs/${encodeURIComponent(loc.orgId)}/projects/${encodeURIComponent(loc.projectId)}/runs/${encodeURIComponent(runId)}${query}`,
      {
        headers: {
          ...deps.headers,
          ...(opts.rawView === true ? { "x-view-raw": "true" } : {}),
        },
      },
    )
    .catch(() => {});
  if (response === undefined) return { kind: "unavailable", status: 0 };
  const json: unknown = await response.json().catch(() => {});
  if (!response.ok) {
    return response.status === 404 && isExactRunNotFound(json)
      ? { kind: "not_found" }
      : { kind: "unavailable", status: response.status };
  }
  const detail = decodeRead(RunDetailReadSchema, json);
  if (detail === undefined || detail.run.runId !== runId || detail.run.projectId !== loc.projectId) {
    return { kind: "unavailable", status: response.status };
  }
  return { kind: "found", detail };
}
