// scheduled-audits scheduler. Composes the foundations:
//
//   runAuditJob(deps, job)
//     Runs the job's read-only Answerer pass (over the injectable
//     `AuditPassRunner`), then EMITS each finding into the candidate inbox
// as a candidate. Findings land on a SYSTEM source that
//     auto-routes (`kind: "scheduled_audit"`, `autoRoute: true`), so each
//     finding is triaged auto_routable and upserted as `auto_routed` with no
//     manual triage. Finally it stamps the job's `last_run` + findings roll-up.
//
// This deliberately REUSES the inbox store/engine rather than forking it: the
// audit source is just another configurable system source, and the finding →
// candidate hand-off goes through the same `upsertCandidate` idempotent path
// (keyed on (source_id, external_id)) so re-running a job never duplicates.
//
// The pass runner + the triage answerer are injected, so a test drives the
// whole flow with fakes and no provider / SSH — see scheduledAudits.test.ts.

import type pg from "pg";
import { DiscoveryStore, type ExistingSpecSummary } from "../../repositories/discovery.js";
import { ProjectStore } from "../../repositories/projects.js";
import { systemActor } from "../../state/actor.js";
import { type AuditPosture, decideFromFindings } from "../../contracts/auditPosture.js";
import { DEFAULT_AUDIT_POSTURE, isAbsentProjectConfig, migrateProjectConfig } from "../../config/index.js";
import type { Finding } from "../../contracts/findings.js";
import { PersistentlyInvalidSpecError } from "../specQuality/index.js";
import { InboxStore } from "../inbox/store.js";
import { autoRouteCandidate, type AutoRouteDeps } from "../inbox/engine.js";
import type { Candidate, InboxSource, TriageAnswerer } from "../inbox/types.js";
import { AuditsStore } from "./store.js";
import {
  AuditFindingsSummary,
  type AuditFinding,
  type AuditFindingsSummary as Summary,
  type AuditJob,
  type AuditPassRunner,
  findingToInboxSeverity,
} from "./types.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface AuditSchedulerDeps {
  pool: pg.Pool;
  // The injectable read-only pass executor (Answerer over SSH in prod; a fake
  // in tests). A job with no runner is a no-op (records a clean run).
  passRunner: AuditPassRunner;
  // The triage answerer — REQUIRED only when a pass actually produces findings.
  // Production resolves a real provider answerer from the project's `forge`
  // routing; tests inject a fake. There is NO production fallback to a
  // deterministic verdict (§8a). A job with no findings never consults it, so it
  // is optional on the deps (a clean/no-op pass needs no model).
  answerer?: TriageAnswerer;
  // Autonomous DAG insert (autonomy-engine.md §1d): when wired, an `auto_routed`
  // finding carrying a `routableSpec` is COMMITTED INTO THE DAG (no operator) so
  // the DagWalker executes "Tanren proactively found + is fixing a problem".
  // Mirrors the inbox poller's `autoRoute`. Plane-split: it carries the
  // control-plane `runStateWriter` so the spec write routes through the control
  // plane in the data-plane worker. Absent ⇒ the finding rests `auto_routed` in
  // the inbox (the manual-review default).
  autoRoute?: AutoRouteDeps;
  // Test/clock seam.
  now?: () => Date;
}

/** Thrown when an audit pass yields findings but no model answerer is wired (§8a). */
export class AuditTriageAnswererUnconfiguredError extends Error {
  constructor() {
    super("audit-finding triage requires a provider answerer; none was wired");
    this.name = "AuditTriageAnswererUnconfiguredError";
  }
}

export interface RunAuditJobResult {
  job: AuditJob;
  candidates: Candidate[];
  findings: AuditFinding[];
}

// The org-wide scheduled-audit system source name. One per org; the scheduler
// finds-or-creates it so every audit job's findings funnel through one
// auto-routing source in the inbox (the hi-fi "scheduled audits" source row).
const AUDIT_SOURCE_NAME = "scheduled audits";

