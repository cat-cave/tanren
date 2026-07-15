/**
 * Org integrations two-plane response types. Kept in their own module (not the
 * shared `types.ts` / `orchestrator.ts`) so the surface owns its contract and
 * the product client stays under the 500-line cap. Mirrors the orchestrator
 * routes under `routes/integrations/index.ts`.
 *
 * Plane A — org grants (`GET/POST /orgs/:orgId/integrations…`): link a provider
 * once. Credential REF names + metadata KEYS only — never secret values.
 *
 * Plane B — project capability enable (`POST …/provision`, `GET …/discover`):
 * enable sentry/slack/deploy for a project from the org grant. `not_linked` is
 * a structured **200** (branch on `body.status`), never a crash.
 */

/** A single org grant as returned by `GET /orgs/:orgId/integrations`. */
export interface OrgIntegrationSummary {
  connectionId: string;
  grantId: string;
  orgId: string;
  providerKind: string;
  upstreamAccountId: string;
  authKind: string;
  authGeneration: number;
  ownerId: string;
  /** Keys present in the grant metadata; values are never echoed. */
  metadataKeys: string[];
  capabilities: string[];
  operations: string[];
  providerScopes: string[];
  health: string;
  connectionStatus: string;
  grantGeneration: number;
  grantStatus: string;
}

export interface IntegrationLifecycleInventory {
  projectId: string;
  requirements: { total: number; needsAttention: number };
  capabilityNodes: { total: number; awaitingGrant: number; ready: number; needsAttention: number };
  bindings: { total: number; ready: number; drifted: number; needsAttention: number };
  deliveries: { total: number; completed: number; degraded: number; needsAttention: number };
}

/** `GET /orgs/:orgId/integrations` envelope. */
export interface OrgIntegrationsList {
  integrations: OrgIntegrationSummary[];
  lifecycle?: IntegrationLifecycleInventory;
}

/**
 * Structured outcomes of provision / discover. Callers MUST branch on
 * `status` — `not_linked` is a successful 200, not an error.
 */
export interface NotLinkedOutcome {
  status: "not_linked";
  capability?: string;
  providerKind: string;
  message?: string;
  linkAffordance?: {
    kind: string;
    providerKind: string;
    orgId: string;
  };
}

export interface LinkedProvisionOutcome {
  status: string;
  capability?: string;
  providerKind?: string;
  /** Opaque refs / surface ids — never secret material. */
  [key: string]: unknown;
}

export type ProvisionOutcome = NotLinkedOutcome | LinkedProvisionOutcome;

export interface DiscoverOutcome {
  status: string;
  capability?: string;
  providerKind?: string;
  resources?: unknown[];
  message?: string;
  linkAffordance?: {
    kind: string;
    providerKind: string;
    orgId: string;
  };
}

/** Result of POST link — refs only. */
export interface LinkOutcome {
  status: string;
  providerKind: string;
  connectionId: string;
  grantId: string;
  authGeneration: number;
  grantGeneration: number;
  capabilities: string[];
  metadataKeys: string[];
}

/**
 * Provider kinds the two-plane UI can link at org level.
 * Hetzner is the allocator plane — NOT this surface.
 */
export const LINKABLE_PROVIDER_KINDS = ["sentry", "slack", "deploy.vercel", "deploy.flyio"] as const;

/**
 * Capabilities the project-enable plane exposes. Deploy requires an explicit
 * `deploy.vercel` / `deploy.flyio` providerKind (no single default).
 */
export const PROJECT_CAPABILITIES = [
  { capability: "errors", label: "error tracking", providerKind: "sentry", glyph: "×" },
  { capability: "notify", label: "slack notify", providerKind: "slack", glyph: "✉" },
  {
    capability: "deploy",
    label: "deploy · vercel",
    providerKind: "deploy.vercel",
    glyph: "↗",
  },
  {
    capability: "deploy",
    label: "deploy · fly.io",
    providerKind: "deploy.flyio",
    glyph: "↗",
  },
] as const;
