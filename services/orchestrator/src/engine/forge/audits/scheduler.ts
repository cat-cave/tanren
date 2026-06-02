// P3-0021 scheduled-audits scheduler. Composes the foundations:
//
//   runAuditJob(deps, job)
//     Runs the job's read-only Answerer pass (over the injectable
//     `AuditPassRunner`), then EMITS each finding into the candidate inbox
//     (P3-0022) as a candidate. Findings land on a SYSTEM source that
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
import { InboxStore } from "../inbox/store.js";
import type { Candidate, InboxSource, TriageAnswerer } from "../inbox/types.js";
import { AuditsStore } from "./store.js";
import {
  AuditFindingsSummary,
  type AuditFinding,
  type AuditFindingsSummary as Summary,
  type AuditJob,
  type AuditPassRunner,
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

// Roll the raw findings up into the job's summary (count + worst severity).
const SEVERITY_RANK: Record<string, number> = { info: 1, warn: 2, fail: 3 };

export function summarizeFindings(findings: ReadonlyArray<AuditFinding>): Summary {
  if (findings.length === 0) {
    return AuditFindingsSummary.parse({
      count: 0,
      severity: "ok",
      note: "clean · no new findings",
    });
  }
  let worst: AuditFinding["severity"] = "info";
  for (const finding of findings) {
    if ((SEVERITY_RANK[finding.severity] ?? 0) > (SEVERITY_RANK[worst] ?? 0)) worst = finding.severity;
  }
  const note = `${findings.length} found · routed to the candidate inbox`;
  return AuditFindingsSummary.parse({ count: findings.length, severity: worst, note });
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
    for (const finding of findings) {
      const triage = await answerer.triage({
        candidate: {
          title: finding.title,
          body: finding.body,
          severity: finding.severity,
          sourceKind: source.kind,
          projectId: job.projectId,
        },
        source,
        existingSpecs: [],
      });
      // System source ⇒ auto_routable ⇒ candidate rests `auto_routed`.
      const status = triage.verdict === "auto_routable" ? "auto_routed" : "triaged";
      candidates.push(
        await InboxStore.upsertCandidate(
          deps.pool,
          source,
          {
            externalId: `${job.id}:${finding.externalId}`,
            title: finding.title,
            body: finding.body,
            severity: finding.severity,
            projectId: job.projectId,
          },
          triage,
          status,
        ),
      );
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
