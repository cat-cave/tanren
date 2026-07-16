/**
 * in-2: dashboard client for integration-contract validate + catalog.
 * `POST /orgs/:orgId/integration-contracts:validate`
 * `GET  /orgs/:orgId/integration-contracts/catalog`
 */

export interface IntegrationContractIssue {
  path: string;
  code: string;
  message: string;
}

export interface IntegrationContractCatalog {
  missionNodeId: "in-2";
  version: 1;
  planes: string[];
  directions: string[];
  environments: string[];
  criticalities: string[];
  controlCapabilities: string[];
  productCapabilities: string[];
  controlBindingKinds: string[];
  productBindingKinds: string[];
  allBindingKinds: string[];
  domainTag: string;
  mediaType: string;
}

export interface IntegrationValidateOk {
  ok: true;
  missionNodeId: "in-2";
  orgId: string;
  /** R3: honest checked-vs-persisted state. false = validated only, no CAS write. */
  persisted: boolean;
  requirementDigest: string;
  artifact: {
    digest: string;
    byteSize: number;
    mediaType: string;
  };
  capability: string;
  plane: string;
  direction: string;
  criticality: string;
}

export interface IntegrationValidateFail {
  ok: false;
  missionNodeId: "in-2";
  errors: IntegrationContractIssue[];
}

export type FetchCatalogResult =
  | { kind: "ok"; catalog: IntegrationContractCatalog }
  | { kind: "auth"; status: 401 | 403 }
  | { kind: "unavailable"; reason: "network" | "malformed" | "upstream" };

export type FetchValidateResult =
  | { kind: "ok"; body: IntegrationValidateOk }
  | { kind: "invalid"; body: IntegrationValidateFail }
  | { kind: "auth"; status: 401 | 403 }
  | { kind: "unavailable"; reason: "network" | "malformed" | "upstream" | "bad_request" };

export interface IntegrationContractsFetchDeps {
  orchestratorUrl: string;
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((v) => typeof v === "string")) return undefined;
  return value;
}

export function decodeIntegrationCatalog(body: unknown): IntegrationContractCatalog | undefined {
  if (!isRecord(body)) return undefined;
  if (body["missionNodeId"] !== "in-2") return undefined;
  if (body["version"] !== 1) return undefined;
  const planes = asStringArray(body["planes"]);
  const directions = asStringArray(body["directions"]);
  const environments = asStringArray(body["environments"]);
  const criticalities = asStringArray(body["criticalities"]);
  const controlCapabilities = asStringArray(body["controlCapabilities"]);
  const productCapabilities = asStringArray(body["productCapabilities"]);
  const controlBindingKinds = asStringArray(body["controlBindingKinds"]);
  const productBindingKinds = asStringArray(body["productBindingKinds"]);
  const allBindingKinds = asStringArray(body["allBindingKinds"]);
  const domainTag = asNonEmptyString(body["domainTag"]);
  const mediaType = asNonEmptyString(body["mediaType"]);
  if (
    planes === undefined ||
    directions === undefined ||
    environments === undefined ||
    criticalities === undefined ||
    controlCapabilities === undefined ||
    productCapabilities === undefined ||
    controlBindingKinds === undefined ||
    productBindingKinds === undefined ||
    allBindingKinds === undefined ||
    domainTag === undefined ||
    mediaType === undefined
  ) {
    return undefined;
  }
  return {
    missionNodeId: "in-2",
    version: 1,
    planes,
    directions,
    environments,
    criticalities,
    controlCapabilities,
    productCapabilities,
    controlBindingKinds,
    productBindingKinds,
    allBindingKinds,
    domainTag,
    mediaType,
  };
}

