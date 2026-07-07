-- H2 BLOCKING (audit finding): unify design contracts on project-scope.
--
-- Migration 0026 added a `mode` column + keyed the head on
-- `(project_id, mode, version)` to give per-writer-prompt-mode contract heads.
-- But no code path ever wrote a row at `specialize_seed` — `persistDesignContract`
-- (the only writer) lands the derive-time contract at `DEFAULT_SPEC_MODE`
-- (`from_scratch`). Scaffold / build / deploy specs run under `specialize_seed`
-- and their `getLatestState(project, 'specialize_seed')` lookup returned
-- `{ kind: 'absent' }` — so WS-D2 (writer design block) + WS-D4 (design oracle)
-- silently no-op'd for exactly the three specs the greenfield loop targets.
--
-- The DesignContract describes PRODUCT identity (behaviors, personas, dimensions)
-- which is shared across every spec type in the same project. There is exactly
-- ONE product-level contract per project. Drop the mode dimension and restore
-- the single per-project head lookup.
--
-- The writer prompt's mode-awareness remains where it belongs: in
-- `subtaskWriterPrompt.ts` + `answererPrompts.ts` + `designOraclePrompt.ts` tail
-- blocks (the v64 load-bearing fix). This migration ONLY collapses the
-- persistence-layer mode-keying that was silently broken.
--
-- SAFETY: only `from_scratch` rows were ever persisted (audit finding), so
-- collapsing on `(project_id, version)` preserves every row without collision.
ALTER TABLE "design_contracts" DROP CONSTRAINT "design_contracts_mode_check";--> statement-breakpoint
DROP INDEX "design_contracts_project_mode_version_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "design_contracts_project_version_unique" ON "design_contracts" USING btree ("project_id","version");--> statement-breakpoint
ALTER TABLE "design_contracts" DROP COLUMN "mode";
