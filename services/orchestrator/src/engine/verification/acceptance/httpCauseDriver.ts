/**
 * Production A3 cause driver. It dispatches a plan-declared HTTP probe against
 * the exact live release URL and adds the correlation the independent provider
 * probe later requires. A cause can never name an arbitrary URL or silently use
 * a different probe: `cause.action` must name exactly one compiled HTTP probe.
 */

import { createHash } from "node:crypto";
import type { AdapterUnavailableResult } from "../../contracts/runtimeVerificationAdapters.js";
import type { HttpProbeSpec } from "./acceptancePlan.js";
import type { AcceptanceBaseUrlResolver, HttpFetch } from "./httpDriver.js";
import type { AcceptanceCauseDriver, CauseDriveInput } from "./causalStage.js";
import type { CauseFiring } from "./causalCorrelation.js";

export interface CauseWatermarkProbe {
  captureWatermark(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly behaviorRevisionId: string;
    readonly deliveryRunId: string;
    readonly observer: string;
    readonly provider: string;
  }): Promise<CauseWatermark>;
}

/** The exact sealed coordinate captured with the provider's pre-trigger cursor. */
export interface CauseWatermark {
  readonly cursor: string;
  readonly bindingId: string;
  readonly bindingGeneration: number;
}

/** Stable coordinate for one A3 cause; safe to repeat after an interrupted request. */
export interface A3CauseCoordinate {
  readonly deliveryRunId: string;
  readonly behaviorRevisionId: string;
  readonly bindingId: string;
  readonly bindingGeneration: number;
  readonly causeOrdinal: number;
}

/** The propagated correlation is durable: retries of one cause reuse this exact digest. */
export function a3CorrelationId(input: A3CauseCoordinate): string {
  return digest(
    `a3-correlation\u0000${input.deliveryRunId}\u0000${input.behaviorRevisionId}\u0000${input.bindingId}\u0000${String(input.bindingGeneration)}\u0000${String(input.causeOrdinal)}`,
  );
}

/** The product-side idempotency key is separately namespaced but equally durable. */
export function a3IdempotencyKey(input: A3CauseCoordinate): string {
  return digest(
    `a3-intent\u0000${input.deliveryRunId}\u0000${input.behaviorRevisionId}\u0000${input.bindingId}\u0000${String(input.bindingGeneration)}\u0000${String(input.causeOrdinal)}`,
  );
}

export interface HttpAcceptanceCauseDriverDependencies {
  readonly resolveBaseUrl: AcceptanceBaseUrlResolver;
  readonly watermarkProbe: CauseWatermarkProbe;
  readonly fetchImpl?: HttpFetch;
}

/** Drives an actual, declared API action and records its pre-effect provider cursor. */
export class HttpAcceptanceCauseDriver implements AcceptanceCauseDriver {
  public readonly surface = "api" as const;
  private readonly fetchImpl: HttpFetch;

  public constructor(private readonly deps: HttpAcceptanceCauseDriverDependencies) {
    this.fetchImpl = deps.fetchImpl ?? defaultFetch;
  }