async function loadExistingSpecs(client: QueryClient, projectId: string | null): Promise<ExistingSpecSummary[]> {
  if (projectId === null) return [];
  return DiscoveryStore.listExistingSpecs(client, projectId, systemActor);
}

async function findOrCreateAuditSource(client: QueryClient, orgId: string): Promise<InboxSource> {
  const existing = (await InboxStore.listSources(client, orgId)).find(
    (s) => s.kind === "scheduled_audit" && s.name === AUDIT_SOURCE_NAME,
  );
  if (existing !== undefined) return existing;
  return InboxStore.createSource(client, {
    orgId,
    projectId: null,
    kind: "scheduled_audit",
    name: AUDIT_SOURCE_NAME,
    detail: "auto-routes findings · no manual triage",
    config: {},
    enabled: true,
    autoRoute: true,
  });
}

// Roll the raw findings up into the job's surface summary (count + worst severity).
// The finding scale is now the SHARED P0–P3 ladder; the job-row summary keeps the
// surface's `ok|info|warn|fail` display vocabulary (the dashboard tone), so the worst
// P0–P3 is projected onto it via `findingToInboxSeverity` (P0/P1 ⇒ fail, P2 ⇒ warn,
// P3 ⇒ info). P0 is most-severe ⇒ the LOWEST rank.
const SEVERITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export function summarizeFindings(findings: ReadonlyArray<AuditFinding>): Summary {
  if (findings.length === 0) {
    return AuditFindingsSummary.parse({
      count: 0,
      severity: "ok",
      note: "clean · no new findings",
    });
  }
  let worst: AuditFinding["severity"] = "P3";
  for (const finding of findings) {
    if ((SEVERITY_RANK[finding.severity] ?? 3) < (SEVERITY_RANK[worst] ?? 3)) worst = finding.severity;
  }
  const note = `${findings.length} found · routed to the candidate inbox`;
  return AuditFindingsSummary.parse({ count: findings.length, severity: findingToInboxSeverity(worst), note });
}

// Resolve the project's `auditPosture` for the scheduled audit — the SAME DORA knob
// inline audits use (`migrateProjectConfig(config).auditPosture`). A project-less job or
// an ABSENT project config (a fresh project's `'{}'::jsonb`) falls through to the system
// default posture (which still blocks on P0/P1 — never a silent "block on nothing"). A
// PRESENT-but-CORRUPT config is NOT masked — `migrateProjectConfig` throws loudly
// (no-silent-fallback). System-scoped read: the loop already runs under the job's org scope.
async function resolveAuditPosture(client: QueryClient, projectId: string | null): Promise<AuditPosture> {
  if (projectId === null) return DEFAULT_AUDIT_POSTURE;
  const raw = await ProjectStore.getConfig(client, projectId, systemActor);
  if (isAbsentProjectConfig(raw)) return DEFAULT_AUDIT_POSTURE;
  return migrateProjectConfig(raw).auditPosture;
}

