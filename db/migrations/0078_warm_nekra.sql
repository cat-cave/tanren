CREATE TABLE "resolution_proofs" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"issue_loop_id" text NOT NULL,
	"resolution_job_id" text NOT NULL,
	"resolution_decision_id" text NOT NULL,
	"terminal" text NOT NULL,
	"proof_hash" text NOT NULL,
	"proof_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resolution_proofs_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "resolution_proofs_terminal_check" CHECK ("resolution_proofs"."terminal" IN ('authorized_verified_closed','blocked')),
	CONSTRAINT "resolution_proofs_proof_hash_check" CHECK ("resolution_proofs"."proof_hash" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "resolution_proofs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "resolution_proofs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "resolution_proofs" ADD CONSTRAINT "resolution_proofs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolution_proofs" ADD CONSTRAINT "resolution_proofs_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolution_proofs" ADD CONSTRAINT "resolution_proofs_issue_loop_fk" FOREIGN KEY ("org_id","issue_loop_id") REFERENCES "public"."issue_loops"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolution_proofs" ADD CONSTRAINT "resolution_proofs_resolution_job_fk" FOREIGN KEY ("org_id","resolution_job_id") REFERENCES "public"."resolution_jobs"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolution_proofs" ADD CONSTRAINT "resolution_proofs_resolution_decision_fk" FOREIGN KEY ("org_id","resolution_decision_id") REFERENCES "public"."resolution_decisions"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resolution_proofs_org_id" ON "resolution_proofs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "resolution_proofs_org_project_loop" ON "resolution_proofs" USING btree ("org_id","project_id","issue_loop_id");--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "resolution_proofs" AS PERMISSIVE FOR ALL TO public USING ("resolution_proofs"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("resolution_proofs"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE FUNCTION "enforce_resolution_proofs_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'resolution_proofs rows are immutable (append-only sealed proofs): % rejected', TG_OP;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "resolution_proofs_immutable"
BEFORE UPDATE OR DELETE ON "resolution_proofs"
FOR EACH ROW EXECUTE FUNCTION "enforce_resolution_proofs_immutable"();
