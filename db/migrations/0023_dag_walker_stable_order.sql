CREATE INDEX "specs_project_created" ON "specs" USING btree ("project_id","created_at","spec_id");
