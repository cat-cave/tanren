/**
 * rv-6 A2: the FIRST concrete acceptance surface driver. Given a plan's HTTP
 * probes and the deployed product's base URL, it makes REAL HTTP requests and
 * returns REAL observations — the actual observed status / headers / latency /
 * JSON body values — keyed by the assertion subject grammar `<probeId>.<selector>`.
 *
 * FAIL-CLOSED, NEVER FABRICATE:
 *  - The base URL cannot be resolved (no deploy) ⇒ `unavailable`
 *    (inconclusive_infrastructure). No observation is invented.
 *  - A probe raises a network/DNS/connection error (the product is unreachable)
 *    ⇒ `unavailable` (inconclusive_infrastructure). The surface never contributes
 *    a passing assertion when it could not be exercised.
 *  - A probe returns ANY HTTP response (even 500) ⇒ that response is a REAL
 *    observation; a wrong status/body makes the assertion FAIL (failed_product),
 *    it is never laundered into a pass or into an infra-inconclusive.
 *
 * DOCTRINE (timeout-eradication): a single request is a bounded operation driven
 * to completion; there is NO wall-clock deadline / AbortSignal.timeout / kill
 * timer here. A hung socket is the outer ActivityWatchdog's concern, not a
 * disguised timeout in this driver.
 */

import type { CanonicalBody } from "../../contracts/cas.js";
import { canonicalJson } from "../../contracts/cas.js";
import type {
  AdapterUnavailableResult,
  DriverExecutionResult,
  DriverObservation,
  EvidenceBytePayload,
} from "../../contracts/runtimeVerificationAdapters.js";
import type { RequiredSurface } from "../../contracts/runtimeVerificationPlan.js";
import type { AcceptanceDriveInput, AcceptancePlan, AcceptanceSurfaceDriver, HttpProbeSpec } from "./orchestrator.js";

/** Resolves the deployed product URL an api driver probes for one drive. */
export interface AcceptanceBaseUrlResolver {
  resolve(
    input: AcceptanceDriveInput,
  ): Promise<
    { readonly kind: "resolved"; readonly baseUrl: string } | { readonly kind: "unresolved"; readonly reason: string }
  >;
}

/** A narrow HTTP response shape — the real global `fetch` satisfies it. */
export interface HttpResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** The request-issuing seam; defaults to the platform `fetch`, injectable for tests. */
export type HttpFetch = (
  url: string,
  init: { readonly method: string; readonly headers: Record<string, string>; readonly body?: string },
) => Promise<HttpResponseLike>;

export interface HttpAcceptanceDriverDependencies {
  readonly resolveBaseUrl: AcceptanceBaseUrlResolver;
  /** The surface this driver serves; defaults to "api". */
  readonly surface?: RequiredSurface;
  /** The request seam; defaults to the platform global `fetch`. */
  readonly fetchImpl?: HttpFetch;
  /** Injectable observation clock (tests); defaults to the wall clock. */
  readonly now?: () => string;
}

interface ProbeResponse {
  readonly status: number;
  readonly headerOf: (name: string) => string | null;
  readonly text: string;
  readonly json: CanonicalBody | undefined;
  readonly latencyMs: number;
}

function defaultFetch(): HttpFetch {
  return async (url, init) => {
    const response = await globalThis.fetch(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    return response;
  };
}

function parseJson(text: string): CanonicalBody | undefined {
  try {
    return JSON.parse(text) as CanonicalBody;
  } catch {
    return undefined;
  }
}

/** Split a subject into its probe id and selector; returns undefined when malformed. */
function parseSubject(subject: string): { probeId: string; selector: string } | undefined {
  const dot = subject.indexOf(".");
  if (dot <= 0 || dot === subject.length - 1) return undefined;
  return { probeId: subject.slice(0, dot), selector: subject.slice(dot + 1) };
}

/**
 * Walk a dot-path into a parsed JSON body. Returns `undefined` when the path is
 * UNOBSERVABLE — the body was not JSON, a key/index is genuinely absent, or a
 * non-container blocks descent. `undefined` means "the response did not contain
 * this", so the caller emits NO observation (fail-closed). Only a value the
 * response GENUINELY contains — including a real JSON `null` — is returned.
 */
function extractJsonPath(body: CanonicalBody | undefined, path: string): CanonicalBody | undefined {
  if (body === undefined) return undefined;
  let current: CanonicalBody = body;
  for (const segment of path.split(".")) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index] as CanonicalBody;
      continue;
    }
    if (current !== null && typeof current === "object") {
      const record = current as { readonly [k: string]: CanonicalBody };
      if (!Object.prototype.hasOwnProperty.call(record, segment)) return undefined;
      current = record[segment] as CanonicalBody;
      continue;
    }
    // A scalar / null cannot be descended into — the deeper path is absent.
    return undefined;
  }
  return current;
}

/**
 * Extract the observed value for a selector against a real probe response.
 * Returns `undefined` when the selector is UNOBSERVABLE against this response
 * (unknown selector, absent header, or an absent/non-JSON body path) so the
 * caller emits NO observation — the assertion then does NOT execute and can
 * never be laundered into a pass. It NEVER fabricates a `null` the response did
 * not actually contain; a returned `null` is only a value the response genuinely
 * carried (a present null header-less selector never reaches here).
 */
