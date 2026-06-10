// The TEMPLATE-MAINTENANCE LOOP (docs/roadmap/templating-system.md §4) — the
// scheduler that makes templates FIRST-CLASS Tanren projects Tanren maintains. It
// is modeled on (and REUSES) the scheduled-audit machinery rather than reinventing
// scheduling: the same long-lived per-process loop shape (`start`/`stop`/`tick`) as
// `AuditSchedulerLoop`, the same cross-org system-scoped fan-out + per-org org
// scope, and — crucially — the same finding→candidate→DAG hand-off (`runAuditJob`)
// to re-enter a regression into the DAG. The maintenance-specific parts are ONLY the
// re-validation (the harness), the channel cadence, the proof refresh / degraded
// marking, and the nightly→lts graduation gate.
//
// One tick, per due template (a template whose channel cadence window has elapsed):
//   1. RE-VALIDATE — run the full harness (`runMaintenancePass`).
//   2a. GREEN  → refresh `validationProof` + `validatedAt` on the manifest →
//                status `validated` (`updateManifest`). A nightly template that is
//                green-and-aged becomes GRADUATION-eligible (the gate is evaluated +
//                surfaced; the actual lts promotion is the operator/blessing step).
//   2b. RED    → mark `degraded` (`markDegraded`) so selection stops choosing it AND
//                file the regression as a finding that re-enters the DAG (the SAME
//                `runAuditJob` hand-off a scheduled audit uses) — fail-closed, never
//                ship a broken template.
//   3. A `validated` template whose proof has EXPIRED past the freshness horizon is
//      ALSO degraded (a template the loop stopped re-validating must stop being chosen).
//
// FAIL-CLOSED + LOUD: a per-template failure (harness throw, store throw) is logged
// and the next tick retries — it never silently drops the template green. Clock is
// INJECTED (no Date.now).

import type pg from "pg";
import { runWithJobOrgId, runWithSystemScope } from "@tanren/db";
import { orgScopingPool } from "../../data/orgScopedDb.js";
import { systemActor } from "../../state/actor.js";
import { TemplateStore, type Template } from "../../repositories/templates.js";
import type { TemplateValidationProof } from "../manifest.js";
import { runAuditJob, type AuditSchedulerDeps } from "../../forge/audits/scheduler.js";
import type { AuditFinding, AuditJob, AuditPassRunner } from "../../forge/audits/types.js";
import type { TriageAnswerer } from "../../forge/inbox/types.js";
import type { AutoRouteDeps } from "../../forge/inbox/engine.js";
import { CHANNEL_CADENCE_MS, channelCadence } from "./channelPolicy.js";
import { proofExpired, shouldDegrade } from "./freshness.js";
import { graduationDecision, type GraduationDecision } from "./graduation.js";
import { runMaintenancePass, type MaintainableTemplate, type TemplateRevalidator } from "./maintenancePass.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("template-maintenance");

export interface TemplateMaintenanceLoopDeps {
  pool: pg.Pool;
  // The harness seam: re-runs the full validation harness over a template repo and
  // returns the fresh proof. Production wires `runValidationHarness` (over an
  // allocated runner + the template's resolved CI config); tests inject a scripted
  // revalidator. A throw is a LOUD per-template failure (logged + retried), never a
  // silent green.
  revalidator: TemplateRevalidator;
  // The triage answerer for a regression finding — the REAL provider answerer
  // (no §8a fallback), consulted only when a maintenance pass files a finding.
  // Resolved per template's org/project (mirrors the audit loop's answererFactory).
  answererFactory: (target: { orgId: string; projectId?: string }) => TriageAnswerer;
  // Autonomous DAG insert: commits a regression finding's routableSpec into the DAG
  // (the SAME auto-route deps the scheduled-audit loop carries — plane-split aware).
  autoRoute: AutoRouteDeps;
  // The freshness horizon (a `validated` proof older than this degrades). Default in
  // freshness.ts; overridable for tests.
  freshnessHorizonMs?: number;
  // The nightly→lts graduation aging window. Default in graduation.ts; test override.
  graduationAgingMs?: number;
  now?: () => number;
}

