/**
 * org-config response types the tanren-config audit-gate surface reads.
 * Split out of `types.ts` to keep that file under the 500-line architecture cap
 * (re-exported from `types.ts` for back-compat). Mirrors the orchestrator's
 * `OrgConfigV1` shape the gate surface renders — local + minimal, like the rest.
 */

import type { EscapeHatches, RoutingTable } from "./types.js";

/** The tanren-config audit-gate target stored in org config JSONB. */
export interface OrgAuditGateTarget {
  repo: string;
  baseBranch: string;
  branchPrefix: string;
  configFile: string;
}

/** Org config the gate surface reads (`GET /orgs/:orgId` → `config`). */
export interface OrgConfig {
  version: 1;
  routing: RoutingTable;
  escapeHatches: EscapeHatches;
  /** gate toggle: when true, Bucket-B writes route through a PR. */
  auditGateEnabled?: boolean;
  auditGate?: OrgAuditGateTarget;
  [key: string]: unknown;
}

/** An org with its merged config (`GET /orgs/:orgId`). */
export interface OrgDetail {
  id: string;
  login: string;
  displayName: string | null;
  config: OrgConfig;
}