  public async fireCause(input: CauseDriveInput): Promise<CauseFiring | AdapterUnavailableResult> {
    const probe = exactlyOneProbe(input.httpProbes, input.cause.action);
    if (probe === undefined) return unavailable(`cause '${input.cause.causeId}' does not name exactly one HTTP probe`);
    if (!isNonBlankString(input.deliveryRunId)) {
      return unavailable("live causal trigger has no sealed delivery binding set");
    }
    if (!isNonBlankString(input.cause.action) || !isNonBlankString(probe.method) || !isNonBlankString(probe.path)) {
      return unavailable("live causal trigger has a blank or malformed HTTP action");
    }
    if (!hasValidHeaders(probe.headers)) return unavailable("live causal trigger has malformed HTTP headers");
    const correlation = exactlyOneProviderCorrelation(input);
    if (correlation === undefined) return unavailable("cause has no unambiguous independent provider correlation");

    const resolved = await this.deps.resolveBaseUrl.resolve({
      orgId: input.orgId,
      projectId: input.projectId,
      integrationNodeId: input.integrationNodeId,
      plan: input.plan,
      example: input.plan.examples[0],
      matrixKey: "a3-live-trigger",
      deploymentFingerprint: input.deploymentFingerprint,
    });
    if (resolved.kind === "unresolved") return unavailable(resolved.reason);

    const url = actionUrl(resolved.baseUrl, probe.path);
    if (url === undefined) return unavailable(`probe '${probe.probeId}' escapes the live release origin`);
    if (hasReservedHeader(probe.headers))
      return unavailable(`probe '${probe.probeId}' predefines an A3 correlation header`);

    let watermark: CauseWatermark;
    try {
      watermark = await this.deps.watermarkProbe.captureWatermark({
        orgId: input.orgId,
        projectId: input.projectId,
        behaviorRevisionId: input.behaviorRevisionId,
        deliveryRunId: input.deliveryRunId,
        observer: correlation.observer,
        provider: correlation.provider,
      });
    } catch (error) {
      return unavailable(`independent effect watermark is unavailable: ${reason(error)}`);
    }
    if (
      !isNonBlankString(watermark.cursor) ||
      !isNonBlankString(watermark.bindingId) ||
      !Number.isSafeInteger(watermark.bindingGeneration) ||
      watermark.bindingGeneration < 1
    ) {
      return unavailable("independent effect watermark has an invalid sealed binding coordinate");
    }
    const causeOrdinal = (input.plan.causes ?? []).findIndex((cause) => cause.causeId === input.cause.causeId);
    if (causeOrdinal < 0) return unavailable(`cause '${input.cause.causeId}' is absent from the compiled cause order`);
    const coordinate: A3CauseCoordinate = {
      deliveryRunId: input.deliveryRunId,
      behaviorRevisionId: input.behaviorRevisionId,
      bindingId: watermark.bindingId,
      bindingGeneration: watermark.bindingGeneration,
      causeOrdinal,
    };
    const correlationId = a3CorrelationId(coordinate);
    const idempotencyKey = a3IdempotencyKey(coordinate);
    const headers: Record<string, string> = {
      ...probe.headers,
      "x-tanren-correlation-id": correlationId,
      "idempotency-key": idempotencyKey,
    };
    const body = probe.body === undefined ? undefined : JSON.stringify(probe.body);
    if (body !== undefined && !hasHeader(headers, "content-type")) headers["content-type"] = "application/json";
    try {
      const response = await this.fetchImpl(url, {
        method: probe.method,
        headers,
        ...(body === undefined ? {} : { body }),
      });
      if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
        return unavailable(`live cause '${input.cause.causeId}' was rejected with HTTP ${String(response.status)}`);
      }
    } catch (error) {
      return unavailable(`live cause '${input.cause.causeId}' could not reach the release: ${reason(error)}`);
    }
    return { causeId: input.cause.causeId, correlationId, firedAtCursor: watermark.cursor };
  }
}

function exactlyOneProbe(probes: readonly HttpProbeSpec[], action: string): HttpProbeSpec | undefined {
  const matches = probes.filter((probe) => probe.probeId === action);
  return matches.length === 1 ? matches[0] : undefined;
}

function exactlyOneProviderCorrelation(input: CauseDriveInput): { observer: string; provider: string } | undefined {
  const groups = new Map<string, { observer: string; provider: string }>();
  for (const correlation of input.correlations) {
    if (!isNonBlankString(correlation.observer) || !isNonBlankString(correlation.provider)) return undefined;
    groups.set(`${correlation.observer}\u0000${correlation.provider}`, correlation);
  }
  return groups.size === 1 ? [...groups.values()][0] : undefined;
}

function actionUrl(baseUrl: string, path: string): string | undefined {
  try {
    const base = new URL(baseUrl);
    const action = new URL(path, base);
    return action.origin === base.origin ? action.toString() : undefined;
  } catch {
    return undefined;
  }
}

function hasReservedHeader(headers: Readonly<Record<string, string>> | undefined): boolean {
  return headers === undefined
    ? false
    : Object.keys(headers).some((header) =>
        ["x-tanren-correlation-id", "idempotency-key"].includes(header.toLowerCase()),
      );
}

function hasValidHeaders(headers: Readonly<Record<string, string>> | undefined): boolean {
  return (
    headers === undefined ||
    (typeof headers === "object" &&
      headers !== null &&
      Object.entries(headers).every(([name, value]) => isNonBlankString(name) && typeof value === "string"))
  );
}

function hasHeader(headers: Readonly<Record<string, string>>, name: string): boolean {
  return Object.keys(headers).some((header) => header.toLowerCase() === name);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function unavailable(reasonText: string): AdapterUnavailableResult {
  return { kind: "unavailable", outcome: "inconclusive_external", reason: reasonText };
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function reason(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : "unreadable external failure";
}

const defaultFetch: HttpFetch = async (url, init) => globalThis.fetch(url, init);
