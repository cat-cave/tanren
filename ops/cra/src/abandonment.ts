import type { CraConfig } from "./config.js";
import type { NormalizedFinding } from "./triage.js";
import type { PrState } from "./stateSchemas.js";
import type { PrStateStore } from "./stateStore.js";

const DAY_MS = 86_400_000;

export type AbandonmentReason = "findings" | "inactivity";

export interface AbandonmentPlan {
  readonly reset: boolean;
  readonly reminderDays: readonly number[];
  readonly abandon: AbandonmentReason | null;
  readonly state: PrState;
}

export interface StalenessObservation {
  readonly now: string;
  readonly headSha: string;
  readonly substantiveAuthorActivityAt: string | null;
  readonly findings: readonly NormalizedFinding[];
}

function findingsRequireRestart(findings: readonly NormalizedFinding[]): boolean {
  const restartLanguage =
    /\b(wrong direction|sweep(?:ing)?|destructive|new design|not reviewable|rewrite|replacement)\b/iu;
  return findings.some(
    (finding) =>
      (finding.severity === "P0" || finding.severity === "P1") &&
      (finding.category === "regression_deletion" ||
        restartLanguage.test(`${finding.title}\n${finding.body}\n${finding.fixDirection ?? ""}`)),
  );
}

export function planAbandonment(config: CraConfig, state: PrState, observation: StalenessObservation): AbandonmentPlan {
  const activity = observation.substantiveAuthorActivityAt;
  const newHead = observation.headSha !== state.lastSeenHeadSha;
  const newReply = activity !== null && activity > state.lastAuthorActivityAt;
  if (newHead || newReply) {
    return {
      reset: true,
      reminderDays: [],
      abandon: null,
      state: {
        ...state,
        lastSeenHeadSha: observation.headSha,
        lastAuthorActivityAt: newReply ? activity : state.lastAuthorActivityAt,
        awaitingAuthorSince: newHead ? null : activity,
        reminderDaysSent: [],
      },
    };
  }
  if (findingsRequireRestart(observation.findings)) {
    return {
      reset: false,
      reminderDays: [],
      abandon: "findings",
      state: { ...state, abandonmentReason: "findings" },
    };
  }
  if (state.awaitingAuthorSince === null) {
    return { reset: false, reminderDays: [], abandon: null, state };
  }
  const elapsed = new Date(observation.now).getTime() - new Date(state.awaitingAuthorSince).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error("staleness timestamps are invalid or non-monotonic");
  if (elapsed >= config.timing.inactivityDays * DAY_MS) {
    return {
      reset: false,
      reminderDays: [],
      abandon: "inactivity",
      state: { ...state, abandonmentReason: "inactivity" },
    };
  }
  const reminders = config.timing.reminderDays.filter(
    (day) => elapsed >= day * DAY_MS && !state.reminderDaysSent.includes(day),
  );
  return {
    reset: false,
    reminderDays: reminders,
    abandon: null,
    state: { ...state, reminderDaysSent: [...state.reminderDaysSent, ...reminders].sort((a, b) => a - b) },
  };
}

export interface AbandonmentGateway {
  hasPrComment(pr: number, marker: string): Promise<boolean>;
  commentPr(pr: number, body: string): Promise<void>;
  closePr(pr: number): Promise<void>;
  refreshOriginalIssue(input: {
    issue: number;
    marker: string;
    pr: number;
    reason: AbandonmentReason;
    durableFindings: readonly NormalizedFinding[];
  }): Promise<void>;
}

export interface ApplyAbandonmentInput {
  readonly pr: number;
  readonly headSha: string;
  readonly sourceIssue: number;
  readonly reason: AbandonmentReason;
  readonly findings: readonly NormalizedFinding[];
}

export async function postReminders(
  gateway: AbandonmentGateway,
  pr: number,
  headSha: string,
  days: readonly number[],
): Promise<void> {
  for (const day of days) {
    const marker = `<!-- tanren-cra:reminder pr=${pr} head=${headSha} day=${day} -->`;
    if (!(await gateway.hasPrComment(pr, marker))) {
      await gateway.commentPr(
        pr,
        `${marker}\nCRA reminder: requested changes have awaited substantive author activity for ${day} days.`,
      );
    }
  }
}

export async function applyAbandonment(
  gateway: AbandonmentGateway,
  input: ApplyAbandonmentInput,
  routeNewWork: (findings: readonly NormalizedFinding[]) => Promise<readonly number[]>,
): Promise<readonly number[]> {
  const marker = `<!-- tanren-cra:abandon pr=${input.pr} head=${input.headSha} reason=${input.reason} -->`;
  if (!(await gateway.hasPrComment(input.pr, marker))) {
    await gateway.commentPr(
      input.pr,
      `${marker}\nCRA abandonment (${input.reason}): closing without merge. The original issue is refreshed and claimable again.`,
    );
  }
  await gateway.closePr(input.pr);
  await gateway.refreshOriginalIssue({
    issue: input.sourceIssue,
    marker,
    pr: input.pr,
    reason: input.reason,
    durableFindings: input.findings.filter((finding) => finding.concerns === "acceptance"),
  });
  return await routeNewWork(input.findings.filter((finding) => finding.concerns === "new_work"));
}

export interface SuperviseAbandonmentInput {
  readonly state: PrState;
  readonly observation: StalenessObservation;
  readonly sourceIssue: number;
}

export async function superviseAbandonment(
  config: CraConfig,
  stateStore: PrStateStore,
  gateway: AbandonmentGateway,
  input: SuperviseAbandonmentInput,
  routeNewWork: (findings: readonly NormalizedFinding[]) => Promise<readonly number[]>,
): Promise<AbandonmentPlan> {
  const plan = planAbandonment(config, input.state, input.observation);
  await postReminders(gateway, input.state.pr, input.observation.headSha, plan.reminderDays);
  if (plan.abandon === null) {
    await stateStore.write(plan.state);
    return plan;
  }
  const issues = await applyAbandonment(
    gateway,
    {
      pr: input.state.pr,
      headSha: input.observation.headSha,
      sourceIssue: input.sourceIssue,
      reason: plan.abandon,
      findings: input.observation.findings,
    },
    routeNewWork,
  );
  const abandoned: PrState = {
    ...plan.state,
    disposition: "abandoned",
    abandonmentReason: plan.abandon,
    followUpIssues: [...new Set([...plan.state.followUpIssues, ...issues])].sort((left, right) => left - right),
  };
  await stateStore.write(abandoned);
  return { ...plan, state: abandoned };
}
