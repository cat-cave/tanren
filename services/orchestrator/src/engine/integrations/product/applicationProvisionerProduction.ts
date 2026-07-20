// in-12: PRODUCTION wiring for the product-plane ApplicationIntegrationProvisioner.
// This is the single prod seam the capability/delivery path selects a REAL product
// provisioner from — mirroring `productionProvisionerDeps` for the control plane.
// It resolves the concrete `RelayMessagingProvisioner` (over a fetch-backed relay
// transport) from the registry; the in-memory fake lives ONLY under tests/ and is
// never reachable here. FAIL-CLOSED: a missing relay endpoint throws at
// construction, and an unregistered kind resolves to the hard-throw
// `UnconfiguredApplicationIntegrationProvisioner`.

import type { SecretStore } from "../../contracts/secretStore.js";
import {
  buildApplicationIntegrationProvisioner,
  ProductProvisionFailedError,
  type ApplicationIntegrationProvisioner,
  type ApplicationIntegrationProvisionerDeps,
} from "../../contracts/applicationIntegrationProvisioner.js";
import type { ProductRelayTransport, RegisterRelayBindingRequest, RelayBinding } from "./relayMessagingProvisioner.js";

/** The env var naming Tanren's managed product-relay base URL. */
export const PRODUCT_RELAY_URL_ENV = "TANREN_PRODUCT_RELAY_URL";

interface RawRelayBinding {
  bindingId?: unknown;
  channelId?: unknown;
  channelName?: unknown;
  stableKey?: unknown;
  workloadGeneration?: unknown;
  receiptId?: unknown;
  created?: unknown;
}

// (no lenient `asString` coercion — confirmation fields are required non-empty.)

/** Sentinel a read returns for a CONFIRMED 404 absence (distinct from 2xx-empty). */
const RELAY_ABSENT = Symbol("relay_absent");

/**
 * Extract a REQUIRED NON-BLANK confirmation string, fail-closed. A missing, empty,
 * or WHITESPACE-ONLY field means the relay did not confirm the external effect —
 * the mutation must NOT fabricate a success artifact with a coerced/blank `""`.
 */
function requiredField(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProductProvisionFailedError(
      "provision",
      `incomplete_relay_evidence: relay response is missing or blank required confirmation field '${key}'`,
    );
  }
  return value;
}

/**
 * Parse a relay binding as CONFIRMED evidence — every field that proves the
 * external effect (bindingId, channelId, channelName, receiptId) MUST be present +
 * non-empty, `created` MUST be an explicit boolean ownership signal, and
 * `workloadGeneration` MUST be a positive integer. No coercion of an absent field
 * to `""`/`false`/`1`: an incomplete relay response is a fail-closed error, never a
 * fabricated success.
 */
function parseRelayBinding(body: unknown): RelayBinding {
  if (body === null || typeof body !== "object") {
    throw new ProductProvisionFailedError("provision", "incomplete_relay_evidence: relay returned no binding object");
  }
  const raw = body as RawRelayBinding;
  if (typeof raw.created !== "boolean") {
    throw new ProductProvisionFailedError(
      "provision",
      "incomplete_relay_evidence: relay response has no explicit 'created' ownership signal",
    );
  }
  if (
    typeof raw.workloadGeneration !== "number" ||
    !Number.isInteger(raw.workloadGeneration) ||
    raw.workloadGeneration < 1
  ) {
    throw new ProductProvisionFailedError(
      "provision",
      "incomplete_relay_evidence: relay response has no valid 'workloadGeneration'",
    );
  }
  return {
    bindingId: requiredField(raw.bindingId, "bindingId"),
    channelId: requiredField(raw.channelId, "channelId"),
    channelName: requiredField(raw.channelName, "channelName"),
    stableKey: requiredField(raw.stableKey, "stableKey"),
    workloadGeneration: raw.workloadGeneration,
    receiptId: requiredField(raw.receiptId, "receiptId"),
    created: raw.created,
  };
}

/**
 * The production managed-relay transport: a thin fetch wrapper over Tanren's
 * relay service. The relay owns the provider token; this client sends only the
 * resolved relay CONTROL token as a Bearer header. Injectable `fetchImpl` keeps it
 * testable, though the provisioner's own tests drive a scripted fake directly.
 */
