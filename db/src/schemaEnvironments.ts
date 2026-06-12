// Environment management (environment-management.md §3 Layer 4 + §5 + §7 P3) — the
// ENVIRONMENT REGISTRY table, the env-layer counterpart of the code-template
// registry (`templates` / schemaTemplates.ts). A row is a VALIDATED, fast-booting
// runner-image keyed by its CONTENT HASH (`env_key = sha256(base_digest ‖ mise.lock
// [‖ flake.lock])`), so a workspace resolves a runner image by what its toolchain
// IS, not a hardcoded default. This is the durable OBJECT P3 writes/reads
// (registration + `env_key` resolution); P4 adds JIT build-on-no-match.
//
// SCOPING — org-scoped with an OFFICIAL/cat-cave shared tier, byte-identical to
// `templates`. Every environment is OWNED by an org (`org_id`); a private org env
// stays visible only to that org under deny-by-default RLS. An OFFICIAL env (status
// `official`, the reviewed cat-cave tier) is owned by the platform org but READABLE
// cross-org — the migration's RLS policy admits a row when `org_id = current_org_id`
// OR the row is `official`, so every org can RESOLVE from the shared catalogue while
// WRITES stay org-scoped (WITH CHECK keeps `org_id = current_org_id`). See the
// environments RLS block in the migration for the exact policy.
//
// STACK-AGNOSTIC: `capabilities` is a free jsonb toolchain summary (the declared
// tools — e.g. `{ "tools": { "node": "22", "python": "3.13" } }`); `provenance`
// records the base_digest + lockfile hashes + the run that created it; no stack is
// encoded in the table. `channel` is mirrored into its own column so selection +
// the refresh scheduler filter without parsing the jsonb. `env_key` is UNIQUE per
// org (the content key resolution looks up by) — a re-register of the same content
// is a no-op-or-update, never a duplicate.

import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./schemaCore.js";

export const environments = pgTable(
  "environments",
  {
    id: text("id").primaryKey(),
    // The owning org. A private org environment is visible only to this org under
    // RLS; an `official` environment is owned by the platform org but the RLS
    // policy makes it cross-org readable (see the migration's environments policy).
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id),
    // The CONTENT HASH that IDENTIFIES this environment image:
    //   env_key = sha256(base_digest ‖ mise.lock [‖ flake.lock])
    // (computeEnvKey, env_key.ts). Resolution looks up an environment BY this key,
    // so it is UNIQUE per org (the unique index below). Same toolchain content →
    // same key → the same validated image is reused; a different lockfile → a
    // different key → a no-match (P3 falls back to the golden base; P4 JIT-builds).
    envKey: text("env_key").notNull(),
    // The resolved runner image — the registry image digest/ref a workspace seeds
    // from when it resolves THIS env_key. Opaque to Tanren (a registry ref like
    // `registry/tanren-env@sha256:…`); the allocator pulls it.
    imageRef: text("image_ref").notNull(),
    // The TOOLCHAIN SUMMARY this environment bakes (free jsonb — e.g. the declared
    // `mise` tool→version map). STACK-AGNOSTIC: a node env, a python env, a Fortran
    // env all describe their tools here; no stack is privileged. Capability queries
    // (listByCapabilities) read out of this jsonb.
    capabilities: jsonb("capabilities").notNull(),
    // The maintenance channel (`lts` | `nightly`), mirrored from the env spec so the
    // scheduler + selection filter without parsing jsonb. Mirrors `templates.channel`.
    channel: text("channel").notNull().default("lts"),
    // Registry lifecycle tier (environment-management.md §4), mirroring `templates`:
    //   draft     — registered, not yet validated (no validation_proof).
    //   validated — the validation harness (P4) proved it (positive smoke + negative
    //               controls): every declared tool resolves to its locked version and
    //               an undeclared tool is absent (isolation). Private/org tier.
    //   official  — the reviewed cat-cave shared tier (cross-org readable).
    // Resolution only RESOLVES from `validated`/`official` rows (a draft is never seeded).
    status: text("status").notNull().default("draft"),
    // Durable PROVENANCE evidence (free jsonb): the base_digest (P2's golden-image
    // content digest the env_key was computed over), the lockfile hashes, and the
    // run that created the env (`createdByRunId`). Grounds the env, not hand-waved.
    provenance: jsonb("provenance").notNull(),
    // The negative-control + positive-smoke proof (the env-image counterpart of
    // `TemplateValidationProof`), or NULL when unvalidated (a draft env). Produced by
    // the validation harness in P4; NULL is a LOUD first-class "not yet proven" state.
    validationProof: jsonb("validation_proof"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("environments_status_check", sql`${table.status} IN ('draft','validated','official')`),
    check("environments_channel_check", sql`${table.channel} IN ('lts','nightly')`),
    // The content-key lookup is per-org UNIQUE — resolution reads ONE row by
    // (org_id, env_key); a re-register of the same content updates rather than
    // duplicates. The official cross-org tier owns rows under the platform org, so
    // per-org uniqueness still admits an org's private env that hashes identically.
    uniqueIndex("environments_org_env_key").on(table.orgId, table.envKey),
    index("environments_org_id").on(table.orgId),
    index("environments_status").on(table.status),
    index("environments_channel").on(table.channel),
  ],
);
