<!-- cspell:ignore drizzle datname pgdump -->

# cap-migrations — squash the 94-file migration chain → one baseline

**Phase**: capstone (legacy collapse)
**Node ID**: `cap-migrations`
**Deps**: **ALL 142 consumer nodes merged** (this is the last migration-touching PR)
**Node credit**: **0** until independent audit, full green gates, and merge

## Purpose and boundary

Collapse the entire linear migration chain into a **single baseline**. On current
`main` `db/migrations/` holds **94 `*.sql` files** (`0000_collapsed_baseline.sql` →
`0095_behavior_verdict_evidence.sql`), a **94-entry** `meta/_journal.json`, and **94**
`meta/NNNN_snapshot.json` files. The chain is linear and hand-renumbered — the
coordinator just hand-renumbered 5 files, a recurring pain the chain guarantees. With
**zero users and a single live database baseline**, every intermediate migration is
dead weight: it is never replayed against a real deployed DB (there is none to
preserve), yet it must be kept ordered, snapshot-consistent, and drift-clean forever.
Note `0000_collapsed_baseline.sql` is itself the *residue of the prior v21 collapse* —
94 files re-accreted on top of it. This is the **next, final** squash.

The collapse: replace all 94 files with ONE `0001_baseline.sql` that is the exact live
schema, ONE fresh `0001_snapshot.json`, and a **reset** `_journal.json` (single entry).
The intermediate chain is deleted outright — no `0000_collapsed_baseline` kept "for
history", no compat pointer.

**Boundary:** this node changes ONLY the migration artifacts + the drizzle meta. It
does **not** change any `db/src/schema*.ts` definition (those are already the truth),
any table shape, any RLS policy, any application code. The baseline is a faithful dump
of what the 94-chain already produces — byte-equivalent schema, zero behavior delta.

## The exact surface it collapses

- `db/migrations/0000_collapsed_baseline.sql … 0095_*.sql` — **94 files → 1**
  (`0001_baseline.sql`).
- `db/migrations/meta/_journal.json` — **94 entries → 1**.
- `db/migrations/meta/*_snapshot.json` — **94 snapshots → 1** (`0001_snapshot.json`).

## Mechanics (author against a freshly-migrated DB)

1. Bring up a scratch DB, run the **full existing 94-chain** to the tip (this is the
   source of truth for the baseline body).
2. Author `0001_baseline.sql` = every table, in dependency order, with **FORCE ROW
   LEVEL SECURITY**, every RLS policy, every trigger, every CHECK constraint, every
   partial/unique index, and every seed the chain plants (the `event_types` catalog
   from SP-8 / `0040`/`0042`/`0046`/`0048`/`0055`/`0060`/`0062`/`0068`/`0070`, the
   `DEFAULT_ROUTE_EVENTS` seed, governance tier presets, etc.). Foundation tables never
   FK forward. The dump must reproduce the tip schema exactly — diff it.
3. Regenerate the drizzle snapshot from `db/src/schema*.ts` and reset `_journal.json`
   to the single `0001` entry. Confirm `drizzle-kit` reports **no pending diff**
   (schema-drift clean) against the regenerated snapshot.
4. Delete all 94 old `*.sql`, all 94 old snapshots, and the stale journal.

## Fail-closed invariant (the collapse must weaken no guarantee)

The baseline is **schema-identical** to the 94-chain tip — proven by a byte-level
`pg_dump --schema-only` diff between (a) a DB built from the 94-chain and (b) a DB built
from `0001_baseline.sql`. **Zero diff is the gate.** Every RLS `FORCE` and policy must
survive: the RLS smoke suite (`*.rls.integration.test`) is the ground-truth net — a
dropped policy makes a cross-org read return rows instead of zero, and the suite fails
loud. No table, index, CHECK, trigger, or seed row may silently vanish; a missing seed
surfaces as an `event_types` FK violation on first insert.

## Acceptance test

- A **fresh** empty DB migrated from `0001_baseline.sql` alone comes up clean.
- `pg_dump --schema-only` of that DB == dump of the 94-chain DB (zero diff).
- `just smoke` green (full real-Postgres suite), including **every** `*.rls.integration.test`.
- `drizzle-kit` drift check: no pending migration (snapshot matches `schema*.ts`).
- `just ci` green.

## Size

~1 large generated `0001_baseline.sql` + 1 snapshot + journal; **−94 files**. The SQL
is machine-dumped, not hand-written line-by-line, so the review surface is the *diff
proof* (zero-diff dump) not the raw line count. Justified single-file exception per
orchestration Rule 0: an irreducible foundation artifact.

## CRITICAL sequencing

**Runs LAST, serialized, after all 142 nodes merge.** Migrations are a hard single-owner
barrier (orchestration §4). Because every consumer node that adds a migration lands in
the `0041+` band, this squash can only be authored once the final `NNNN` slot is
claimed and merged — otherwise it races an in-flight migration and the baseline is
stale on arrival. It is the **first** of the capstone series (the other cap-* nodes
delete code the migrations no longer need to describe, but the schema truth must be
frozen first). DANGER: this rewrites the entire migration history — if the zero-diff
proof is skipped, a silently-dropped RLS policy becomes a tenant-isolation hole that
green unit tests will not catch. Only the real-Postgres RLS smoke proves it.
