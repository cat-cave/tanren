import type { SensitivityRule } from "./sensitivity.js";

// Cost / cost-safety sensitivity rules, split out of sensitivityRules.infra.ts to
// keep each file under the 500-line cap. Covers cost.resolved/failed and the
// BUDGET-SAFETY cost-misconfig events (cost.unattributable / cost.unattributed /
// cost.ceiling_unreachable). NONE carry a secret VALUE — a credential is named by
// its KIND/ref only (refKind is the secret-name-stripped path; authRef on the
// legacy cost.unattributable is `redacted`), so cost dollars + modes + counts are
// non-sensitive operational telemetry (public).
export const costSensitivityRules: SensitivityRule[] = [
  ...rulesFor("cost.resolved", [
    ["taskId", "public"],
    ["cli", "public"],
    ["provider", "public"],
    ["model", "public"],
    ["costUsd", "public"],
    ["notionalCostUsd", "public"],
    ["billingMode", "public"],
    ["costBasis", "public"],
    // LOUD ESTIMATE flag — a boolean operational signal (this OpenRouter row's
    // dollar figure is a list-rate estimate, not the real deduction). No secret.
    ["estimateOnly", "public"],
  ]),
  ...rulesFor("cost.failed", [
    ["taskId", "public"],
    ["message", "public"],
  ]),
  ...rulesFor("cost.unattributable", [
    ["taskId", "public"],
    ["cli", "public"],
    ["authRef", "redacted"],
    ["reason", "public"],
    ["inputTokens", "public"],
    ["outputTokens", "public"],
    ["cachedInputTokens", "public"],
  ]),
  // cost.unattributed (BUDGET-SAFETY C1) — refKind is the secret-free KIND label
  // (the credential-name segment stripped), reason is a fixed diagnosis string;
  // both safe to display to any project member. No secret value is carried.
  ...rulesFor("cost.unattributed", [
    ["taskId", "public"],
    ["cli", "public"],
    ["refKind", "public"],
    ["reason", "public"],
  ]),
  // cost.ceiling_unreachable (BUDGET-SAFETY M6) — refKind is secret-free, the
  // billing mode / ceiling / reason are non-sensitive config; all public.
  ...rulesFor("cost.ceiling_unreachable", [
    ["refKind", "public"],
    ["billingMode", "public"],
    ["ceilingUsd", "public"],
    ["reason", "public"],
  ]),
  // cost.credit_rate_unknown (cost PR-C) — refKind is the secret-free KIND label,
  // creditsConsumed is an operational count, reason is a fixed diagnosis. No secret.
  ...rulesFor("cost.credit_rate_unknown", [
    ["refKind", "public"],
    ["creditsConsumed", "public"],
    ["reason", "public"],
  ]),
  // cost.overage_unobservable (cost PR-C) — provider/refKind/authoritativeSource are
  // secret-free identifiers, reason is a fixed diagnosis string; all public.
  ...rulesFor("cost.overage_unobservable", [
    ["provider", "public"],
    ["refKind", "public"],
    ["authoritativeSource", "public"],
    ["reason", "public"],
  ]),
];

function rulesFor(eventName: string, entries: ReadonlyArray<[string, SensitivityRule["tag"]]>): SensitivityRule[] {
  return entries.map(([path, tag]) => ({ eventName, path, tag }));
}
