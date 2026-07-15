/**
 * Fail-closed run-location resolution for the dashboard's bare `/runs/:runId`
 * route. Probes `GET /orgs/:orgId/runs/:runId/location` once per visible org —
 * never project or run-list fan-out. Only a definitive documented 404 body is a
 * miss; network, auth, upstream, malformed, and multi-match outcomes never
 * collapse to not-found.
 */

/** Org+project routing coordinates for a visible run. */
export interface RunLocation {
  orgId: string;
  projectId: string;
}

/**
 * Result of resolving a run across the operator's visible orgs.
 * `not_found` is reserved for every probe returning the exact documented 404 body.
 */
export type FindRunLocationResult =
  | { kind: "found"; location: RunLocation }
  | { kind: "not_found" }
  | { kind: "auth"; status: 401 | 403 }
  | {
      kind: "unavailable";
      reason: "network" | "malformed" | "upstream" | "ambiguous" | "orgs";
    };

export interface RunLocationProbeDeps {
  orchestratorUrl: string;
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
}

/** Exact body the orchestrator returns for a definitive location miss. */
export const RUN_LOCATION_NOT_FOUND_BODY = { error: "run_not_found" } as const;

/**
 * Strictly decode a successful RunLocation. Rejects unknown/extra keys, empty
 * strings, and any shape that is not exactly `{ orgId, projectId }`.
 */
export function decodeRunLocation(body: unknown): RunLocation | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length !== 2 || !keys.includes("orgId") || !keys.includes("projectId")) {
    return undefined;
  }
  const record = body as { orgId: unknown; projectId: unknown };
  if (typeof record.orgId !== "string" || record.orgId.length === 0) {
    return undefined;
  }
  if (typeof record.projectId !== "string" || record.projectId.length === 0) {
    return undefined;
  }
  return { orgId: record.orgId, projectId: record.projectId };
}

/** True when the 404 body is exactly the documented not-found shape. */
export function isDefinitiveRunLocationNotFound(body: unknown): boolean {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return false;
  }
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "error") {
    return false;
  }
  return (body as { error: unknown }).error === RUN_LOCATION_NOT_FOUND_BODY.error;
}

type OrgIdListResult =
  | { kind: "ok"; orgIds: string[] }
  | { kind: "auth"; status: 401 | 403 }
  | { kind: "unavailable"; reason: "network" | "malformed" | "upstream" | "orgs" };

type SingleProbe =
  | { kind: "match"; location: RunLocation }
  | { kind: "miss" }
  | { kind: "auth"; status: 401 | 403 }
  | { kind: "unavailable"; reason: "network" | "malformed" | "upstream" };

/**
 * Production path: list visible orgs (fail-closed), probe each location endpoint,
 * require exactly one definitive match, and never treat uncertainty as not-found.
 */
export async function findRunLocation(deps: RunLocationProbeDeps, runId: string): Promise<FindRunLocationResult> {
  const orgs = await listVisibleOrgIds(deps);
  if (orgs.kind === "auth") {
    return { kind: "auth", status: orgs.status };
  }
  if (orgs.kind === "unavailable") {
    return { kind: "unavailable", reason: orgs.reason };
  }
  if (orgs.orgIds.length === 0) {
    return { kind: "not_found" };
  }

  const matches: RunLocation[] = [];
  let sawUncertain = false;
  let authStatus: 401 | 403 | undefined;

  for (const orgId of orgs.orgIds) {
    const probe = await probeOrgLocation(deps, orgId, runId);
    if (probe.kind === "match") {
      matches.push(probe.location);
      continue;
    }
    if (probe.kind === "miss") {
      continue;
    }
    sawUncertain = true;
    if (probe.kind === "auth") {
      authStatus = probe.status;
    }
  }

  if (matches.length > 1) {
    return { kind: "unavailable", reason: "ambiguous" };
  }
  if (matches.length === 1) {
    // A definitive unique match still requires every other probe to be a
    // definitive miss; uncertainty blocks uniqueness claims.
    if (sawUncertain) {
      return { kind: "unavailable", reason: "ambiguous" };
    }
    return { kind: "found", location: matches[0]! };
  }
  if (sawUncertain) {
    if (authStatus !== undefined) {
      return { kind: "auth", status: authStatus };
    }
    return { kind: "unavailable", reason: "upstream" };
  }
  return { kind: "not_found" };
}

async function listVisibleOrgIds(deps: RunLocationProbeDeps): Promise<OrgIdListResult> {
  let response: Response;
  try {
    response = await deps.fetchImpl(`${deps.orchestratorUrl}/orgs`, {
      headers: deps.headers,
    });
  } catch {
    return { kind: "unavailable", reason: "network" };
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: "auth", status: response.status };
  }
  if (response.status >= 500) {
    return { kind: "unavailable", reason: "upstream" };
  }
  if (!response.ok) {
    return { kind: "unavailable", reason: "orgs" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "unavailable", reason: "malformed" };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { kind: "unavailable", reason: "malformed" };
  }
  const orgs = (body as { orgs?: unknown }).orgs;
  if (!Array.isArray(orgs)) {
    return { kind: "unavailable", reason: "malformed" };
  }
  const orgIds: string[] = [];
  for (const org of orgs) {
    if (org === null || typeof org !== "object" || Array.isArray(org)) {
      return { kind: "unavailable", reason: "malformed" };
    }
    const id = (org as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) {
      return { kind: "unavailable", reason: "malformed" };
    }
    orgIds.push(id);
  }
  return { kind: "ok", orgIds };
}

async function probeOrgLocation(deps: RunLocationProbeDeps, orgId: string, runId: string): Promise<SingleProbe> {
  const url = `${deps.orchestratorUrl}/orgs/${encodeURIComponent(orgId)}/runs/${encodeURIComponent(runId)}/location`;
  let response: Response;
  try {
    response = await deps.fetchImpl(url, { headers: deps.headers });
  } catch {
    return { kind: "unavailable", reason: "network" };
  }

  if (response.status === 404) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: "unavailable", reason: "malformed" };
    }
    if (isDefinitiveRunLocationNotFound(body)) {
      return { kind: "miss" };
    }
    return { kind: "unavailable", reason: "malformed" };
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: "auth", status: response.status };
  }
  if (response.status >= 500) {
    return { kind: "unavailable", reason: "upstream" };
  }
  if (response.status !== 200) {
    // Unexpected 2xx (201/204/…) or other non-404 statuses are uncertain.
    return { kind: "unavailable", reason: response.ok ? "malformed" : "upstream" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "unavailable", reason: "malformed" };
  }
  const location = decodeRunLocation(body);
  if (location === undefined) {
    return { kind: "unavailable", reason: "malformed" };
  }
  // Bind the result to the probed organization; reject wrong-domain data.
  if (location.orgId !== orgId) {
    return { kind: "unavailable", reason: "malformed" };
  }
  return { kind: "match", location };
}
