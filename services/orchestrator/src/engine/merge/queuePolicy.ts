// Frozen QueuePolicyV1 contracts. Policies describe queue selection only; they
// deliberately contain no executable command, merge-now, or authority override.
import { z } from "zod";

const NonBlank = z.string().trim().min(1);
const Identifier = NonBlank.max(160);
const Priority = z.enum(["P0", "P1", "P2", "tbd"]);
const PartitionMode = z.enum(["serial", "scoped", "isolated"]);

const MatcherLeafSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch"), equals: NonBlank.max(255) }).strict(),
  z.object({ kind: z.literal("labels"), includes: Identifier }).strict(),
  z.object({ kind: z.literal("paths"), includes: NonBlank.max(1024) }).strict(),
  z.object({ kind: z.literal("author"), equals: Identifier }).strict(),
  z.object({ kind: z.literal("review"), state: z.enum(["approved"]) }).strict(),
  z.object({ kind: z.literal("check"), name: Identifier, state: z.literal("passed") }).strict(),
  z.object({ kind: z.literal("scope"), equals: Identifier }).strict(),
  z.object({ kind: z.literal("schedule"), window: Identifier }).strict(),
]);

export type QueueMatcherV1 =
  | z.infer<typeof MatcherLeafSchema>
  | { kind: "all"; clauses: QueueMatcherV1[] }
  | { kind: "any"; clauses: QueueMatcherV1[] }
  | { kind: "not"; clause: QueueMatcherV1 };

export const QueueMatcherV1Schema: z.ZodType<QueueMatcherV1> = z.lazy(() =>
  z.union([
    MatcherLeafSchema,
    z.object({ kind: z.literal("all"), clauses: z.array(QueueMatcherV1Schema).min(1) }).strict(),
    z.object({ kind: z.literal("any"), clauses: z.array(QueueMatcherV1Schema).min(1) }).strict(),
    z.object({ kind: z.literal("not"), clause: QueueMatcherV1Schema }).strict(),
  ]),
);

export const QueuePolicyV1Schema = z
  .object({
    schemaVersion: z.literal("queue_policy.v1"),
    routes: z
      .array(
        z
          .object({
            name: Identifier,
            targetBranch: NonBlank.max(255),
            matcher: QueueMatcherV1Schema,
            priority: z
              .object({
                base: Priority,
                aging: z.object({ enabled: z.boolean(), step: z.number().int().min(1).max(100) }).strict(),
              })
              .strict(),
            partition: z
              .object({
                mode: PartitionMode,
                capacity: z.number().int().min(1).max(100),
                batchLimit: z.number().int().min(1).max(100),
                deployGroupLimit: z.number().int().min(1).max(100),
              })
              .strict(),
            interruption: z.object({ mode: z.enum(["hold", "pause", "drain"]) }).strict(),
            requiredWindows: z.array(Identifier).min(1),
          })
          .strict(),
      )
      .min(1)
      .superRefine((routes, context) => {
        const names = new Set<string>();
        for (const [index, route] of routes.entries()) {
          if (names.has(route.name)) {
            context.addIssue({ code: "custom", path: [index, "name"], message: "route names must be unique" });
          }
          names.add(route.name);
        }
      }),
  })
  .strict();
export type QueuePolicyV1 = z.infer<typeof QueuePolicyV1Schema>;

