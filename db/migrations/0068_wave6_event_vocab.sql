-- Mission-complete WAVE-6 shared event-vocabulary freeze. These names are
-- registered before their owning lanes emit them; values mirror the generated
-- db/src/eventTypesSeed.ts catalog. behavior.effect.observed is intentionally
-- idempotent because the runtime vocabulary already owns its existing contract.
INSERT INTO "event_types" ("name", "default_severity") VALUES
  ('fixture.lease.acquired', 'info'),
  ('fixture.lease.released', 'info'),
  ('fixture.lease.expired', 'warn'),
  ('fixture.lease.cleanup_failed', 'warn'),
  ('behavior.effect.observed', 'info'),
  ('behavior.effect.missing', 'warn'),
  ('behavior.effect.duplicate', 'warn'),
  ('observer.watermark.advanced', 'info'),
  ('observer.inconclusive_external', 'warn'),
  ('integration.proof_unit.recorded', 'info'),
  ('integration.proof_unit.reused', 'info'),
  ('integration.proof_root.composed', 'info'),
  ('integration.proof.invalidated', 'warn'),
  ('repository.visibility.observed', 'info'),
  ('repository.visibility.mismatch', 'warn'),
  ('governance.visibility.enforced', 'info')
ON CONFLICT ("name") DO NOTHING;
