-- Terminal events per task are AT MOST ONCE (task #40 Class B — RPC
-- phantom-write idempotency). The atomic `applyUpdateTaskWithEvent` helper
-- uses `ON CONFLICT DO NOTHING` against this partial unique index, so a
-- server-side COMMIT whose HTTP response was dropped + a data-plane retry
-- through the finalize-guard catch does NOT write a contradictory second
-- terminal event of the same type. (task_id, event_type) is the pair so a
-- future row-state cycle that lands a different terminal type stays unblocked;
-- same-type re-inserts dedupe.
CREATE UNIQUE INDEX "events_task_terminal_unique" ON "events" USING btree ("task_id","event_type") WHERE "events"."event_type" IN ('task.completed', 'task.failed', 'task.cancelled');
