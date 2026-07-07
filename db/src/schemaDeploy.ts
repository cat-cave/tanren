// Deploy-adapter persistence — the `manual_deploy_attestations` table.
//
// Codex H3 Surface 7 finding #20 / #21: the `manual_external` DeployAdapter used
// to write the operator's attestation to a process-local `Map`
// (`InMemoryManualAttestationStore`) AND `deploy()` returned `state: "attested"`
// straight off the grant metadata — a rubber-stamp with no real operator
// confirmation. A restart lost every attestation, and `verify()` silently
// accepted a URL that no operator had actually confirmed was live. Both bugs
// are BLOCKING on a live-run flow: a `manual_external` deploy that "succeeded"
// yielded zero durable evidence and no genuine confirmation.
//
// This table is the DURABLE attestation record + the OPERATOR CONFIRMATION
// ledger. `deploy()` writes `pending_manual_confirmation` (never a rubber-stamped
// "attested"); an operator confirms out-of-band via the API
// (POST /orgs/:orgId/projects/:projectId/deploys/:deploymentId/confirm), which
// records `confirmed_at` + `confirmed_by` and flips `state` to `confirmed`; then
// `verify()` reads this row + runs the URL smoke probe and only then returns
// `verified`. Missing operator confirmation → `verify()` fails LOUD (never a
// silent verified).
//
// SCOPING — org-scoped, deny-by-default RLS (3a direct-org_id, like
// `post_merge_issue_claims` / `merge_queue` / `candidates`). A query off the
// org-scoped client sees ZERO rows; the RLS policy in the migration mirrors the
// baseline 3a direct-org_id policy with NO cross-org exception (an attestation
// is private per-tenant delivery state). Fail-closed, no empty-on-missing-org
// fallback.
//
// NEVER SECRET — every column is non-secret (a URL + a repo/git-ref + an org id
// + an operator user id + timestamps). The confirmation itself carries no
// credential material.

import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizations, projects } from "./schemaCore.js";

export const manualDeployAttestations = pgTable(
  "manual_deploy_attestations",
  {
    // The deployment id the adapter minted when `deploy()` ran (the
    // `manual:${appId}@${source.ref}` handle every other adapter surface reads).
    // A PRIMARY KEY: the id is stable per (app, source ref) pair, and a
    // re-record for the same deployment idempotently overwrites the row.
    deploymentId: text("deployment_id").primaryKey(),
    // The tenant root (RLS 3a direct-org_id). A query off the org-scoped client
    // sees ZERO rows; fail-closed, no empty-on-missing-org fallback.
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    // The project the deploy belongs to. An attestation always lives inside a
    // project (the operator confirmation is org-admin over that project).
    projectId: text("project_id")
      .notNull()
      .references(() => projects.projectId),
    // The deploy app/project id the release targets (the deployRef's appId).
    appId: text("app_id").notNull(),
    // The merged source the operator claims to have deployed. Both sides are
    // non-secret (a `owner/name` slug + a git ref) and are the immutable proof
    // handle a later `verify()` re-keys the confirmation to.
    sourceRepo: text("source_repo").notNull(),
    sourceRef: text("source_ref").notNull(),
    // The operator-declared target URL + surface kind captured from the grant
    // metadata at `deploy()` time. NON-SECRET (a public URL); `verify()` probes
    // this URL for reachability once confirmation has landed.
    url: text("url").notNull(),
    surfaceKind: text("surface_kind").notNull(),
    // The confirmation LIFECYCLE:
    //   pending_manual_confirmation — `deploy()` recorded the attestation; the
    //     adapter is waiting on an operator confirmation. `verify()` in this
    //     state FAILS LOUD ("pending operator confirmation") — never a silent
    //     verified.
    //   confirmed                   — an operator confirmed out-of-band via the
    //     confirmation route; `confirmed_at` + `confirmed_by` are set; `verify()`
    //     may now run the URL smoke probe + return `verified`.
    state: text("state").notNull().default("pending_manual_confirmation"),
    // When `deploy()` recorded the attestation (the pending-manual-confirmation
    // moment). NOT-NULL — the row cannot exist without a record moment.
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    // When an operator confirmed the deploy. NULL while pending; set when the
    // confirmation route flips state to `confirmed`. Paired with `confirmed_by`
    // — both null or both set (the state-shape check below enforces).
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    // The user id of the confirming operator. NON-SECRET (an internal id).
    // NULL while pending; set with `confirmed_at`.
    confirmedBy: text("confirmed_by"),
  },
  (table) => [
    // Enum-like state check: a row is either awaiting confirmation or confirmed.
    // The "verified" state is a RUNTIME derivation from `confirmed` + a URL
    // smoke probe — it is NOT persisted (a URL that stops answering next week
    // does not un-confirm the operator's action, so persisting it would lie).
    check(
      "manual_deploy_attestations_state_check",
      sql`${table.state} IN ('pending_manual_confirmation', 'confirmed')`,
    ),
    check("manual_deploy_attestations_surface_kind_check", sql`${table.surfaceKind} IN ('web_url', 'download')`),
    // State-shape check: pending ⇒ both confirmation columns null; confirmed ⇒
    // both set. A row is never half-confirmed (a set `confirmed_at` with no
    // `confirmed_by` would leave the audit trail illegible).
    check(
      "manual_deploy_attestations_confirmation_shape_check",
      sql`(${table.state} = 'pending_manual_confirmation' AND ${table.confirmedAt} IS NULL AND ${table.confirmedBy} IS NULL)
          OR (${table.state} = 'confirmed' AND ${table.confirmedAt} IS NOT NULL AND ${table.confirmedBy} IS NOT NULL)`,
    ),
    // The hot org/project scans (list attestations for a project / for an org).
    index("manual_deploy_attestations_org_id").on(table.orgId),
    index("manual_deploy_attestations_org_project").on(table.orgId, table.projectId),
  ],
);
