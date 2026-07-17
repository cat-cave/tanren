-- Mission-complete WAVE-2 event-vocabulary FREEZE seed. Adds the 4 new names the
-- wave's governance node (gv-7) emits to the platform-global `event_types`
-- catalog:
--   * the immutable policy-revision lifecycle — governance.policy.created,
--     .compiled, .activated (the deterministic compiler's revision lifecycle); and
--   * integration.proof.invalidated — the policy-drift (TOCTOU) / stacked-base-shift
--     proof-invalidation event (governance spec §7 F3 + "Policy drift/TOCTOU"), NOT
--     one of the in-3 integration.* names already frozen in 0046.
--
-- Seeded BEFORE any consumer emits, so the events.event_type FK domain covers
-- every frozen name. Mirrors db/src/eventTypesSeed.ts (regenerated from the Zod
-- EventRegistry + eventDefaultSeverity via `codegen:events`). ON CONFLICT DO
-- NOTHING keeps re-application idempotent, matching migrations 0042 and 0046.
INSERT INTO "event_types" ("name", "default_severity") VALUES
  ('governance.policy.activated', 'info'),
  ('governance.policy.compiled', 'info'),
  ('governance.policy.created', 'info'),
  ('integration.proof.invalidated', 'warn')
ON CONFLICT ("name") DO NOTHING;
