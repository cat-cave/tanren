CREATE UNIQUE INDEX "specs_triage_provenance_unique" ON "specs" USING btree ("project_id","parent_spec_id","source_finding_ids") WHERE parent_spec_id IS NOT NULL;