/** The per-template maintenance result a tick records (tests assert over these). */
export interface TemplateMaintenanceResult {
  templateId: string;
  // The verdict of the re-validation harness pass.
  validated: boolean;
  // The status the registry row was transitioned to this pass.
  status: "validated" | "degraded";
  // Whether the loop filed a regression finding (RED re-validation).
  filedFinding: boolean;
  // For a nightly template, the graduation gate's decision (eligible/why-not);
  // undefined for an lts template (graduation is nightly→lts only).
  graduation?: GraduationDecision;
}

/** Whether a template is DUE for a maintenance re-validation now (channel cadence). */
export function isTemplateMaintenanceDue(template: Template, now: number): boolean {
  // Only validated/degraded templates are maintained: a `draft` is not yet proven
  // (the creation flow owns it) and an `official` is blessed/cat-cave-governed.
  if (template.status !== "validated" && template.status !== "degraded") return false;
  const proof = template.manifest.validationProof;
  // No proof ⇒ always due (it must be (re)validated before it can be trusted).
  if (proof === null) return true;
  const last = Date.parse(proof.validatedAt);
  if (Number.isNaN(last)) return true;
  // `template.channel` is the `TemplateChannel` union; the record is total over it,
  // but `noUncheckedIndexedAccess` widens the read — `?? Infinity` keeps an
  // (impossible) miss from making the template spuriously due.
  return now - last >= (CHANNEL_CADENCE_MS[template.channel] ?? Number.POSITIVE_INFINITY);
}

/**
 * The recurring template-maintenance scheduler. `start()` ticks on an interval;
 * each tick re-validates every DUE template, refreshing its proof (green) or
 * degrading it + filing a finding (red). Per-template freshness is the persisted
 * `validatedAt` on the manifest (durable across restarts), so a tick after downtime
 * catches up due templates — exactly like the audit loop's `lastRun`.
 */
export class TemplateMaintenanceLoop {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private ticking = false;
  private readonly now: () => number;