export class FetchProductRelayTransport implements ProductRelayTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/u, "")}${path}`;
  }

  /**
   * Send a relay request. `absentOn404` returns the {@link RELAY_ABSENT} sentinel
   * for a CONFIRMED 404 ONLY (never a 2xx-empty body) so a caller can distinguish a
   * real "gone" from a malformed 2xx. Every other non-2xx — and a 404 on a
   * write/delete — throws, so a mutation can never read an unconfirmed response as
   * success.
   */
  private async send(
    token: string,
    method: string,
    path: string,
    opts: { body?: unknown; absentOn404?: boolean } = {},
  ): Promise<unknown> {
    const response = await this.fetchImpl(this.url(path), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    if (opts.absentOn404 === true && response.status === 404) {
      return RELAY_ABSENT;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`relay ${method} ${path} failed: HTTP ${response.status}`);
    }
    const text = await response.text();
    return text === "" ? undefined : JSON.parse(text);
  }

  async registerBinding(token: string, req: RegisterRelayBindingRequest): Promise<RelayBinding> {
    return parseRelayBinding(await this.send(token, "POST", "/v1/bindings", { body: req }));
  }

  async getBinding(token: string, orgId: string, stableKey: string): Promise<RelayBinding | undefined> {
    const query = `?orgId=${encodeURIComponent(orgId)}&stableKey=${encodeURIComponent(stableKey)}`;
    const body = await this.send(token, "GET", `/v1/bindings${query}`, { absentOn404: true });
    // Absence is a CONFIRMED 404 only. A 2xx with an empty/unparseable body is a
    // malformed response, NOT "gone" — fail-closed so teardown's no-op path (and any
    // "already exists?" check) never fires on an ambiguous 2xx-empty.
    if (body === RELAY_ABSENT) {
      return undefined;
    }
    if (body === undefined) {
      throw new Error(`malformed_relay_binding: relay returned a 2xx empty body for getBinding '${stableKey}'`);
    }
    return parseRelayBinding(body);
  }

  async listBindings(token: string, orgId: string): Promise<readonly RelayBinding[]> {
    const body = await this.send(token, "GET", `/v1/bindings?orgId=${encodeURIComponent(orgId)}`);
    if (!Array.isArray(body)) {
      // A wrong-shape inventory must NOT silently degrade to an empty list — a
      // caller would read "no resources" and (e.g.) create a duplicate.
      throw new TypeError(
        `malformed_relay_inventory: relay list returned a ${body === undefined ? "empty" : "non-array"} body`,
      );
    }
    return body.map((entry) => parseRelayBinding(entry));
  }

  async rotateWorkloadCredential(token: string, _orgId: string, bindingId: string): Promise<RelayBinding> {
    return parseRelayBinding(await this.send(token, "POST", `/v1/bindings/${encodeURIComponent(bindingId)}/rotate`));
  }

  async revokeBinding(token: string, _orgId: string, bindingId: string): Promise<void> {
    // No `absentOn404`: a DELETE of a KNOWN binding that returns 404 (or any
    // non-2xx) is NOT a confirmed deletion — `send` throws, and the provisioner's
    // teardown surfaces it as `teardown_unconfirmed`.
    await this.send(token, "DELETE", `/v1/bindings/${encodeURIComponent(bindingId)}`);
  }
}

/** Resolve the configured relay base URL, fail-closed when unset. */
function resolveRelayBaseUrl(): string {
  const url = process.env[PRODUCT_RELAY_URL_ENV];
  if (url === undefined || url.trim() === "") {
    throw new ProductProvisionFailedError(
      "provision",
      `product relay is not configured — set ${PRODUCT_RELAY_URL_ENV} to Tanren's managed relay base URL`,
    );
  }
  return url;
}

/**
 * Build the PRODUCTION `ApplicationIntegrationProvisionerDeps`: the fetch-backed
 * relay transport + the configured SecretStore (the SAME store the rest of the app
 * uses, so refs the provisioner resolves are visible to the runtime). The single
 * prod wiring point — a new product provider extends the deps here.
 */
export function productionApplicationProvisionerDeps(secrets: SecretStore): ApplicationIntegrationProvisionerDeps {
  return { relay: new FetchProductRelayTransport(resolveRelayBaseUrl()), secrets };
}

/**
 * Select + construct the REAL product provisioner for a kind from the registry,
 * wired with production deps. This is what the capability/delivery path calls —
 * it returns the concrete impl (never the tests-only fake). An unregistered kind
 * resolves to the hard-throw `UnconfiguredApplicationIntegrationProvisioner`.
 */
export function resolveProductionApplicationProvisioner(
  kind: string,
  secrets: SecretStore,
): ApplicationIntegrationProvisioner {
  return buildApplicationIntegrationProvisioner(kind, productionApplicationProvisionerDeps(secrets));
}