function observeSelector(response: ProbeResponse, selector: string): CanonicalBody | undefined {
  if (selector === "status") return response.status;
  if (selector === "latencyMs") return response.latencyMs;
  if (selector === "text") return response.text;
  // The whole body: a genuine JSON `null` is observed as null; a non-JSON body
  // is observed as its raw text. Either way the response genuinely carried it.
  if (selector === "body") return response.json === undefined ? response.text : response.json;
  if (selector.startsWith("header.")) {
    const value = response.headerOf(selector.slice("header.".length));
    // An absent header is NOT observed (undefined), never a fabricated null.
    return value === null ? undefined : value;
  }
  if (selector.startsWith("body.")) return extractJsonPath(response.json, selector.slice("body.".length));
  // An unknown selector is unobservable — emit NO observation (never a null match).
  return undefined;
}

function buildUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl).toString();
}

/**
 * rv-9: assemble the drive's REAL response capture as a single deterministic
 * evidence payload — one entry per fired probe, sorted by probe id, carrying the
 * request method/path plus the observed status and raw response body. It EXCLUDES
 * non-deterministic fields (latency, wall clock) so an identical set of responses
 * hashes to one content address (dedupe). Returns `undefined` when no probe was
 * fired, so a probe-less surface contributes no capture. The body may carry
 * product data, so the payload is marked `sensitive`.
 */
function buildResponseCapture(
  probes: readonly HttpProbeSpec[],
  responses: Map<string, ProbeResponse>,
): EvidenceBytePayload | undefined {
  const entries: CanonicalBody[] = [];
  for (const probe of [...probes].sort((a, b) => a.probeId.localeCompare(b.probeId))) {
    const response = responses.get(probe.probeId);
    if (response === undefined) continue;
    entries.push({
      probeId: probe.probeId,
      method: probe.method,
      path: probe.path,
      status: response.status,
      body: response.text,
    });
  }
  if (entries.length === 0) return undefined;
  const bytes = new TextEncoder().encode(canonicalJson({ probes: entries }));
  return { kind: "network", mediaType: "application/json", bytes, redactionClass: "sensitive" };
}

export class HttpAcceptanceSurfaceDriver implements AcceptanceSurfaceDriver {
  public readonly surface: RequiredSurface;
  private readonly resolveBaseUrl: AcceptanceBaseUrlResolver;
  private readonly fetchImpl: HttpFetch;
  private readonly now: () => string;

  public constructor(dependencies: HttpAcceptanceDriverDependencies) {
    this.surface = dependencies.surface ?? "api";
    this.resolveBaseUrl = dependencies.resolveBaseUrl;
    this.fetchImpl = dependencies.fetchImpl ?? defaultFetch();
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async drive(input: AcceptanceDriveInput): Promise<DriverExecutionResult | AdapterUnavailableResult> {
    const resolved = await this.resolveBaseUrl.resolve(input);
    if (resolved.kind === "unresolved") {
      return { kind: "unavailable", outcome: "inconclusive_infrastructure", reason: resolved.reason };
    }
    const probes = input.plan.httpProbes ?? [];
    const responses = new Map<string, ProbeResponse>();
    for (const probe of probes) {
      const response = await this.fireProbe(resolved.baseUrl, probe);
      if (response.kind === "unreachable") {
        return { kind: "unavailable", outcome: "inconclusive_infrastructure", reason: response.reason };
      }
      responses.set(probe.probeId, response.response);
    }
    const capture = buildResponseCapture(probes, responses);
    return {
      kind: "executed",
      observations: this.observe(input.plan, responses),
      providerChecksums: [],
      ...(capture === undefined ? {} : { capture: [capture] }),
    };
  }

  private async fireProbe(
    baseUrl: string,
    probe: HttpProbeSpec,
  ): Promise<{ kind: "ok"; response: ProbeResponse } | { kind: "unreachable"; reason: string }> {
    const headers: Record<string, string> = { ...probe.headers };
    let bodyText: string | undefined;
    if (probe.body !== undefined) {
      bodyText = JSON.stringify(probe.body);
      if (headers["content-type"] === undefined && headers["Content-Type"] === undefined) {
        headers["content-type"] = "application/json";
      }
    }
    const started = Date.now();
    let raw: HttpResponseLike;
    try {
      raw = await this.fetchImpl(buildUrl(baseUrl, probe.path), {
        method: probe.method,
        headers,
        ...(bodyText === undefined ? {} : { body: bodyText }),
      });
    } catch (error) {
      // A network/DNS/connection failure: the product is unreachable. Fail closed
      // to inconclusive_infrastructure — NEVER a fabricated observation.
      return { kind: "unreachable", reason: `probe ${probe.probeId}: ${(error as Error).message}` };
    }
    const text = await raw.text();
    return {
      kind: "ok",
      response: {
        status: raw.status,
        headerOf: (name) => raw.headers.get(name),
        text,
        json: parseJson(text),
        latencyMs: Date.now() - started,
      },
    };
  }

  private observe(plan: AcceptancePlan, responses: Map<string, ProbeResponse>): readonly DriverObservation[] {
    const observedAt = this.now();
    const observations: DriverObservation[] = [];
    for (const assertion of plan.assertions) {
      // Causal (rv-12) assertions are observed by the causal stage, not this driver.
      if (assertion.correlation !== undefined) continue;
      const parsed = parseSubject(assertion.subject);
      if (parsed === undefined) continue;
      const response = responses.get(parsed.probeId);
      if (response === undefined) continue;
      const value = observeSelector(response, parsed.selector);
      // Unobservable (unknown selector / absent header / absent-or-non-JSON body
      // path) ⇒ NO observation ⇒ the assertion does not execute (fail-closed).
      if (value === undefined) continue;
      observations.push({ observationKind: "http", subject: assertion.subject, value, observedAt });
    }
    return observations;
  }
}
