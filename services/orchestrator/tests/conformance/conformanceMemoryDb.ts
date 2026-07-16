// The in-memory backing store for the `Repositories` seam conformance harness
// (repositories.conformance.test.ts). It holds the small set of records the
// stores read/write and models RLS row visibility per org. The product-entity
// SQL handlers live with the driver; the run-domain read SQL (runs/tasks/
// events/cost_records, added with the run+dora DAL migration) lives in
// `conformanceRunSql.ts` so neither file outgrows the 500-line cap.

import type {
  SeedBehavior,
  SeedCostRecord,
  SeedEvent,
  SeedMilestone,
  SeedPersona,
  SeedProject,
  SeedRun,
  SeedRunTask,
  SeedSpec,
  SeedSpecDependency,
} from "./conformanceFixtures.js";

export interface ProjectRecord {
  project_id: string;
  name: string;
  repo_url: string;
  default_branch: string;
  runner_image: string;
  allocator: string;
  config: unknown;
  lifecycle: string;
  org_id: string | null;
}

export interface SpecRecord {
  spec_id: string;
  project_id: string;
  title: string;
  description: string;
  acceptance_criteria: unknown;
  depends_on: unknown;
  status: string;
  org_id: string | null;
}

export interface PersonaRecord {
  id: string;
  scope: string;
  org_id: string;
  project_id: string | null;
  name: string;
  description: string;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

export interface BehaviorRecord {
  id: string;
  persona_id: string;
  title: string;
  given: string;
  when: string;
  then: string;
  description: string | null;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
  org_id: string | null;
}

export interface MilestoneRecord {
  id: string;
  project_id: string;
  label: string;
  name: string;
  description: string | null;
  order_index: number;
  eta: Date | null;
  status: string;
  created_at: Date;
  updated_at: Date;
  org_id: string | null;
}

export interface SpecDependencyRecord {
  from_spec_id: string;
  to_spec_id: string;
  created_at: Date;
  org_id: string | null;
}

export interface RunRecord {
  run_id: string;
  spec_id: string;
  project_id: string;
  trigger: string;
  branch: string;
  status: string;
  outcome: string | null;
  pr_url: string | null;
  started_at: Date;
  ended_at: Date | null;
  org_id: string;
}

export interface RunTaskRecord {
  task_id: string;
  run_id: string;
  kind: string;
  title: string;
  parent_task_id: string | null;
  status: string;
  outcome: string | null;
  failure_kind: string | null;
  attempt: number;
  cli: string;
  model: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  org_id: string;
}

export interface EventRecord {
  id: number;
  ts: Date;
  run_id: string | null;
  task_id: string | null;
  spec_id: string | null;
  project_id: string | null;
  event_type: string;
  payload: unknown;
  org_id: string;
}

export interface CostRecord {
  id: number;
  task_id: string;
  run_id: string;
  project_id: string;
  cli: string;
  provider: string;
  model: string;
  input_tokens: number;
  cached_input_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  cost_usd: string;
  billing_mode: string;
  cost_basis: string;
  recorded_at: Date;
  org_id: string;
}

export interface QueryResult {
  rows: unknown[];
  rowCount: number;
}

const NOW = new Date("2026-01-01T00:00:00.000Z");

// In-memory store shared by every scoped client the harness hands out.
export class MemoryDb {
  projects: ProjectRecord[] = [];
  specs: SpecRecord[] = [];
  personas: PersonaRecord[] = [];
  behaviors: BehaviorRecord[] = [];
  milestones: MilestoneRecord[] = [];
  specDependencies: SpecDependencyRecord[] = [];
  runs: RunRecord[] = [];
  runTasks: RunTaskRecord[] = [];
  events: EventRecord[] = [];
  costRecords: CostRecord[] = [];

  seedProject(p: SeedProject): void {
    this.projects.push({
      project_id: p.projectId,
      name: p.name,
      repo_url: p.repoUrl,
      default_branch: p.defaultBranch,
      runner_image: p.runnerImage,
      allocator: p.allocator,
      config: p.config,
      lifecycle: "active",
      org_id: p.orgId,
    });
  }

  seedSpec(s: SeedSpec): void {
    this.specs.push({
      spec_id: s.specId,
      project_id: s.projectId,
      title: s.title,
      description: s.description,
      acceptance_criteria: s.acceptanceCriteria,
      depends_on: s.dependsOn,
      status: s.status,
      org_id: s.orgId,
    });
  }

  seedPersona(p: SeedPersona): void {
    this.personas.push({
      id: p.id,
      scope: p.scope,
      org_id: p.orgId,
      project_id: p.projectId,
      name: p.name,
      description: p.description,
      metadata: {},
      created_at: NOW,
      updated_at: NOW,
    });
  }

  seedBehavior(b: SeedBehavior): void {
    const persona = this.personas.find((p) => p.id === b.personaId);
    /* eslint-disable unicorn/no-thenable */
    // `then` is the persisted BDD Given/When/Then column name, not a Promise hook.
    this.behaviors.push({
      id: b.id,
      persona_id: b.personaId,
      title: b.title,
      given: b.given,
      when: b.when,
      then: b.then,
      description: b.description,
      metadata: {},
      created_at: NOW,
      updated_at: NOW,
      org_id: persona?.org_id ?? null,
    });
    /* eslint-enable unicorn/no-thenable */
  }

  seedMilestone(m: SeedMilestone): void {
    this.milestones.push({
      id: m.id,
      project_id: m.projectId,
      label: m.label,
      name: m.name,
      description: null,
      order_index: m.orderIndex,
      eta: null,
      status: m.status,
      created_at: NOW,
      updated_at: NOW,
      org_id: m.orgId,
    });
  }

  seedSpecDependency(d: SeedSpecDependency): void {
    this.specDependencies.push({
      from_spec_id: d.fromSpecId,
      to_spec_id: d.toSpecId,
      created_at: NOW,
      // The DAG edge inherits the org of its source spec for visibility modeling.
      org_id: this.specs.find((s) => s.spec_id === d.fromSpecId)?.org_id ?? "org_a",
    });
  }

  seedRun(r: SeedRun): void {
    this.runs.push({
      run_id: r.runId,
      spec_id: r.specId,
      project_id: r.projectId,
      trigger: r.trigger,
      branch: r.branch,
      status: r.status,
      outcome: r.outcome,
      pr_url: r.prUrl,
      started_at: r.startedAt,
      ended_at: r.endedAt,
      org_id: r.orgId,
    });
  }

  seedRunTask(t: SeedRunTask): void {
    this.runTasks.push({
      task_id: t.taskId,
      run_id: t.runId,
      kind: t.kind,
      title: t.title,
      parent_task_id: null,
      status: t.status,
      outcome: null,
      failure_kind: null,
      attempt: 1,
      cli: "codex",
      model: null,
      started_at: t.startedAt,
      ended_at: null,
      org_id: t.orgId,
    });
  }

  seedEvent(e: SeedEvent): void {
    this.events.push({
      id: e.id,
      ts: e.ts,
      run_id: e.runId,
      task_id: null,
      spec_id: null,
      project_id: e.projectId,
      event_type: e.eventType,
      payload: {},
      org_id: e.orgId,
    });
  }

  seedCostRecord(c: SeedCostRecord): void {
    this.costRecords.push({
      id: c.id,
      task_id: c.taskId,
      run_id: c.runId,
      project_id: c.projectId,
      cli: "codex",
      provider: "openai",
      model: "gpt",
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
      cost_usd: c.costUsd,
      billing_mode: "metered",
      cost_basis: "actual",
      recorded_at: c.recordedAt,
      org_id: c.orgId,
    });
  }
}
