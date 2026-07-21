import type pg from "pg";
import { QueueWindowV1Schema, type QueueWindowV1 } from "./queuePolicy.js";

type ScopedClient = pg.PoolClient;

interface StoredQueueWindow {
  name: string;
  kind: "allow" | "blackout";
  timezone: string;
  target_branch: string | null;
  intervals: unknown;
}

export interface ActiveQueueWindows {
  readonly allow: ReadonlySet<string>;
  readonly blackout: boolean;
  readonly malformed: boolean;
}

/** Load candidate windows, then evaluate recurring local intervals in their IANA zone. */
export async function activeQueueWindows(
  client: ScopedClient,
  orgId: string,
  policyId: string,
  projectId: string,
  targetBranch: string,
  now = new Date(),
): Promise<ActiveQueueWindows> {
  const result = await client.query<StoredQueueWindow>(
    `SELECT w.name, w.kind, w.timezone, w.target_branch, w.intervals
       FROM merge_queue_windows w
      WHERE w.org_id = $1 AND w.policy_id = $2 AND w.project_id = $3
        AND (w.target_branch IS NULL OR w.target_branch = $4)`,
    [orgId, policyId, projectId, targetBranch],
  );
  const allow = new Set<string>();
  let blackout = false;
  let malformed = false;
  for (const row of result.rows) {
    const window = QueueWindowV1Schema.safeParse({
      schemaVersion: "queue_window.v1",
      name: row.name,
      kind: row.kind,
      timezone: row.timezone,
      scope: { projectId, ...(row.target_branch === null ? {} : { targetBranch: row.target_branch }) },
      intervals: row.intervals,
    });
    if (!window.success) {
      malformed = true;
      continue;
    }
    if (!isQueueWindowActiveAt(window.data, now)) continue;
    if (window.data.kind === "allow") allow.add(window.data.name);
    else blackout = true;
  }
  return { allow, blackout, malformed };
}

/** Evaluate absolute or recurring local intervals without treating timezone as display metadata. */
export function isQueueWindowActiveAt(window: QueueWindowV1, now: Date): boolean {
  return window.intervals.some((interval) => {
    if ("startsAt" in interval) {
      const startsAt = Date.parse(interval.startsAt);
      const endsAt = Date.parse(interval.endsAt);
      return startsAt <= now.getTime() && now.getTime() < endsAt;
    }
    return isLocalIntervalActive(interval, window.timezone, now);
  });
}

function isLocalIntervalActive(
  interval: Extract<QueueWindowV1["intervals"][number], { localStart: string }>,
  timezone: string,
  now: Date,
): boolean {
  const local = localClock(timezone, now);
  const start = minutes(interval.localStart);
  const end = minutes(interval.localEnd);
  const days = interval.daysOfWeek;
  if (start < end) return isSelectedDay(local.weekday, days) && local.minutes >= start && local.minutes < end;
  if (local.minutes >= start) return isSelectedDay(local.weekday, days);
  return local.minutes < end && isSelectedDay(previousWeekday(local.weekday), days);
}

function localClock(timezone: string, now: Date): { weekday: number; minutes: number } {
  const fields = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => fields.find((field) => field.type === type)?.value;
  const weekday = weekdayNumber(value("weekday"));
  const hour = Number(value("hour"));
  const minute = Number(value("minute"));
  if (weekday === undefined || !Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error("could not resolve local queue window time");
  }
  return { weekday, minutes: (hour === 24 ? 0 : hour) * 60 + minute };
}

function weekdayNumber(value: string | undefined): number | undefined {
  return new Map([
    ["Mon", 1],
    ["Tue", 2],
    ["Wed", 3],
    ["Thu", 4],
    ["Fri", 5],
    ["Sat", 6],
    ["Sun", 7],
  ]).get(value ?? "");
}

function minutes(value: string): number {
  const [hour, minute] = value.split(":");
  return Number(hour) * 60 + Number(minute);
}

function previousWeekday(weekday: number): number {
  return weekday === 1 ? 7 : weekday - 1;
}

function isSelectedDay(weekday: number, days: readonly number[] | undefined): boolean {
  return days === undefined || days.includes(weekday);
}
