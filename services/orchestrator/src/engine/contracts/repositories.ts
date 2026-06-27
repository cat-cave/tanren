// The `Repositories` seam: the data-access layer's contract surface, aggregating
// the per-entity repository stores into one slottable interface — the same shape
// `JobQueue`/`EventStore`/`SecretStore` already have (a contract + a pg-backed
// impl + a conformance suite). Track C of the forward roadmap (the data-access
// layer) promotes the existing `engine/repositories/**` stores to this seam so
// callers depend on the CONTRACT, not the concrete pg module, and a backend can
// be slotted as a new impl + registry entry rather than a refactor.
//
// Every store method takes an explicit `QueryClient` (a pool OR a `runWithOrgScope`
// client) plus the acting `ActorRef`. The seam does NOT open transactions or widen
// org scope: the caller decides whether to run on the bare pool or inside an
// org-scoped transaction, exactly as it did before the move. Under RLS, a read on
// an org-scoped client sees only that org's rows; a read on the wrong scope sees
// zero — the seam carries that through unchanged.

import type pg from "pg";
import type { ActorRef } from "../state/actor.js";
import { ProjectStore } from "../repositories/projects.js";
import { RunStore } from "../repositories/runs.js";
import { SpecStore } from "../repositories/specs.js";
import { ProjectSpecStore } from "../repositories/projectSpecs.js";
import { TaskStore } from "../repositories/tasks.js";
// The run-detail event/cost read stores ride in via the repositories barrel so
// the contract keeps its module-dependency budget (one import for both stores).
import { CostStore, EventStore } from "../repositories/index.js";
import { JobStore } from "../repositories/jobs.js";
import { ActorStore } from "../repositories/actors.js";
import { PersonaStore } from "../entities/personas.js";
import { BehaviorStore } from "../entities/behaviors.js";
import { MilestoneStore } from "../entities/milestones.js";
import { SpecDependencyStore } from "../entities/specDependencies.js";
// Forge + recovery stores ride in via the repositories barrel (same as the
// event/cost read stores) so the contract keeps its module-dependency budget.
import {
  DiscoveryStore,
  RecoveryStore,
  ForgeToolsStore,
  ForgeThreadStore,
  ForgeTurnStore,
  ForgeProposalStore,
  InboxStore,
  AuditsStore,
  WebhookEventStore,
  OrgIntegrationsStore,
  AppEnvironmentStore,
  FragmentsStore,
  EntityClaimStore,
} from "../repositories/index.js";

/** A pool or a checked-out (org-scoped) client — anything that can run a query. */
export type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * The aggregate data-access seam. Each member is a per-entity repository whose
 * methods take a `QueryClient` + `ActorRef`. Implementations are value objects
 * (no constructor state) because the client is passed per-call — the scope lives
 * with the caller, not the repository.
 */
export interface Repositories {
  readonly runs: typeof RunStore;
  /** The run-lifecycle spec store (org_id + SpecStatus enum; engine/workflow). */
  readonly specs: typeof SpecStore;
  /** The product-facing spec CRUD store backing `routes/specs` (no org_id; status as string). */
  readonly projectSpecs: typeof ProjectSpecStore;
  readonly projects: typeof ProjectStore;
  readonly tasks: typeof TaskStore;
  /** Run-detail event-feed reads (recent snapshot, paginated events, project feed). */
  readonly events: typeof EventStore;
  /** Run-detail cost-record reads (per-run snapshot + paginated costs). */
  readonly costs: typeof CostStore;
  readonly jobs: typeof JobStore;
  readonly actors: typeof ActorStore;
  // Product entities (engine/entities). Their methods take an HTTP `ActorContext`
  // and self-authorize via org/project scoping; the seam carries that through.
  readonly personas: typeof PersonaStore;
  readonly behaviors: typeof BehaviorStore;
  readonly milestones: typeof MilestoneStore;
  readonly specDependencies: typeof SpecDependencyStore;
  // Forge data-access stores (engine/forge). Thread/turn/proposal stores take an
  // HTTP `ActorContext` and self-authorize; the seam carries that through. Their
  // reads/writes self-route via `resolveWritableClient`, so a handed-in client is
  // used verbatim and the ambient org-scoped client is joined when one is open.
  readonly forgeThreads: typeof ForgeThreadStore;
  readonly forgeTurns: typeof ForgeTurnStore;
  readonly forgeProposals: typeof ForgeProposalStore;
  /** Candidate-inbox (`inbox_sources` + `candidates`) data access. */
  readonly inbox: typeof InboxStore;
  /** Scheduled-audits (`audit_jobs`) data access. */
  readonly audits: typeof AuditsStore;
  /** Durable raw-webhook landing (`webhook_events`) persist-then-202 data access. */
  readonly webhookEvents: typeof WebhookEventStore;
  /** Forge discovery: `specs.metadata` provenance + the grounding spec list. */
  readonly discovery: typeof DiscoveryStore;
  /** Failure-recovery: the run read, captured-commit reads, spec reopen writes. */
  readonly recovery: typeof RecoveryStore;
  /** Forge-tools tenant reads (access gates + the `tanren.read_*` projections). */
  readonly forgeTools: typeof ForgeToolsStore;
  /** Plane A: the `org_integrations` registry (CRUD + `getGrant`). */
  readonly orgIntegrations: typeof OrgIntegrationsStore;
  /** Plane B: the built product's `project_app_env` store (upsert/list/get/delete). */
  readonly appEnvironment: typeof AppEnvironmentStore;
  /** Tanren-native templating (docs/roadmap/templating-system.md): the org-scoped
   * fragment store the per-fragment authoring DAG persists into; the unified
   * library loader combines bundled core + these. */
  readonly fragments: typeof FragmentsStore;
  /** §3.3 entity-anchored issue CLAIMS: the Tanren-native defect ledger (`entity_claims`). */
  readonly entityClaims: typeof EntityClaimStore;
}

/**
 * The Postgres-backed implementation of the {@link Repositories} seam: the
 * existing `engine/repositories/**` stores, bound together. There is exactly one
 * impl today (pg); a future backend is a new object satisfying `Repositories`,
 * not a rewrite of the call sites.
 */
export const pgRepositories: Repositories = {
  runs: RunStore,
  specs: SpecStore,
  projectSpecs: ProjectSpecStore,
  projects: ProjectStore,
  tasks: TaskStore,
  events: EventStore,
  costs: CostStore,
  jobs: JobStore,
  actors: ActorStore,
  personas: PersonaStore,
  behaviors: BehaviorStore,
  milestones: MilestoneStore,
  specDependencies: SpecDependencyStore,
  forgeThreads: ForgeThreadStore,
  forgeTurns: ForgeTurnStore,
  forgeProposals: ForgeProposalStore,
  inbox: InboxStore,
  audits: AuditsStore,
  webhookEvents: WebhookEventStore,
  discovery: DiscoveryStore,
  recovery: RecoveryStore,
  forgeTools: ForgeToolsStore,
  orgIntegrations: OrgIntegrationsStore,
  appEnvironment: AppEnvironmentStore,
  fragments: FragmentsStore,
  entityClaims: EntityClaimStore,
} as const;

export type { ActorRef };
