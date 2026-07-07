-- Codex H3 #11: human-review durable parked state. Adds the `awaiting_review`
-- RunOutcome so a run entering the review-polling stage under
-- `reviewPolicy: "human"` PARKS (durable, worker released) instead of blocking
-- the worker thread in an in-process polling loop. The background prober
-- (`awaitingReviewProber`) reads the PR's review verdict on cadence; on a
-- terminal verdict the run flips back to `halted` + spec `open`, the walker's
-- successor run reads the now-terminal verdict and proceeds to merge.
--
-- Follows the shape of migration 0019 (window-pause auto-resume): the outcome
-- lives on the `runs.outcome` CHECK constraint alongside `window_paused`, so
-- the resume path routes through the same `pausedRunResumeProber` seam.
ALTER TABLE "runs" DROP CONSTRAINT "runs_outcome_check";--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_outcome_check" CHECK ("runs"."outcome" IS NULL OR "runs"."outcome" IN ('ok','halted','escape_hatch_hit','retry_budget_exhausted','convergence_stalled','window_exhausted','window_paused','awaiting_review','cancelled','failed'));
