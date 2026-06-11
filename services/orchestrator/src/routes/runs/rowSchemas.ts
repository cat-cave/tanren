// Trust-at-boundary pg-row schemas (audit RC-6). The route loaders read raw
// pg rows whose every column is `unknown` (the driver hands back `any`/`unknown`
// shaped values). Historically the timestamp columns were type-laundered with a
// bare `as Date` cast — a lie that a column-type migration or a NULL silently
// turns into garbage handed to a consumer that trusts the `Date` type.
//
// These Zod schemas decode the raw rows AT THE READ SEAM. The timestamp fields
// use `z.coerce.date()` (pg returns a real Date for a timestamptz, but coerce
// also accepts an ISO string, so the boundary is robust to either driver mode),
// nullable columns stay nullable, and a malformed row (bad timestamp, missing
// required field) THROWS at `.parse(...)` rather than laundering past the type
// system. The parsed value is already the narrowed type — consumers drop the
// `as Date` cast entirely.
//
// Each schema is `.passthrough()` so it validates ONLY the timestamp/id columns
// the loader narrows here; the remaining columns are decoded by the existing
// contract `.parse(...)` (which does the String()/enum coercion). The split is
// deliberate: this module owns the cast that was silently wrong; the contract
// module owns the field-shape it already validated.

import { z } from "zod";

// The scalar-column coercion (`scalarText`/`scalarTextOr`) lives in the neutral
// pg-boundary util so engine/worker readers can share it; re-exported here for
// the route loaders that already import from this module.
export { scalarText, scalarTextOr } from "../../engine/data/scalarText.js";

// --- Run summary / list rows ----------------------------------------------
// `started_at` is NOT NULL in the schema (a run always has a start); `ended_at`
// is null until the run finishes.
export const RawRunSummaryRowSchema = z
  .object({
    started_at: z.coerce.date(),
    ended_at: z.coerce.date().nullable(),
  })
  .passthrough();

// --- Task timeline rows ----------------------------------------------------
// Both task timestamps are nullable: a task may be queued (no start) or still
// running (no end).
export const RawTaskRowSchema = z
  .object({
    started_at: z.coerce.date().nullable(),
    ended_at: z.coerce.date().nullable(),
  })
  .passthrough();

// --- Event rows ------------------------------------------------------------
// `ts` is the event timestamp (NOT NULL); `id` is the bigserial cursor key,
// which pg may hand back as a number or a string — accept either, the contract
// row schema narrows it again.
export const RawEventRowSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    ts: z.coerce.date(),
  })
  .passthrough();

// --- Cost rows -------------------------------------------------------------
// `recorded_at` is the cost write timestamp (NOT NULL); `id` mirrors the event
// cursor-key shape.
export const RawCostRowSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    recorded_at: z.coerce.date(),
  })
  .passthrough();
