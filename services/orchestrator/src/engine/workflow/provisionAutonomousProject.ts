// SHARED project-bootstrap provisioning seam (Codex forward-look round 4: a fresh
// apex project wasn't seeded with what the autonomy loops need). Provisioning was
// SCATTERED + INCOMPLETE: onboarding seeded the issues inbox + the notification
// route, but the greenfield path (which apex uses) seeded ONLY the inbox (no
// notification route, no audit jobs), and brownfield-link seeded only the inbox.
// So an autonomous project was under-provisioned and the autonomy loops dead-ended.
//
// This is the SINGLE place that seeds the COMPLETE set an autonomous project needs.
// Every project-create path (onboarding derive · greenfield create · brownfield
// link) calls it, so no path under-provisions. It REUSES the existing idempotent
// seeds (it does not fork them):
//
//   1. Audit-job catalog (Loop 3 dead-end 1) — `seedAuditCatalog`: the standard
//      security/deps/mutation/stale_specs scheduled-audit jobs, so the audit loop
//      has work to pick up on a fresh project.
//   2. Default notification route (Loop 5) — `ensureDefaultNotificationRoute`: the
//      per-org default ntfy route for the apex-critical milestone events, so
//      greenfield/brownfield get it too (not just onboarding).
//   3. Issues inbox source — `ensureIssuesInboxSource`: the post-merge re-intake /
//      user-report inbox, seeded consistently on every path.
//
// IDEMPOTENT + org-scoped/RLS: each seed is itself idempotent (re-provision adds
// nothing) and runs under the org's RLS scope (the audit-catalog seed opens a
// `runWithOrgScope` client; the inbox + route seeds open their own org scope).
//
// FAILURE ISOLATION + LOUD (no-silent-fallback): the three seeds are INDEPENDENT —
// a failure in one (e.g. the audit catalog) must NOT strand the others (the inbox /
// route delivery a live run depends on). Each seed runs guarded; a failure is LOUD
// (`console.error` — never a quiet degrade) and recorded in `errors`. The caller
// inspects `errors` to decide whether to fail the request (when nothing is committed
// yet) or log-and-continue (the create is already committed). This is a LOUD partial,
// not a silent default — every failure is surfaced, just not allowed to cascade.

import type pg from "pg";
import { runWithOrgScope } from "@tanren/db";
import { ensureIssuesInboxSource } from "../forge/inbox/index.js";
import { seedAuditCatalog, type AuditKind } from "../forge/audits/index.js";
import { ensureDefaultNotificationRoute } from "../notifications/index.js";

export interface ProvisionAutonomousProjectInput {
  pool: pg.Pool;
  orgId: string;
  projectId: string;
  // The new project's repo URL — the issues inbox source is keyed on it.
  repoUrl: string;
  // The ntfy topic the default notification route delivers to. Defaults to the
  // per-tenant `tanren-org-<orgId>` bus (the deploy-default ntfy host applies when
  // no per-target base URL is set).
  ntfyTopic?: string;
}

export interface ProvisionAutonomousProjectResult {
  inboxSource?: { id: string; created: boolean };
  notificationRoute?: { targetId: string; created: boolean; events: number };
  auditCatalog?: { jobs: number; created: AuditKind[] };
  // The seeds that FAILED, surfaced LOUD so the caller never silently under-provisions.
  // Empty ⇒ a fully-provisioned project. Non-empty ⇒ a LOUD partial the caller acts on.
  errors: Array<{ seed: "auditCatalog" | "notificationRoute" | "inbox"; message: string }>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Seed the COMPLETE set an autonomous project needs (audit catalog + default
 * notification route + issues inbox). Idempotent + org-scoped/RLS. REQUIRED on
 * every project-create path so no path under-provisions. Each seed is isolated: a
 * failure in one is LOUD (recorded in `errors` + logged) but never strands the
 * others. The caller inspects `errors` to fail-or-continue (no silent strand).
 */
export async function provisionAutonomousProject(
  input: ProvisionAutonomousProjectInput,
): Promise<ProvisionAutonomousProjectResult> {
  const errors: ProvisionAutonomousProjectResult["errors"] = [];
  const result: ProvisionAutonomousProjectResult = { errors };

  // 1. Audit-job catalog (Loop 3 dead-end 1). Org-scoped under RLS so the seed only
  //    ever touches THIS org's rows; idempotent on (project, kind).
  try {
    const auditCatalog = await runWithOrgScope(input.pool, input.orgId, (client) =>
      seedAuditCatalog({ client, orgId: input.orgId, projectId: input.projectId }),
    );
    result.auditCatalog = { jobs: auditCatalog.jobs.length, created: auditCatalog.created };
  } catch (error) {
    console.error(`[provision] audit-catalog seed failed for project ${input.projectId}:`, messageOf(error));
    errors.push({ seed: "auditCatalog", message: messageOf(error) });
  }

  // 2. Default notification route (Loop 5). Reuses the existing seed (own org scope).
  try {
    const notify = await ensureDefaultNotificationRoute({
      pool: input.pool,
      orgId: input.orgId,
      ntfyTopic: input.ntfyTopic ?? `tanren-org-${input.orgId}`,
    });
    result.notificationRoute = { targetId: notify.target.id, created: notify.created, events: notify.routes.length };
  } catch (error) {
    console.error(`[provision] notification-route seed failed for org ${input.orgId}:`, messageOf(error));
    errors.push({ seed: "notificationRoute", message: messageOf(error) });
  }

  // 3. Issues inbox source. Reuses the existing idempotent seed (its own org scope).
  try {
    const inbox = await ensureIssuesInboxSource({
      pool: input.pool,
      orgId: input.orgId,
      projectId: input.projectId,
      repoUrl: input.repoUrl,
    });
    result.inboxSource = { id: inbox.source.id, created: inbox.created };
  } catch (error) {
    console.error(`[provision] issues-inbox seed failed for project ${input.projectId}:`, messageOf(error));
    errors.push({ seed: "inbox", message: messageOf(error) });
  }

  return result;
}
