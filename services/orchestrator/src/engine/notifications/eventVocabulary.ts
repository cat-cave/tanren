import { listEventNames } from "../events/index.js";
import { eventDefaultSeverity } from "./eventDefaultSeverity.js";
import type { Severity } from "./schemas.js";

// The platform-global event vocabulary catalog (SP-8). This is the SINGLE
// source the event codegen reads to emit both the committed seed mirror
// (db/src/eventTypesSeed.ts) and the `event_types` seed SQL (migration 0040).
//
// A seed row pairs an event `name` with its `defaultSeverity`. The catalog is
// the union of:
//   1. the CURRENT vocabulary — every name in the Zod `EventRegistry`
//      (via `listEventNames()`), each carrying its `eventDefaultSeverity`; and
//   2. the RETAINED-HISTORICAL vocabulary — names that an older
//      `events_event_type_check` CHECK constraint admitted (so historical rows
//      may still carry them) but the current registry no longer emits.
//
// Both are seeded BEFORE the `events.event_type` / `notification_routes.event_name`
// foreign keys are added (migration 0040), so the FK domain covers every value
// any historical row — or a retained partial-index predicate such as
// `events_task_terminal_unique`'s `'task.cancelled'` arm — can hold. The FK must
// never point at an empty `event_types`.

/** @public */
export interface EventTypeSeedRow {
  readonly name: string;
  readonly defaultSeverity: Severity;
}

// Names dropped from the live `EventRegistry` but retained in the catalog so the
// FK never rejects a pre-existing row. `template.*` are the creation/build/
// selection meta-flow collapsed into the fragment-only F2 path (PR-F #693);
// `job.dead_lettered` is the attempt-cap dead-letter removed by the
// timeout-eradication doctrine; `task.cancelled` is referenced by the live
// `events_task_terminal_unique` partial-index predicate but was never emitted
// through the typed append API. Severities are cosmetic here (these are not
// emitted) but kept honest: failure/exhaustion arms `warn`, the rest `info`.
/** @public */
export const RETAINED_HISTORICAL_EVENTS: readonly EventTypeSeedRow[] = [
  { name: "job.dead_lettered", defaultSeverity: "warn" },
  { name: "task.cancelled", defaultSeverity: "info" },
  { name: "template.build.recovered", defaultSeverity: "info" },
  { name: "template.build.recovery_exhausted", defaultSeverity: "warn" },
  { name: "template.creation.failed", defaultSeverity: "warn" },
  { name: "template.creation.published", defaultSeverity: "info" },
  { name: "template.creation.started", defaultSeverity: "info" },
  { name: "template.creation.upgrade_skipped", defaultSeverity: "info" },
  { name: "template.creation.upgraded", defaultSeverity: "info" },
  { name: "template.registered", defaultSeverity: "info" },
  { name: "template.selection.no_match", defaultSeverity: "info" },
  { name: "template.status_changed", defaultSeverity: "info" },
];

// The complete `event_types` seed — current registry ∪ retained-historical —
// sorted by name for a stable, diff-friendly emission. Every name is unique
// across the two sets (retained-historical is disjoint from the registry by
// construction; `assertVocabularyDisjoint` guards that at generation time).
/** @public */
export function eventTypeVocabulary(): EventTypeSeedRow[] {
  const current: EventTypeSeedRow[] = listEventNames().map((name) => ({
    name,
    defaultSeverity: eventDefaultSeverity[name],
  }));
  const rows = [...current, ...RETAINED_HISTORICAL_EVENTS];
  assertVocabularyDisjoint(rows);
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function assertVocabularyDisjoint(rows: readonly EventTypeSeedRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.name)) {
      throw new Error(
        `event vocabulary collision: "${row.name}" appears in both the live EventRegistry and RETAINED_HISTORICAL_EVENTS`,
      );
    }
    seen.add(row.name);
  }
}
