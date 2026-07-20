-- rv-9 durability follow-up: the content-addressed render/response captures a verdict
-- produced (verification_artifacts, addressed by CAS digest) were reachable only through
-- the ephemeral AcceptanceBehaviorResult.evidenceLinkRefs — nothing on the durable verdict
-- ledger referenced them, so a later proof could not discover a verdict's captures and the
-- CAS rows read as orphans.  This table is the DURABLE verdict -> capture linkage: given a
-- verdict id alone, a proof resolves each capture's verification-artifact id + CAS address.
--
-- The FK to verification_artifacts rejects any link whose artifact row is absent (no orphan
-- linkage can be recorded), and the PK collapses identical captures within one verdict.  It
-- is append-only: rows are immutable once written (an evidence link is a historical fact).
CREATE TABLE "behavior_verdict_evidence" (
  "org_id" text NOT NULL,
  "verdict_id" text NOT NULL,
  "ordinal" integer NOT NULL,
  "verification_artifact_id" text NOT NULL,
  "cas_digest" text NOT NULL,
  "media_type" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "behavior_verdict_evidence_pk" PRIMARY KEY("org_id", "verdict_id", "verification_artifact_id"),
  CONSTRAINT "behavior_verdict_evidence_ordinal_check" CHECK ("ordinal" >= 0),
  CONSTRAINT "behavior_verdict_evidence_cas_digest_check" CHECK ("cas_digest" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "behavior_verdict_evidence_verdict_fk" FOREIGN KEY ("org_id", "verdict_id") REFERENCES "behavior_verdicts"("org_id", "id"),
  CONSTRAINT "behavior_verdict_evidence_artifact_fk" FOREIGN KEY ("org_id", "verification_artifact_id") REFERENCES "verification_artifacts"("org_id", "id")
);
--> statement-breakpoint
CREATE INDEX "behavior_verdict_evidence_org_verdict" ON "behavior_verdict_evidence" USING btree ("org_id", "verdict_id");
--> statement-breakpoint
CREATE INDEX "behavior_verdict_evidence_org_artifact" ON "behavior_verdict_evidence" USING btree ("org_id", "verification_artifact_id");
--> statement-breakpoint
ALTER TABLE "behavior_verdict_evidence" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "behavior_verdict_evidence" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "behavior_verdict_evidence" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
CREATE FUNCTION "enforce_behavior_verdict_evidence_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable (append-only): % rejected', TG_TABLE_NAME, TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "behavior_verdict_evidence_immutable"
BEFORE UPDATE OR DELETE ON "behavior_verdict_evidence"
FOR EACH ROW EXECUTE FUNCTION "enforce_behavior_verdict_evidence_immutable"();