export const QueueWindowV1Schema = z
  .object({
    schemaVersion: z.literal("queue_window.v1"),
    name: Identifier,
    kind: z.enum(["allow", "blackout"]),
    timezone: NonBlank.max(80),
    scope: z.object({ projectId: Identifier, targetBranch: NonBlank.max(255).optional() }).strict(),
    intervals: z
      .array(
        z
          .object({ startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }) })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((window, context) => {
    for (const [index, interval] of window.intervals.entries()) {
      if (interval.startsAt >= interval.endsAt) {
        context.addIssue({ code: "custom", path: ["intervals", index], message: "window interval must advance" });
      }
    }
  });
export type QueueWindowV1 = z.infer<typeof QueueWindowV1Schema>;

const CommandScopeSchema = z
  .object({ projectId: Identifier, targetBranch: NonBlank.max(255).optional(), queueId: Identifier.optional() })
  .strict();
const CommandBaseSchema = z
  .object({
    schemaVersion: z.literal("queue_command.v1"),
    idempotencyKey: Identifier,
    scope: CommandScopeSchema,
  })
  .strict();
const QueueEntryCommand = CommandBaseSchema.extend({
  command: z.enum(["queue", "requeue", "dequeue", "refresh"]),
}).strict();
const BoostCommand = CommandBaseSchema.extend({ command: z.literal("boost"), priority: Priority }).strict();
const ClearBoostCommand = CommandBaseSchema.extend({ command: z.literal("clear-boost") }).strict();
const PartitionCommand = CommandBaseSchema.extend({
  command: z.enum(["pause", "resume", "freeze", "unfreeze", "drain"]),
  reason: NonBlank.max(500),
}).strict();

export const QueueCommandV1Schema = z.union([QueueEntryCommand, BoostCommand, ClearBoostCommand, PartitionCommand]);
export type QueueCommandV1 = z.infer<typeof QueueCommandV1Schema>;

export interface QueueMatchFacts {
  readonly branch: string;
  readonly labels?: readonly string[];
  readonly paths?: readonly string[];
  readonly author?: string;
  readonly review?: "approved";
  readonly checks?: Readonly<Record<string, "passed">>;
  readonly scope?: string;
  readonly openWindows?: ReadonlySet<string>;
}

type MatcherDecision = "matched" | "not_matched" | "unknown";

/** Missing facts never match: an unobservable predicate is a queue hold, never a pass. */
function evaluateQueueMatcher(matcher: QueueMatcherV1, facts: QueueMatchFacts): MatcherDecision {
  switch (matcher.kind) {
    case "branch":
      return facts.branch === matcher.equals ? "matched" : "not_matched";
    case "labels":
      return facts.labels === undefined
        ? "unknown"
        : facts.labels.includes(matcher.includes)
          ? "matched"
          : "not_matched";
    case "paths":
      return facts.paths === undefined
        ? "unknown"
        : facts.paths.some((path) => path === matcher.includes)
          ? "matched"
          : "not_matched";
    case "author":
      return facts.author === undefined ? "unknown" : facts.author === matcher.equals ? "matched" : "not_matched";
    case "review":
      return facts.review === undefined ? "unknown" : facts.review === matcher.state ? "matched" : "not_matched";
    case "check":
      return facts.checks === undefined || facts.checks[matcher.name] === undefined
        ? "unknown"
        : facts.checks[matcher.name] === matcher.state
          ? "matched"
          : "not_matched";
    case "scope":
      return facts.scope === undefined ? "unknown" : facts.scope === matcher.equals ? "matched" : "not_matched";
    case "schedule":
      return facts.openWindows === undefined
        ? "unknown"
        : facts.openWindows.has(matcher.window)
          ? "matched"
          : "not_matched";
    case "all": {
      const decisions = new Set(matcher.clauses.map((clause) => evaluateQueueMatcher(clause, facts)));
      return decisions.has("not_matched") ? "not_matched" : decisions.has("unknown") ? "unknown" : "matched";
    }
    case "any": {
      const decisions = new Set(matcher.clauses.map((clause) => evaluateQueueMatcher(clause, facts)));
      return decisions.has("matched") ? "matched" : decisions.has("unknown") ? "unknown" : "not_matched";
    }
    case "not":
      switch (evaluateQueueMatcher(matcher.clause, facts)) {
        case "matched":
          return "not_matched";
        case "not_matched":
          return "matched";
        case "unknown":
          return "unknown";
      }
  }
  throw new Error("unknown queue matcher");
}

export function matchesQueueMatcher(matcher: QueueMatcherV1, facts: QueueMatchFacts): boolean {
  return evaluateQueueMatcher(matcher, facts) === "matched";
}
