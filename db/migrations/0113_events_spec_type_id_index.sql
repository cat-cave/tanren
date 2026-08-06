CREATE INDEX "events_spec_type_id" ON "events" USING btree ("spec_id","event_type","id");