  constructor(
    private readonly deps: TemplateMaintenanceLoopDeps,
    private readonly tickIntervalMs: number = 60 * 60_000,
  ) {
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer !== undefined) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Run one maintenance pass over all due templates. Returns the per-template results. */
  async tick(): Promise<TemplateMaintenanceResult[]> {
    if (this.ticking || this.stopped) return [];
    this.ticking = true;
    try {
      let due: Template[];
      try {
        due = await this.listDueTemplates();
      } catch (error) {
        log.error("failed to list templates (will retry next tick)", {}, error);
        return [];
      }
      const results: TemplateMaintenanceResult[] = [];
      for (const template of due) {
        try {
          const result = await runWithJobOrgId(template.orgId, () => this.maintainOne(template));
          results.push(result);
        } catch (error) {
          log.error("template maintenance failed", { templateId: template.id }, error);
        }
      }
      return results;
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Maintain ONE template: re-validate → persist green/refresh OR degrade+file. Runs
   * inside the template's org scope (so the store writes are org-scoped under RLS).
   */
  private async maintainOne(template: Template): Promise<TemplateMaintenanceResult> {
    const scopedPool = orgScopingPool(this.deps.pool);
    const maintainable: MaintainableTemplate = {
      id: template.id,
      orgId: template.orgId,
      repoRef: template.repoRef,
      manifest: template.manifest,
    };
    const outcome = await runMaintenancePass(this.deps.revalidator, maintainable);
    const now = new Date(this.now());

    // Degrade when the re-validation FAILED (a regression — open blocking finding) OR
    // (defense in depth) the just-produced proof is somehow already stale. The fresh
    // proof is the green case; a RED pass carries an open blocking finding.
    const degrade = shouldDegrade({
      proof: outcome.proof,
      openBlockingFindings: outcome.findings.length,
      now,
      ...(this.deps.freshnessHorizonMs !== undefined && { horizonMs: this.deps.freshnessHorizonMs }),
    });

    if (outcome.validated && !degrade) {
      // GREEN: persist the refreshed manifest (new proof + validatedAt) as `validated`.
      await TemplateStore.updateManifest(scopedPool, template.id, outcome.nextManifest, "validated", systemActor);
      const graduation = this.evaluateGraduation(template, outcome.proof, now);
      return {
        templateId: template.id,
        validated: true,
        status: "validated",
        filedFinding: false,
        ...(graduation !== undefined && { graduation }),
      };
    }

    // RED (or freshly-stale): persist the manifest WITH the failed proof, mark degraded
    // (selection stops choosing it), then file the regression finding into the DAG.
    await TemplateStore.updateManifest(scopedPool, template.id, outcome.nextManifest, "degraded", systemActor);
    const filedFinding = await this.fileRegression(template, scopedPool, outcome.findings);
    return {
      templateId: template.id,
      validated: outcome.validated,
      status: "degraded",
      filedFinding,
    };
  }

  /**
   * File the regression finding(s) into the DAG through the EXISTING scheduled-audit
   * hand-off (`runAuditJob`): an ephemeral, in-memory maintenance `AuditJob` whose
   * one-shot pass runner returns the maintenance findings. This reuses the entire
   * finding→triage→candidate→auto-route path verbatim (idempotent on the stable
   * finding externalId), so the regression becomes a real DAG spec with no operator —
   * the maintenance loop does NOT reinvent finding routing.
   */
  private async fileRegression(
    template: Template,
    scopedPool: pg.Pool,
    findings: ReadonlyArray<AuditFinding>,
  ): Promise<boolean> {
    if (findings.length === 0) return false;
    const job: AuditJob = {
      id: `template-maintenance:${template.id}`,
      orgId: template.orgId,
      projectId: null,
      kind: "deps",
      name: `template maintenance · ${template.manifest.stack}`,
      cadence: channelCadence(template.channel),
      targetWindow: template.repoRef,
      answererCli: "",
      enabled: true,
      lastRun: null,
      findings: { count: 0, severity: "ok", note: "" },
    };
    const passRunner: AuditPassRunner = { run: async () => ({ findings: [...findings] }) };
    const deps: AuditSchedulerDeps = {
      pool: scopedPool,
      passRunner,
      answerer: this.deps.answererFactory({ orgId: template.orgId }),
      autoRoute: this.deps.autoRoute,
      now: () => new Date(this.now()),
    };
    const result = await runAuditJob(deps, job);
    return result.findings.length > 0;
  }

  /**
   * Evaluate the nightly→lts graduation gate for a template. Only a NIGHTLY template
   * graduates (lts is the destination, not a source); an lts template returns
   * undefined. The gate reads the just-produced GREEN proof — a nightly version is
   * eligible once it has been green-and-aged (graduation.ts). Surfacing the decision
   * here is the gate; the actual channel promotion is the blessing/operator step.
   */
  private evaluateGraduation(
    template: Template,
    proof: TemplateValidationProof,
    now: Date,
  ): GraduationDecision | undefined {
    if (template.channel !== "nightly") return undefined;
    return graduationDecision({
      proof,
      now,
      ...(this.deps.graduationAgingMs !== undefined && { agingMs: this.deps.graduationAgingMs }),
    });
  }

  /**
   * The DUE subset of all maintainable templates. The cross-org fan-out is
   * system-scoped (`listDistinctOrgIds` confirms the loop spans every org); under
   * system scope `TemplateStore.list` already returns ALL orgs' templates, so we list
   * once and filter to the channel-cadence-due rows.
   */
  private async listDueTemplates(): Promise<Template[]> {
    const now = this.now();
    // Confirm the cross-org span (and surface a DB-unreachable failure LOUDLY to the
    // tick's retry path); the actual rows come from the single system-scoped list.
    await runWithSystemScope(this.deps.pool, (client) => TemplateStore.listDistinctOrgIds(client));
    const templates = await runWithSystemScope(this.deps.pool, (client) => TemplateStore.list(client, systemActor));
    return templates.filter((template) => isTemplateMaintenanceDue(template, now));
  }
}

// Re-export the freshness predicate so a caller (selection, narration) can ask "is
// this template's proof expired?" without reaching into the freshness module.
export { proofExpired };
