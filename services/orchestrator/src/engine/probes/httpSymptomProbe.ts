import type { SymptomProbeDriver, SymptomProbeEvidence, SymptomProbeExecution } from "../contracts/symptomProbe.js";
import type { SymptomContractV1 } from "../contracts/symptomContract.js";
import { canonicalSymptomObservationBytes } from "../contracts/symptomProbe.js";

interface HttpTarget {
  readonly url?: unknown;
  readonly baseUrl?: unknown;
  readonly path?: unknown;
  readonly method?: unknown;
  readonly headers?: unknown;
  readonly body?: unknown;
}

function targetOf(contract: SymptomContractV1): HttpTarget {
  return contract.target as HttpTarget;
}

function targetUrl(target: HttpTarget): string {
  if (typeof target.url === "string" && target.url.length > 0) return target.url;
  if (typeof target.baseUrl === "string" && typeof target.path === "string") {
    return new URL(target.path, target.baseUrl).toString();
  }
  throw new Error("HTTP symptom target requires target.url or target.baseUrl plus target.path");
}

function targetHeaders(target: HttpTarget): Record<string, string> {
  if (target.headers === undefined) return {};
  if (target.headers === null || typeof target.headers !== "object" || Array.isArray(target.headers)) {
    throw new Error("HTTP symptom target headers must be an object");
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(target.headers)) {
    if (typeof value !== "string") throw new Error(`HTTP symptom target header ${key} must be a string`);
    headers[key] = value;
  }
  return headers;
}

function jsonEvidence(observation: Record<string, unknown>): SymptomProbeEvidence {
  return {
    kind: "symptom_observation",
    mediaType: "application/json",
    bytes: canonicalSymptomObservationBytes(observation),
    redactionClass: "none",
  };
}

function unavailableEvidence(): SymptomProbeEvidence {
  return jsonEvidence({ outcome: "inconclusive", reason: "http_probe_unavailable" });
}

export type FetchLike = typeof fetch;

/** A provider-neutral HTTP implementation of the symptom probe driver seam. */
export class HttpSymptomProbe implements SymptomProbeDriver {
  public constructor(private readonly fetchImpl: FetchLike = fetch) {}

  public async execute(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly contract: SymptomContractV1;
    readonly verificationRunId: string;
  }): Promise<SymptomProbeExecution> {
    const startedAt = Date.now();
    const target = targetOf(input.contract);
    try {
      const url = targetUrl(target);
      const method = typeof target.method === "string" && target.method.length > 0 ? target.method : "GET";
      const headers = targetHeaders(target);
      const body = target.body === undefined ? undefined : JSON.stringify(target.body);
      const response = await this.fetchImpl(url, { method, headers, body });
      const text = await response.text();
      let responseBody: unknown = null;
      if (text.length > 0) {
        try {
          responseBody = JSON.parse(text) as unknown;
        } catch {
          responseBody = text;
        }
      }
      const observedObservation = { status: response.status, body: responseBody };
      return {
        observedObservation,
        evidence: [jsonEvidence(observedObservation)],
        timingMs: Math.max(0, Date.now() - startedAt),
      };
    } catch {
      return {
        observedObservation: { outcome: "inconclusive", reason: "http_probe_unavailable" },
        evidence: [unavailableEvidence()],
        timingMs: Math.max(0, Date.now() - startedAt),
        outcome: "inconclusive",
      };
    }
  }
}