export function decodeValidateOk(body: unknown): IntegrationValidateOk | undefined {
  if (!isRecord(body)) return undefined;
  if (body["ok"] !== true) return undefined;
  if (body["missionNodeId"] !== "in-2") return undefined;
  const orgId = asNonEmptyString(body["orgId"]);
  const requirementDigest = asNonEmptyString(body["requirementDigest"]);
  const capability = asNonEmptyString(body["capability"]);
  const plane = asNonEmptyString(body["plane"]);
  const direction = asNonEmptyString(body["direction"]);
  const criticality = asNonEmptyString(body["criticality"]);
  const persisted = body["persisted"];
  const artifactRaw = body["artifact"];
  if (!isRecord(artifactRaw)) return undefined;
  const artifactDigest = asNonEmptyString(artifactRaw["digest"]);
  const mediaType = asNonEmptyString(artifactRaw["mediaType"]);
  const byteSize = artifactRaw["byteSize"];
  if (
    orgId === undefined ||
    requirementDigest === undefined ||
    capability === undefined ||
    plane === undefined ||
    direction === undefined ||
    criticality === undefined ||
    typeof persisted !== "boolean" ||
    artifactDigest === undefined ||
    mediaType === undefined ||
    typeof byteSize !== "number"
  ) {
    return undefined;
  }
  return {
    ok: true,
    missionNodeId: "in-2",
    orgId,
    persisted,
    requirementDigest,
    artifact: { digest: artifactDigest, byteSize, mediaType },
    capability,
    plane,
    direction,
    criticality,
  };
}

export function decodeValidateFail(body: unknown): IntegrationValidateFail | undefined {
  if (!isRecord(body)) return undefined;
  if (body["ok"] !== false) return undefined;
  if (body["missionNodeId"] !== "in-2") return undefined;
  const errorsRaw = body["errors"];
  if (!Array.isArray(errorsRaw)) return undefined;
  const errors: IntegrationContractIssue[] = [];
  for (const e of errorsRaw) {
    if (!isRecord(e)) return undefined;
    const path = asNonEmptyString(e["path"]);
    const code = asNonEmptyString(e["code"]);
    const message = asNonEmptyString(e["message"]);
    if (path === undefined || code === undefined || message === undefined) return undefined;
    errors.push({ path, code, message });
  }
  return { ok: false, missionNodeId: "in-2", errors };
}

export async function fetchIntegrationCatalog(
  deps: IntegrationContractsFetchDeps,
  orgId: string,
): Promise<FetchCatalogResult> {
  const url = `${deps.orchestratorUrl}/orgs/${encodeURIComponent(orgId)}/integration-contracts/catalog`;
  let res: Response;
  try {
    res = await deps.fetchImpl(url, { headers: deps.headers });
  } catch {
    return { kind: "unavailable", reason: "network" };
  }
  if (res.status === 401 || res.status === 403) {
    return { kind: "auth", status: res.status };
  }
  if (!res.ok) {
    return { kind: "unavailable", reason: "upstream" };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: "unavailable", reason: "malformed" };
  }
  const catalog = decodeIntegrationCatalog(body);
  if (catalog === undefined) {
    return { kind: "unavailable", reason: "malformed" };
  }
  return { kind: "ok", catalog };
}

export async function validateIntegrationRequirement(
  deps: IntegrationContractsFetchDeps,
  orgId: string,
  requirement: unknown,
  options?: { readonly persist?: boolean },
): Promise<FetchValidateResult> {
  const url = `${deps.orchestratorUrl}/orgs/${encodeURIComponent(orgId)}/integration-contracts:validate`;
  const persist = options?.persist ?? true;
  let res: Response;
  try {
    res = await deps.fetchImpl(url, {
      method: "POST",
      headers: { ...deps.headers, "content-type": "application/json" },
      body: JSON.stringify({ requirement, persist }),
    });
  } catch {
    return { kind: "unavailable", reason: "network" };
  }
  if (res.status === 401 || res.status === 403) {
    return { kind: "auth", status: res.status };
  }
  if (res.status === 400) {
    return { kind: "unavailable", reason: "bad_request" };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: "unavailable", reason: "malformed" };
  }
  if (res.status === 422) {
    const fail = decodeValidateFail(body);
    if (fail === undefined) return { kind: "unavailable", reason: "malformed" };
    return { kind: "invalid", body: fail };
  }
  if (!res.ok) {
    return { kind: "unavailable", reason: "upstream" };
  }
  const ok = decodeValidateOk(body);
  if (ok === undefined) {
    return { kind: "unavailable", reason: "malformed" };
  }
  return { kind: "ok", body: ok };
}
