// cost PR-C, Part 2: the Anthropic Claude subscription-OVERAGE signal seam.
//
// FINDING (investigated, 2026-06, codexbar docs + Anthropic billing). A paid
// Claude plan bills usage BEYOND the subscription window ("extra usage") at
// standard API rates — the subscription-OVERAGE basis, the Claude analogue of
// the Codex prepaid-credit drawdown. Two layers report Claude usage:
//
//   1. LOCAL CLI / OAuth (the path Tanren actually has — codexbar runs over SSH
//      against the per-run CODEX_HOME). Claude reports usage as PERCENT-of-window
//      buckets (`five_hour` session, `seven_day` weekly, an `extra_usage` window)
//      and the local cost figure is an ESTIMATE computed from local session
//      history (the cookbook: "approximate, computed from local session history
//      on this machine"). Crucially there is NO real credit/balance DELTA here:
//      the Codex `credits.remaining` field that the codex drawdown path differences
//      has NO Claude equivalent in the local output. So a REAL overage dollar
//      figure is NOT reachable on this path.
//
//   2. The Anthropic CONSOLE — the AUTHORITATIVE overage spend — is reachable ONLY
//      via an org-level Admin API key (`/v1/organizations/cost_report`) or the Web
//      API `overage_spend_limit` endpoint. That is an ORG integration credential,
//      NOT the per-run subscription credential the run executes under, and is not
//      wired today.
//
// DECISION (REAL SPEND IS A FACT; NO silent fallback). Where a real overage/credit
// signal IS reachable (the Codex `credits.remaining` delta) we capture it as
// `credits` real spend — the existing `readEndingCreditDrawdown` path, unchanged.
// Where it is NOT reachable (Claude, today) we DO NOT approximate the overage from
// the local estimate or from window percentages. The run-end reconcile records the
// overage real spend as UNKNOWN/NULL and emits a LOUD `cost.overage_unobservable`
// event naming the honest gap, so an operator sees that a Claude subscription's
// real overage is uncaptured rather than silently treated as $0. (Within-window
// subscription usage stays $0 real / notional-only, unchanged.)
//
// This seam classifies, per the run's credential, WHICH branch applies. It is the
// `subtaskAccounting` reconcile's gate: a `credits_delta` provider runs the
// drawdown→USD reconcile; an `unobservable_local` provider records NULL-and-loud.
import { classifyAuthRef } from "./sources.js";

export interface ClaudeOverageReachability {
  // How the credential's subscription-OVERAGE real spend is observable:
  //   credits_delta       — a real prepaid-credit balance delta is reachable from
  //                          the local CLI (Codex `credits.remaining`); the
  //                          drawdown→USD reconcile applies.
  //   unobservable_local  — a subscription whose real overage is NOT reachable from
  //                          the local CLI path (Claude: needs the org Admin API).
  //                          The reconcile records NULL real spend, loud.
  //   not_subscription    — a per-token / self-hosted / absent / unrecognized ref:
  //                          overage is not a concept here (no drawdown, no signal).
  kind: "credits_delta" | "unobservable_local" | "not_subscription";
  // The provider the classification resolved (e.g. "openai" for codex, "anthropic").
  provider: string;
  // For `unobservable_local`: the AUTHORITATIVE source that WOULD carry the real
  // figure (a fixed, secret-free diagnosis), so the loud event explains the gap.
  authoritativeSource: string | null;
}

// classifyOverageReachability maps the run's credential ref to its overage-signal
// reachability. The Codex subscription bundle (`credential/codex/...`) exposes a
// real credit-balance delta locally → `credits_delta`. The Claude CLI subscription
// bundle (`credential/claude/...`) reports only percentages + a local-ESTIMATE cost
// locally → `unobservable_local` (the real figure lives in the Anthropic Console /
// Admin API, not the per-run credential). Every other ref kind is
// `not_subscription` (a per-token API key bills on the upstream invoice; a
// self-hosted endpoint has no overage).
export function classifyOverageReachability(authRef: string): ClaudeOverageReachability {
  const classification = classifyAuthRef(authRef);
  if (classification.billingMode !== "subscription") {
    return { kind: "not_subscription", provider: classification.provider, authoritativeSource: null };
  }
  // The Claude CLI subscription bundle: real overage is NOT reachable on the local
  // path (only percentages + a local estimate); the authoritative figure lives in
  // the Anthropic Admin API cost report, an org integration not wired today.
  if (authRef.startsWith("credential/claude/")) {
    return {
      kind: "unobservable_local",
      provider: "anthropic",
      authoritativeSource: "anthropic-admin-api-cost-report",
    };
  }
  // The Codex/ChatGPT subscription bundle exposes a real credit-balance delta.
  return { kind: "credits_delta", provider: classification.provider, authoritativeSource: null };
}
