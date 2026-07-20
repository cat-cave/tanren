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

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseRelayBinding(body: unknown): RelayBinding {
  const raw = (body ?? {}) as RawRelayBinding;
  const bindingId = asString(raw.bindingId);
  if (bindingId === "") {
    throw new ProductProvisionFailedError("provision", "relay response is missing a bindingId");
  }
  return {
    bindingId,
    channelId: asString(raw.channelId),
    channelName: asString(raw.channelName),
    stableKey: asString(raw.stableKey),
    workloadGeneration: typeof raw.workloadGeneration === "number" ? raw.workloadGeneration : 1,
    receiptId: asString(raw.receiptId),
    created: raw.created === true,
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

  private async send(token: string, method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetchImpl(this.url(path), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 404) {
      return undefined;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`relay ${method} ${path} failed: HTTP ${response.status}`);
    }
    const text = await response.text();
    return text === "" ? undefined : JSON.parse(text);
  }

  async registerBinding(token: string, req: RegisterRelayBindingRequest): Promise<RelayBinding> {
    return parseRelayBinding(await this.send(token, "POST", "/v1/bindings", req));
  }

  async getBinding(token: string, orgId: string, stableKey: string): Promise<RelayBinding | undefined> {
    const query = `?orgId=${encodeURIComponent(orgId)}&stableKey=${encodeURIComponent(stableKey)}`;
    const body = await this.send(token, "GET", `/v1/bindings${query}`);
    return body === undefined ? undefined : parseRelayBinding(body);
  }

  async listBindings(token: string, orgId: string): Promise<readonly RelayBinding[]> {
    const body = await this.send(token, "GET", `/v1/bindings?orgId=${encodeURIComponent(orgId)}`);
    return Array.isArray(body) ? body.map((entry) => parseRelayBinding(entry)) : [];
  }

  async rotateWorkloadCredential(token: string, _orgId: string, bindingId: string): Promise<RelayBinding> {
    return parseRelayBinding(await this.send(token, "POST", `/v1/bindings/${encodeURIComponent(bindingId)}/rotate`));
  }

  async revokeBinding(token: string, _orgId: string, bindingId: string): Promise<void> {
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
