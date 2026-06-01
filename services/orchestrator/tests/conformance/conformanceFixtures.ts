// Shared fixtures + harness contract for the `Repositories` seam conformance
// suites (repositoriesConformance.ts + runReadConformance.ts). Lives in its own
// module so both suite halves import the seed shapes, harness interface, and
// canonical org/project/spec/run fixtures without forming an import cycle.

import type { ActorContext } from "../../src/auth/schemas.js";
import type { QueryClient, Repositories } from "../../src/engine/contracts/repositories.js";

export interface SeedProject {
  projectId: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  runnerImage: string;
  allocator: string;
  config: unknown;
  orgId: string | null;
}

export interface SeedSpec {
  specId: string;
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  status: string;
  orgId: string | null;
}

export interface SeedPersona {
  id: string;
  scope: "org" | "project";
  orgId: string;
  projectId: string | null;
  name: string;
  description: string;
}

export interface SeedBehavior {
  id: string;
  personaId: string;
  title: string;
  given: string;
  when: string;
  then: string;
  description: string | null;
}

export interface SeedMilestone {
  id: string;
  projectId: string;
  label: string;
  name: string;
  orderIndex: number;
  status: "planned" | "in_flight" | "done" | "abandoned";
  orgId: string | null;
}

export interface SeedSpecDependency {
  fromSpecId: string;
  toSpecId: string;
}

export interface SeedRun {
  runId: string;
  specId: string;
  projectId: string;
  trigger: string;
  branch: string;
  status: string;
  outcome: string | null;
  prUrl: string | null;
  startedAt: Date;
  endedAt: Date | null;
  orgId: string;
}

export interface SeedRunTask {
  taskId: string;
  runId: string;
  kind: string;
  title: string;
  status: string;
  startedAt: Date | null;
  orgId: string;
}

export interface SeedEvent {
  id: number;
  ts: Date;
  runId: string | null;
  projectId: string | null;
  eventType: string;
  orgId: string;
}

export interface SeedCostRecord {
  id: number;
  runId: string;
  taskId: string;
  projectId: string;
  costUsd: string;
  recordedAt: Date;
  orgId: string;
}

export interface SeedData {
  projects: SeedProject[];
  specs?: SeedSpec[];
  personas?: SeedPersona[];
  behaviors?: SeedBehavior[];
  milestones?: SeedMilestone[];
  specDependencies?: SeedSpecDependency[];
  runs?: SeedRun[];
  runTasks?: SeedRunTask[];
  events?: SeedEvent[];
  costRecords?: SeedCostRecord[];
}

export interface RepositoriesConformanceHarness {
  repositories: Repositories;
  /** Seed the backing store with projects (and optionally other entities) first. */
  seed(data: SeedData): Promise<void> | void;
  /**
   * A client scoped to `orgId`. Reads through it must see ONLY that org's rows
   * (and writes ride this client) — the RLS row-visibility contract the seam
   * carries through from the org-scoped transaction.
   */
  clientForOrg(orgId: string): QueryClient;
}

export const ORG_A = "org_a";
export const ORG_B = "org_b";

// A platform-admin actor: the product-entity stores self-authorize via the
// actor's org/project scoping, so the conformance suite uses an admin so the
// store's authorization gate never masks the RLS row-visibility assertion we are
// actually testing (off-scope client → zero rows).
export const adminActor: ActorContext = {
  userId: "user_admin",
  orgId: null,
  projectId: null,
  scopes: ["platform:admin"],
  source: "local_dev",
};

export function projectA(): SeedProject {
  return {
    projectId: "project_a",
    name: "A",
    repoUrl: "https://example.com/a.git",
    defaultBranch: "main",
    runnerImage: "img",
    allocator: "local",
    config: { version: 1 },
    orgId: ORG_A,
  };
}

export function specA(): SeedSpec {
  return {
    specId: "spec_a",
    projectId: "project_a",
    title: "Spec A",
    description: "desc",
    acceptanceCriteria: ["does the thing"],
    dependsOn: [],
    status: "draft",
    orgId: ORG_A,
  };
}

export const T0 = new Date("2026-02-01T00:00:00.000Z");
export const T1 = new Date("2026-02-01T00:01:00.000Z");

export function runA(): SeedRun {
  return {
    runId: "run_a",
    specId: "spec_a",
    projectId: "project_a",
    trigger: "manual",
    branch: "main",
    status: "running",
    outcome: null,
    prUrl: null,
    startedAt: T0,
    endedAt: null,
    orgId: ORG_A,
  };
}
