import { z } from "zod";

// P2A-0017 notifications matrix Zod schemas.
//
// The hi-fi defines a per-event × per-channel × severity matrix. We persist
// it as two tables:
//   - notification_targets: one row per configured destination (an ntfy
//     topic URL, a slack channel id, etc.).
//   - notification_routes: one row per (target × event) opt-in. The row also
//     carries a `minSeverity` floor — the channel will not fire unless the
//     event's mapped severity is at or above the floor.
//
// The matrix is `notification_targets × notification_routes`. Layering is
// done by `scope = user` rows overriding `scope = org` rows for the same
// `(orgId, channelKind, eventName)` tuple. The dispatcher applies the
// override at evaluation time.

export const ChannelKind = z.enum([
  "ntfy",
  "slack",
  "github_checks",
  "teams",
  "discord",
  "email",
  "twilio",
  "pagerduty",
  "webhook"
]);
export type ChannelKind = z.infer<typeof ChannelKind>;

export const Severity = z.enum(["ok", "info", "warn", "fail"]);
export type Severity = z.infer<typeof Severity>;

// Severities are ordered for floor comparisons. Higher index = higher
// severity. The dispatcher's `minSeverity` check is `severityRank(event) >=
// severityRank(route.minSeverity)`.
const SEVERITY_ORDER: ReadonlyArray<Severity> = ["ok", "info", "warn", "fail"];

export function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

export function severityMeetsFloor(actual: Severity, floor: Severity): boolean {
  return severityRank(actual) >= severityRank(floor);
}

export const TargetScope = z.enum(["org", "user"]);
export type TargetScope = z.infer<typeof TargetScope>;

export const NotificationTargetRow = z
  .object({
    id: z.string().min(1),
    orgId: z.string().min(1),
    scope: TargetScope,
    userId: z.string().min(1).nullable(),
    channelKind: ChannelKind,
    destination: z.string().min(1),
    label: z.string().min(1),
    enabled: z.boolean(),
    weekendMute: z.boolean(),
    createdAt: z.date(),
    updatedAt: z.date()
  })
  .superRefine((row, ctx) => {
    if (row.scope === "org" && row.userId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["userId"],
        message: "org-scoped target must have a null userId"
      });
    }
    if (row.scope === "user" && row.userId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["userId"],
        message: "user-scoped target must have a non-null userId"
      });
    }
  });
export type NotificationTargetRow = z.infer<typeof NotificationTargetRow>;

export const NotificationTargetCreateInput = z
  .object({
    id: z.string().min(1).optional(),
    orgId: z.string().min(1),
    scope: TargetScope,
    userId: z.string().min(1).nullable().default(null),
    channelKind: ChannelKind,
    destination: z.string().min(1),
    label: z.string().min(1),
    enabled: z.boolean().default(true),
    weekendMute: z.boolean().default(false)
  })
  .superRefine((input, ctx) => {
    if (input.scope === "org" && input.userId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["userId"],
        message: "org-scoped target must have a null userId"
      });
    }
    if (input.scope === "user" && input.userId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["userId"],
        message: "user-scoped target must have a userId"
      });
    }
  });
export type NotificationTargetCreateInput = z.infer<typeof NotificationTargetCreateInput>;

export const NotificationRouteRow = z.object({
  id: z.string().min(1),
  targetId: z.string().min(1),
  eventName: z.string().min(1),
  enabled: z.boolean(),
  minSeverity: Severity,
  createdAt: z.date(),
  updatedAt: z.date()
});
export type NotificationRouteRow = z.infer<typeof NotificationRouteRow>;

export const NotificationRouteCreateInput = z.object({
  id: z.string().min(1).optional(),
  targetId: z.string().min(1),
  eventName: z.string().min(1),
  enabled: z.boolean().default(true),
  minSeverity: Severity.default("info")
});
export type NotificationRouteCreateInput = z.infer<typeof NotificationRouteCreateInput>;

// NotificationPayload is what channels publish. Redacted before this is
// constructed; channels MUST NOT see raw payload fields.
export const NotificationPayload = z.object({
  title: z.string().min(1),
  body: z.string(),
  severity: Severity,
  eventName: z.string().min(1),
  url: z.string().optional(),
  tags: z.array(z.string()).optional()
});
export type NotificationPayload = z.infer<typeof NotificationPayload>;
