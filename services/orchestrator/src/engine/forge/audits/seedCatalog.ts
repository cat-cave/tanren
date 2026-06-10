// PROJECT-BOOTSTRAP audit seed (Loop 3 dead-end 1). The audit scheduler loop
// (`loop.ts`) only runs EXISTING `audit_jobs` rows; nothing seeds them, so a
// fresh autonomous project would NEVER run a scheduled audit. This seeds the
// standard scheduled-audit catalog (security / deps / mutation / stale_specs
// with their cadences) at project bootstrap so the audit→finding→fix→merge loop
// has work to pick up from day one.
//
// IDEMPOTENT: a re-provision (or a re-onboard) adds nothing — a catalog entry is
// seeded only when the project has no job of that KIND yet. The cadences mirror
// the forge-recommended coverage set (`recommended.ts`), grounded in
// PROJECT_BRIEF §2.2. Org-scoped under RLS via the caller's client.

import type pg from "pg";
import { AuditsStore } from "./store.js";
import type { AuditCadence, AuditJob, AuditKind } from "./types.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

interface CatalogEntry {
  kind: AuditKind;
  name: string;
  cadence: AuditCadence;
  targetWindow: string;
}

// The standard scheduled-audit catalog every autonomous project bootstraps with.
// Kinds + cadences mirror `recommended.ts` (the forge-recommends panel), so the
// seed and the recommendation surface stay consistent.
export const AUDIT_BOOTSTRAP_CATALOG: ReadonlyArray<CatalogEntry> = [
  { kind: "security", name: "security scan", cadence: "nightly", targetWindow: "night (00–05) · low fill" },
  { kind: "deps", name: "dependency freshness", cadence: "nightly", targetWindow: "night (00–05) · low fill" },
  { kind: "mutation", name: "mutation tests", cadence: "weekly", targetWindow: "self-host gpu (idle)" },
  { kind: "stale_specs", name: "stale-spec sweep", cadence: "monthly", targetWindow: "night (00–05) · low fill" },
];

export interface SeedAuditCatalogInput {
  client: QueryClient;
  orgId: string;
  projectId: string;
}

export interface SeedAuditCatalogResult {
  // The jobs that exist for the project after the seed (the full catalog coverage).
  jobs: AuditJob[];
  // The kinds newly created on THIS call (empty on a re-provision).
  created: AuditKind[];
}

/**
 * Seed the standard scheduled-audit catalog for a project. Reads the org's
 * existing jobs (org-scoped under RLS via the caller's client) and creates ONLY
 * the catalog kinds the project does not already have a job for. Idempotent:
 * re-running adds nothing.
 */
export async function seedAuditCatalog(input: SeedAuditCatalogInput): Promise<SeedAuditCatalogResult> {
  const existing = await AuditsStore.listAuditJobs(input.client, input.orgId);
  const haveKindForProject = new Set(
    existing.filter((job) => job.projectId === input.projectId).map((job) => job.kind),
  );
  const created: AuditKind[] = [];
  const newJobs: AuditJob[] = [];
  for (const entry of AUDIT_BOOTSTRAP_CATALOG) {
    if (haveKindForProject.has(entry.kind)) continue;
    const job = await AuditsStore.createAuditJob(input.client, {
      orgId: input.orgId,
      projectId: input.projectId,
      kind: entry.kind,
      name: entry.name,
      cadence: entry.cadence,
      targetWindow: entry.targetWindow,
      enabled: true,
    });
    newJobs.push(job);
    created.push(entry.kind);
  }
  return {
    jobs: [...existing.filter((job) => job.projectId === input.projectId), ...newJobs],
    created,
  };
}