export async function runAuditJob(deps: AuditSchedulerDeps, job: AuditJob): Promise<RunAuditJobResult> {
  const now = (deps.now ?? (() => new Date()))();
  if (!job.enabled) {
    // A paused job records nothing; the surface keeps its prior findings.
    return { job, candidates: [], findings: [] };
  }

  const { findings } = await deps.passRunner.run(job);

  const candidates: Candidate[] = [];
  if (findings.length > 0) {
    if (deps.answerer === undefined) {
      throw new AuditTriageAnswererUnconfiguredError();
    }
    const answerer = deps.answerer;
    const source = await findOrCreateAuditSource(deps.pool, job.orgId);
    const existingSpecs = await loadExistingSpecs(deps.pool, job.projectId);
    // Resolve the project's auditPosture (the same DORA knob inline audits use) and
    // run the P0–P3 findings through `decideFromFindings` — the SAME severity path: a
    // finding at-or-above `blockReviewAt` is a BLOCKING finding that must be ESCALATED to
    // needs_attention (a human decision), NOT auto-routed; the residual is routed.
    const posture = await resolveAuditPosture(deps.pool, job.projectId);
    const blocking = new Set(blockingFindingIds(findings, posture));
    for (const finding of findings) {
      const triage = await answerer.triage({
        candidate: {
          title: finding.title,
          body: finding.body,
          // The candidate store/surface uses the `info|warn|fail` display scale; the
          // ROUTING decision is made on the P0–P3 severity (above). Project for display.
          severity: findingToInboxSeverity(finding.severity),
          sourceKind: source.kind,
          projectId: job.projectId,
        },
        source,
        existingSpecs,
      });
      // A BLOCKING finding (≥ the posture's blockReviewAt) is ESCALATED to
      // needs_attention: it rests `triaged` (the loud inbox surface) and is NEVER
      // auto-routed, exactly the merge-path posture `block`. Otherwise a system-source
      // auto_routable finding rests `auto_routed`.
      const status =
        !blocking.has(finding.externalId) && triage.verdict === "auto_routable" ? "auto_routed" : "triaged";
      let candidate = await InboxStore.upsertCandidate(
        deps.pool,
        source,
        {
          externalId: `${job.id}:${finding.externalId}`,
          title: finding.title,
          body: finding.body,
          severity: findingToInboxSeverity(finding.severity),
          projectId: job.projectId,
        },
        triage,
        status,
      );
      // Autonomous DAG insert (NON-blocking, auto_routable, with a routable spec): commit
      // it now (no operator), with the dead-letter guard. Extracted to keep nesting shallow.
      if (deps.autoRoute !== undefined && candidate.status === "auto_routed" && triage.routableSpec !== null) {
        candidate = await autoRouteOrDeadLetter(deps, candidate, triage.routableSpec, deps.autoRoute);
      }
      candidates.push(candidate);
    }
  }

  const summary = summarizeFindings(findings);
  const updated = await AuditsStore.recordAuditRun(deps.pool, job.id, summary, now);
  return {
    job: updated ?? { ...job, lastRun: now.toISOString(), findings: summary },
    candidates,
    findings,
  };
}

// Commit an auto-routable finding's spec into the DAG, with the DEAD-LETTER guard
// (mirrors intake's §3.6 fix 6). If `autoRouteCandidate` throws
// `PersistentlyInvalidSpecError` (the spec-quality gate could not make the spec valid
// within its bounded budget — a genuine "a human must look" signal), DO NOT re-throw:
// re-throwing would skip the caller's `recordAuditRun`, leaving `lastRun` un-stamped so
// the NEXT tick re-runs this same job and re-spends on the same broken spec FOREVER.
// Instead ESCALATE: resolve the candidate to `triaged` (needs_attention) so the
// idempotent upsert keeps it there and never re-routes; the caller then records the run.
// Any OTHER error propagates (transient — retry).
async function autoRouteOrDeadLetter(
  deps: AuditSchedulerDeps,
  candidate: Candidate,
  routableSpec: NonNullable<Parameters<typeof autoRouteCandidate>[2]>,
  autoRoute: AutoRouteDeps,
): Promise<Candidate> {
  try {
    return (await autoRouteCandidate(deps, candidate, routableSpec, autoRoute)).candidate;
  } catch (error) {
    if (!(error instanceof PersistentlyInvalidSpecError)) throw error;
    console.error(
      `[audit] candidate ${candidate.id} spec persistently invalid — dead-lettering to inbox (needs attention):`,
      error.message,
    );
    return (await InboxStore.resolveCandidate(deps.pool, candidate.id, "triaged", null)) ?? candidate;
  }
}

// The externalIds of the findings that BLOCK reaching review under the project's
// posture (`decideFromFindings.block` is a boolean over the worst severity; this maps
// each finding to a `Finding` and keeps the at-or-above-`blockReviewAt` ones). These are
// escalated to needs_attention rather than auto-routed.
function blockingFindingIds(findings: ReadonlyArray<AuditFinding>, posture: AuditPosture): string[] {
  return findings
    .filter((f) => {
      const finding: Finding = { id: f.externalId, severity: f.severity, title: f.title, body: f.body };
      return decideFromFindings([finding], posture).block;
    })
    .map((f) => f.externalId);
}
