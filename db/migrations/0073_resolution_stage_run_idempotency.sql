-- A crash after a stage writes its verification row but before the job settles
-- must not permit a second stage receipt for the same durable job/stage pair.
CREATE UNIQUE INDEX "behavior_verification_runs_resolution_job_stage_unique"
  ON "behavior_verification_runs" USING btree ("resolution_job_id", "stage");
