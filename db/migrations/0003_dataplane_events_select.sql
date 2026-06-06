-- The merge-queue recovery pass reads native queue signals from `events` while
-- running as the de-privileged worker role under `runWithOrgScope`. Keep data-plane
-- event writes denied, but allow org-scoped reads so RLS, not a table ACL error,
-- decides visibility.
GRANT SELECT ON TABLE events TO tanren_dataplane;--> statement-breakpoint
