-- mq-7: add the code-GENERATION epoch (artifact_digest) to behavior_flake_quarantines.
-- rv-17 (migration 0085) created this table and may ALREADY hold quarantine/release rows with NO
-- epoch, so this migration must be SAFE ON A NON-EMPTY table: add the column NULLABLE, BACKFILL
-- every pre-existing row with a LEGACY sentinel epoch, then SET NOT NULL. A bare
-- `ADD COLUMN epoch text NOT NULL` (no default, no backfill) FAILS on apply the moment any row
-- exists.
--
-- The sentinel `sha256:` + 64 zeroes (a) satisfies the `^sha256:[0-9a-f]{64}$` CHECK below and
-- (b) is a recognizable "legacy / unproven, pre-mq-7" marker that can NEVER equal a real
-- artifact_digest (no content hashes to all-zeroes). So any pre-existing quarantine is stamped
-- with an epoch that will differ from EVERY future observed generation — forcing it to
-- RE-EVALUATE against that generation's own verdicts on the next observation, exactly the
-- epoch-aware anti-masking semantics mq-7 enforces (a stale quarantine can mask nothing).
--
-- FORCE ROW LEVEL SECURITY persists from 0085 (this migration does not touch RLS).
ALTER TABLE "behavior_flake_quarantines" ADD COLUMN "epoch" text;--> statement-breakpoint
UPDATE "behavior_flake_quarantines"
   SET "epoch" = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
 WHERE "epoch" IS NULL;--> statement-breakpoint
ALTER TABLE "behavior_flake_quarantines" ALTER COLUMN "epoch" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "behavior_flake_quarantines" ADD CONSTRAINT "behavior_flake_quarantines_epoch_check" CHECK ("behavior_flake_quarantines"."epoch" ~ '^sha256:[0-9a-f]{64}$');
