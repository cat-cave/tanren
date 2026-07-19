import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { organizations, projects } from "./schemaCore.js";
import { integrationOrgIsolationPolicy } from "./schemaIntegrationPolicy.js";

const digestPattern = sql.raw("'^sha256:[0-9a-f]{64}$'");

// rv-17: flake classification + quarantine governance. When a behavior's recorded
// acceptance verdicts show REAL non-determinism — the SAME behavior_revision against
// the SAME context/artifact records BOTH a `passed` and a decisive product failure —
// it is classified FLAKY (flakeClassification.ts). A flaky behavior may then be put
// into QUARANTINE: an append-only governance transition ledger (who/why/when +
// the conflicting-verdict evidence). Un-quarantine is an explicit `release` transition;
// the CURRENT state of a behavior is its LATEST transition by (created_at, id).
//
// DECISIVE ANTI-LAUNDERING (the crux, enforced at the DB): a `quarantine` transition
// can ONLY carry gate_effect = 'excluded_from_green' — NEVER a `passed`/green effect —
// and can ONLY be justified by classification = 'flaky' (a real observed conflict, not
// a guess). So a quarantine record is physically incapable of asserting a green effect.
// LIVE consumer today: rv-16 regression bisection refuses to name a culprit from a
// quarantined behavior (resolutionDagWalker → recordRegressionBisections). The
// behaviorQuarantineGovernance.ts gate-contribution resolver is READY but NOT yet consumed by
// the native MergeAuthority — that binding is pending (GateProofBundleV2.runtime_behavior has no
// production producer/consumer yet). A `release` transition restores the behavior.
export const behaviorQuarantines = pgTable(
  "behavior_flake_quarantines",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    id: text("id").notNull(),
    behaviorRevisionId: text("behavior_revision_id").notNull(),
    // The governance action: put INTO quarantine, or RELEASE back to the ordinary gate.
    transition: text("transition").notNull(),
    // The quarantine's effect on the gate. A `quarantine` is 'excluded_from_green' — it can
    // NEVER be a green/passed effect (that is the laundering this node exists to forbid); a
    // `release` is 'restored'. The shape CHECK below binds the pair.
    gateEffect: text("gate_effect").notNull(),
    // The flake classification that justifies the transition. A `quarantine` REQUIRES 'flaky'
    // (a real recorded conflict) — an insufficient/stable/consistent classification cannot
    // be laundered into a quarantine.
    classification: text("classification").notNull(),
    reason: text("reason").notNull(),
    actor: text("actor").notNull(),
    // The conflicting recorded verdicts (ids + outcomes) that evidence the classification.
    evidence: jsonb("evidence")
      .$type<readonly { readonly verdictId: string; readonly outcome: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // The runtime_behavior_context_hash the classification was observed over.
    contextHash: text("context_hash").notNull(),
    // mq-7 EPOCH — the code GENERATION marker the transition was proven in: the
    // artifact_digest whose recorded verdicts the classification read. A quarantine speaks
    // ONLY for its epoch; a later generation (a new artifact_digest) is a fresh epoch that
    // must RE-PROVE the flake or the quarantine is released. This is what forbids a
    // quarantine from silently persisting across generations and masking a real regression:
    // when a new epoch instead shows a consistent failure, the quarantine is released
    // (`release`, classification 'consistent_failure') so the regression reaches the gate.
    epoch: text("epoch").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.id] }),
    index("behavior_flake_quarantines_org_id").on(table.orgId),
    index("behavior_flake_quarantines_behavior").on(table.orgId, table.projectId, table.behaviorRevisionId),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.projectId],
      name: "behavior_flake_quarantines_project_fk",
    }),
    check("behavior_flake_quarantines_transition_check", sql`${table.transition} IN ('quarantine','release')`),
    check(
      "behavior_flake_quarantines_gate_effect_check",
      sql`${table.gateEffect} IN ('excluded_from_green','restored')`,
    ),
    check(
      "behavior_flake_quarantines_classification_check",
      sql`${table.classification} IN ('flaky','consistent_failure','stable','insufficient_observation')`,
    ),
    check("behavior_flake_quarantines_context_hash_check", sql`${table.contextHash} ~ ${digestPattern}`),
    // mq-7: the epoch is an artifact_digest — a content-addressed generation marker.
    check("behavior_flake_quarantines_epoch_check", sql`${table.epoch} ~ ${digestPattern}`),
    // ANTI-LAUNDERING shape CHECK: a quarantine can ONLY be 'excluded_from_green' + 'flaky'
    // (never a green effect, never an unjustified classification); a release is 'restored'.
    check(
      "behavior_flake_quarantines_transition_shape_check",
      sql`(
        ${table.transition} = 'quarantine'
          AND ${table.gateEffect} = 'excluded_from_green'
          AND ${table.classification} = 'flaky'
      ) OR (
        ${table.transition} = 'release'
          AND ${table.gateEffect} = 'restored'
      )`,
    ),
    integrationOrgIsolationPolicy(table.orgId),
  ],
).enableRLS();
