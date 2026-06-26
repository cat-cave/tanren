// Tanren-native templating (wave 3) — the Forge SELECTION integration.
//
// The onboarding flow captures the project LIFECYCLE at the architecture step
// (CaptureLifecycle, the stack-flexible contract). BEFORE deriving the scaffold
// specs, this module QUERIES the template registry by the CAPABILITIES that
// lifecycle implies and DECIDES whether to SEED from a validated template or fall
// through to the existing from-scratch scaffold (templating-system.md §3).
//
// SELECTION IS CAPABILITY-DRIVEN, NEVER STACK-HARDCODED. Tanren names no stack: the
// capability query is derived mechanically from the project's OWN lifecycle
// declaration (the `stack` label + the deploy command), and the scorer ranks
// candidates on capability-match strength — so a never-seen stack (or a non-code
// project) selects a template iff one of matching capability exists, never because
// a stack name was recognized. There are NO templates in the registry yet (the
// creation meta-DAG is a later wave), so in practice this resolves to "no match →
// from-scratch" live — the EXPECTED current behavior, and the apex path.
//
// FAIL-CLOSED. Only `validated`/`official` templates with a FRESH, non-degraded
// validationProof are eligible; a selected template that fails a FINAL freshness
// re-check at the decision boundary is REJECTED with a LOUD log. There is NO
// project-direct from-scratch fallback: a no-match must CREATE a validated template
// JUST-IN-TIME (the creation meta-flow seeds from the published result) or HALT LOUD
// (`TemplateRequiredError`) — never silently scaffold a project from an empty repo.
// The from-scratch authoring is reachable ONLY as the BUILD step of template-creation
// (it authors the TEMPLATE, validated before anything seeds from it; see derive.ts).

import type { ActorRef } from "../../state/actor.js";
import type { Template, TemplateCapabilityQuery, TemplateStatus } from "../../repositories/templates.js";
import type { CuratedTemplate } from "../../templates/fragments/registry/index.js";
import type { TemplateValidationProof } from "../../templates/manifest.js";
import type { CaptureLifecycle } from "./types.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("template-selection");

// ── Eligibility + freshness ─────────────────────────────────────────────────

// The lifecycle tiers a template may be SEEDED from. A `draft` (unvalidated) or
// `degraded` (proof expired / open P0/P1) template is NEVER seeded — only a proven
// `validated` template or the cross-org `official` catalogue. This is the §3
// eligibility rule, applied both as the registry `statuses` filter AND re-checked
// at the decision boundary (defence in depth).
export const SEEDABLE_STATUSES: ReadonlyArray<TemplateStatus> = ["validated", "official"] as const;

// How long a template's validationProof stays FRESH before it is treated as stale
// (degraded-by-age). 30 days: a template whose gates were last proven meaningful
// more than a month ago is no longer trusted to seed a greenfield repo without a
// re-validation (the maintenance flow — a later wave — re-proves + bumps this). A
// stale proof fails the freshness gate and the flow falls back to from-scratch.
export const PROOF_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1000;

// Is a validationProof FRESH (positive controls passed, auditor clean, and
// validated within the freshness window relative to `now`)? A `null` proof (an
// unvalidated template) is NEVER fresh. A malformed/absent `validatedAt` is treated
// as NOT fresh (fail-closed) rather than thrown — the caller logs + falls back.
export function isProofFresh(proof: TemplateValidationProof | null, now: number): boolean {
  if (proof === null) return false;
  if (!proof.positiveControlsPassed || !proof.auditorClean) return false;
  const validatedAtMs = Date.parse(proof.validatedAt);
  if (Number.isNaN(validatedAtMs)) return false;
  return now - validatedAtMs <= PROOF_FRESHNESS_MS;
}

// Is this template ELIGIBLE to seed from — a seedable status AND a fresh proof?
// The single fail-closed predicate the scorer's eligibility filter AND the final
// decision-boundary re-check both call.
export function isTemplateEligible(template: Template, now: number): boolean {
  if (!SEEDABLE_STATUSES.includes(template.status)) return false;
  return isProofFresh(template.manifest.validationProof, now);
}

// ── Capability query derivation ─────────────────────────────────────────────

// The capability query derived from a captured lifecycle. Tanren parses NO stack
// switch — it derives capability HINTS from the lifecycle's free-form `stack` label
// and `deploy`/`build` commands, purely as registry filter terms. The label tokens
// (e.g. "ts/pnpm", "rust/cargo", "novel/pandoc") are matched against the template
// manifest's `runtime`/`packageManager` capabilities; nothing is privileged.
export interface DeriveCapabilityQueryResult {
  query: TemplateCapabilityQuery;
}

// Split a free-form stack label into lowercase tokens on the conventional
// separators ("/", "·", whitespace, "-"). "ts/pnpm · next" → ["ts","pnpm","next"].
function stackTokens(stack: string): string[] {
  return stack
    .toLowerCase()
    .split(/[/·\s,-]+/u)
    .map((t) => t.trim())
    .filter((t) => t !== "");
}

// LANGUAGE → EXECUTION-RUNTIME equivalence. A captured stack labels its LANGUAGE
// ("ts", "js", "python") but a template manifest declares the EXECUTION RUNTIME the
// repo targets ("node", "bun", "python") — so a `ts/pnpm` project's first token
// ("ts") would never equality-match a `node`-runtime template, wrongly excluding it
// (the bug the §3 "never wrongly excludes" contract forbids). This is the SAME
// general-knowledge class as the conventional justfile target NAMES: a small,
// stack-AGNOSTIC alias map (a language and the runtime that executes it are the same
// capability), NOT a per-stack switch Tanren branches on. A token with no alias maps
// to ITSELF, so a never-seen / non-code stack ("novel", "rust") is unchanged. The
// map is intentionally minimal — it expresses runtime identity, not a stack policy.
const RUNTIME_EQUIVALENCE: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["ts", ["ts", "typescript", "node", "js", "javascript"]],
  ["typescript", ["typescript", "ts", "node", "js", "javascript"]],
  ["js", ["js", "javascript", "node", "ts", "typescript"]],
  ["javascript", ["javascript", "js", "node", "ts", "typescript"]],
  ["node", ["node", "ts", "typescript", "js", "javascript"]],
  ["nodejs", ["node", "nodejs", "ts", "typescript", "js", "javascript"]],
]);

// The set of runtimes EQUIVALENT to a captured runtime token — the token itself plus
// any language↔runtime aliases. A `ts` token yields {ts, typescript, node, js,
// javascript} so the SQL filter + the scorer both treat a `node`-runtime template as
// a runtime match for a `ts/pnpm` project. An unaliased token yields just itself.
export function runtimeEquivalents(token: string): string[] {
  const lower = token.toLowerCase();
  return [...(RUNTIME_EQUIVALENCE.get(lower) ?? [lower])];
}

// Does a template's declared runtime MATCH any of the captured stack's tokens, under
// language↔runtime equivalence? `node` matches a stack that declared `ts`/`js`/etc.
// Used by the scorer so the runtime weight is awarded across the equivalence — the
// scorer counterpart to the query's `runtimeAny` expansion (kept in lock-step so the
// SQL filter and the score agree on what "matches the runtime").
function runtimeMatches(declaredRuntime: string, stackTokenSet: ReadonlySet<string>): boolean {
  return runtimeEquivalents(declaredRuntime).some((r) => stackTokenSet.has(r));
}

// Derive the registry capability query from the captured lifecycle. Restricts to
// the SEEDABLE statuses (only proven templates) and leaves channel UNbound (the
// scorer expresses the channel PREFERENCE — a query that bound `channel` would
// EXCLUDE the other channel rather than rank it lower). runtime/packageManager are
// the first two stack tokens (a convention the creation flow also follows when it
// labels a template); deployTarget is the first token of the deploy command. These
// are best-effort FILTER HINTS, not a contract — the scorer re-scores on the full
// capability set, so a partial hint never wrongly excludes a strong match. We
// deliberately DO NOT bind framework/deployTarget in the query (they often differ
// product-to-product); they feed the SCORE, not the filter.
export function deriveCapabilityQuery(lifecycle: CaptureLifecycle): DeriveCapabilityQueryResult {
  const tokens = stackTokens(lifecycle.stack);
  const query: TemplateCapabilityQuery = {
    statuses: SEEDABLE_STATUSES,
  };
  // Bind the runtime as the EQUIVALENCE-EXPANDED set (the language token + its
  // runtime aliases), NOT the raw first token — so a `ts/pnpm` project's filter
  // matches a `node`-runtime template instead of hard-excluding it (the §3 "never
  // wrongly excludes" contract; the prior bare `runtime = tokens[0]` violated it).
  if (tokens[0] !== undefined) query.runtimeAny = runtimeEquivalents(tokens[0]);
  return { query };
}

// ── Scorer ──────────────────────────────────────────────────────────────────

// A scored candidate: the template plus the capability-match score and the human
// reasons (recorded on the decision for observability). Higher score = stronger
// match. The score is a pure function of (capability overlap, channel preference,
// proof freshness) — never a stack name.
export interface ScoredTemplate {
  template: Template;
  score: number;
  reasons: string[];
}

// The channel a selection PREFERS. `lts` by default — a greenfield seed wants the
// conservative, stable channel; `nightly` (the canary) only when explicitly asked.
export type ChannelPreference = "lts" | "nightly";

// Score weights. Capability overlap dominates (each matched capability is worth far
// more than the channel/freshness tie-breakers) so a template that matches more of
// the project's lifecycle always outranks a fresher-but-less-matching one.
const WEIGHT_RUNTIME = 100;
const WEIGHT_PACKAGE_MANAGER = 60;
const WEIGHT_FRAMEWORK = 40;
const WEIGHT_DEPLOY_TARGET = 30;
const WEIGHT_CHANNEL_PREFERENCE = 10;
const WEIGHT_OFFICIAL = 8;
// Freshness contributes a small, monotonic tie-breaker: a more recently validated
// proof ranks marginally higher (up to this many points at 0 age, decaying to 0 at
// the freshness horizon). Always strictly less than any single capability weight.
const WEIGHT_FRESHNESS_MAX = 5;

// The capability THRESHOLD that distinguishes a STRONG match (seed + shrink the
// scaffold to "instantiate") from a PARTIAL one (seed + emit adaptation specs). A
// strong match has matched at least the runtime AND the package manager — the
// load-bearing toolchain capabilities. Below that (some overlap but not the core
// toolchain) is partial.
const STRONG_MATCH_THRESHOLD = WEIGHT_RUNTIME + WEIGHT_PACKAGE_MANAGER;

function freshnessScore(proof: TemplateValidationProof | null, now: number): number {
  if (proof === null) return 0;
  const validatedAtMs = Date.parse(proof.validatedAt);
  if (Number.isNaN(validatedAtMs)) return 0;
  const age = now - validatedAtMs;
  if (age <= 0) return WEIGHT_FRESHNESS_MAX;
  if (age >= PROOF_FRESHNESS_MS) return 0;
  return Math.round(WEIGHT_FRESHNESS_MAX * (1 - age / PROOF_FRESHNESS_MS));
}

// Score ONE candidate against the captured lifecycle + channel preference. PURE:
// capability overlap (runtime/pkg-mgr/framework/deploy-target tokens present in the
// lifecycle's stack/deploy declaration) + channel preference + official-catalogue
// bonus + a freshness tie-breaker. No stack literal — every comparison is against
// the project's own lifecycle tokens.
export function scoreTemplate(
  template: Template,
  lifecycle: CaptureLifecycle,
  channelPreference: ChannelPreference,
  now: number,
): ScoredTemplate {
  const caps = template.manifest.capabilities;
  const stackSet = new Set(stackTokens(lifecycle.stack));
  const deploySet = new Set(stackTokens(lifecycle.deploy));
  let score = 0;
  const reasons: string[] = [];

  // Award the runtime weight under language↔runtime EQUIVALENCE (a `node` template
  // matches a `ts`/`js` stack) — in lock-step with the query's `runtimeAny` expansion
  // so the filter and the score agree on a runtime match (templating-system.md §3).
  if (runtimeMatches(caps.runtime, stackSet)) {
    score += WEIGHT_RUNTIME;
    reasons.push(`runtime:${caps.runtime}`);
  }
  if (stackSet.has(caps.packageManager.toLowerCase())) {
    score += WEIGHT_PACKAGE_MANAGER;
    reasons.push(`packageManager:${caps.packageManager}`);
  }
  if (caps.framework !== undefined && stackSet.has(caps.framework.toLowerCase())) {
    score += WEIGHT_FRAMEWORK;
    reasons.push(`framework:${caps.framework}`);
  }
  if (caps.deployTarget !== undefined && deploySet.has(caps.deployTarget.toLowerCase())) {
    score += WEIGHT_DEPLOY_TARGET;
    reasons.push(`deployTarget:${caps.deployTarget}`);
  }
  if (template.channel === channelPreference) {
    score += WEIGHT_CHANNEL_PREFERENCE;
    reasons.push(`channel:${template.channel}`);
  }
  if (template.status === "official") {
    score += WEIGHT_OFFICIAL;
    reasons.push("official");
  }
  const fresh = freshnessScore(template.manifest.validationProof, now);
  score += fresh;
  if (fresh > 0) reasons.push(`freshness:${fresh}`);

  return { template, score, reasons };
}

// Rank candidates: filter to the ELIGIBLE (seedable + fresh — fail-closed), score
// each, and sort by score descending (stable on the registry's newest-first input,
// so ties keep registry order). Ineligible candidates are dropped entirely — a
// degraded/unvalidated template can never win.
export function rankTemplates(
  candidates: ReadonlyArray<Template>,
  lifecycle: CaptureLifecycle,
  channelPreference: ChannelPreference,
  now: number,
): ScoredTemplate[] {
  return candidates
    .filter((t) => isTemplateEligible(t, now))
    .map((t) => scoreTemplate(t, lifecycle, channelPreference, now))
    .sort((a, b) => b.score - a.score);
}

// ── Decision ────────────────────────────────────────────────────────────────

// The seed reference recorded on the project/run when a template is selected — the
// `templateRef` + the proof it was selected on. Durable evidence the scaffold seeded
// from a PROVEN template (observable on the project config; templating-system.md §3).
export interface SelectedTemplate {
  // The selected template's id (the `templateRef` persisted on the project).
  templateRef: string;
  // The template repo the seed clones its conforming files from.
  repoRef: string;
  // The proof the template was selected on (persisted alongside the ref so the seed
  // is auditable + the proof can be re-checked).
  validationProof: TemplateValidationProof;
}

// The selection OUTCOME (templating-system.md §3 decision tree). Recorded on the
// derive so the decision is OBSERVABLE. EVERY successful project-init selection now
// resolves to a SEED (a pre-existing match, a just-in-time-CREATED template, or a
// MATRIX-HIT compose-from-fragments) — there is NO from-scratch project outcome. A
// no-match that cannot create a validated template is NOT a kind here: it is a LOUD
// HALT (`TemplateRequiredError`).
//   - "strong"  → SEED + the scaffold spec SHRINKS to "instantiate + adapt names".
//                 Also the just-in-time-CREATED case (a freshly-published template
//                 is a strong match by construction).
//   - "partial" → SEED + emit adaptation specs (the scaffold spec adapts more).
//   - "compose-from-fragments" → MATRIX-HIT (PR-C): the operator's stack matches a
//                 CURATED entry; the deterministic 9-phase composer assembles the
//                 template from typed fragments — the agent template-build path is
//                 SKIPPED entirely. The derive (which holds the GitHub plumbing)
//                 materializes the composed VFS into a template repo + converts this
//                 decision into a `strong` seed BEFORE the scaffold spec runs.
export type SelectionKind = "strong" | "partial" | "compose-from-fragments";

export interface TemplateSelectionDecision {
  kind: SelectionKind;
  // Present iff `kind` is "strong" | "partial" — the chosen template + its proof.
  // ABSENT on `compose-from-fragments` (the curated entry has not been materialized
  // into a repo yet; the derive materializer fills `selected` after compose+push).
  selected?: SelectedTemplate;
  // Present iff `kind` is "compose-from-fragments" — the curated entry that hit. The
  // derive materializer reads this to drive `composeTemplate`.
  curated?: CuratedTemplate;
  // The capability query that was run (recorded for observability). For
  // `compose-from-fragments` this is the seedable-statuses base (the curated lookup
  // does not derive a registry query — it short-circuits).
  query: TemplateCapabilityQuery;
  // The score of the chosen candidate (strong/partial), or the best ineligible/
  // sub-threshold score considered (none), for observability.
  topScore?: number;
  // Human reasons the decision landed where it did (the scorer reasons for a
  // selected template, a "matrix-hit:<id>" tag for compose-from-fragments, or a
  // "no eligible candidate"/"would-create" note).
  reasons: string[];
}

// The registry query callback the selection runs over. The DERIVE path injects an
// ORG-SCOPED query (so RLS bounds the candidates to the org's own + the cross-org
// `official` catalogue); tests inject a fixture list. Returns the candidate
// templates for the derived capability query — the selection then ranks + decides.
export type TemplateRegistryQuery = (
  query: TemplateCapabilityQuery,
  actor: ActorRef,
) => Promise<ReadonlyArray<Template>>;

export interface SelectTemplateInput {
  lifecycle: CaptureLifecycle;
  // The registry query (org-scoped in prod; a fixture in tests).
  registryQuery: TemplateRegistryQuery;
  actor: ActorRef;
  // The seed channel preference. Defaults to "lts" (conservative greenfield seed).
  channelPreference?: ChannelPreference;
  // Injectable clock (ms epoch) for deterministic freshness tests. Defaults to now.
  now?: number;
  // The no-match → JUST-IN-TIME CREATION seam (templating-system.md §3, "no match →
  // trigger creation"). When NO validated template matches, selection calls this to
  // CREATE one SYNCHRONOUSLY (the creation meta-flow, §2: research → author → build →
  // validate-with-NEGATIVE-controls → publish) and SEEDS from the published result.
  // The creation GATES the project scaffold — selection does not return until a
  // validated template exists (or the creation FAILS). The selection layer itself has
  // NO creation dependency — the seam is supplied by the wiring layer
  // (`buildCreateForNoMatch`), so there is no circular import. Returns a
  // `SelectedTemplate` to seed from (the freshly-published template). A `undefined`
  // return or a THROW means creation did not yield a usable template → selection
  // re-throws as `TemplateRequiredError` (a LOUD, fail-closed halt — never a silent
  // from-scratch project scaffold). REQUIRED on the project-init path; absent only on
  // the template-BUILD path (which is itself the from-scratch authoring of a template).
  createForNoMatch?: (lifecycle: CaptureLifecycle) => Promise<SelectedTemplate | undefined>;
}

// Thrown when project-init selection found NO validated template AND could not
// create one just-in-time (no creation seam wired, or the creation FAILED / produced
// no usable template). This is the FAIL-CLOSED halt that replaces the deleted
// project-direct from-scratch bypass: a no-match must create-or-halt, never silently
// degrade to scaffolding the project off an empty repo. The caller (the onboarding
// route) surfaces this as a LOUD needs_attention/fail-closed response. The from-
// scratch authoring still exists — but ONLY as the template-creation BUILD step.
export class TemplateRequiredError extends Error {
  // Named distinctly so it does not shadow `Error.stack`.
  readonly requestedStack: string;
  constructor(stack: string, cause?: unknown) {
    super(
      `no validated template matched the project lifecycle (stack "${stack}") and just-in-time ` +
        `template creation did not produce one — HALTING fail-closed. A project DAG never scaffolds ` +
        `against a non-template (from-scratch) base: the project seeds ONLY from a validated template. ` +
        `Resolve the template-creation failure (or wire the creation seam) and retry.`,
    );
    this.name = "TemplateRequiredError";
    this.requestedStack = stack;
    if (cause !== undefined) this.cause = cause;
  }
}

// Run the SELECTION + DECISION (templating-system.md §3). Derives the capability
// query from the captured lifecycle, queries the registry (org-scoped), ranks the
// eligible candidates, and DECIDES strong/partial/none. The chosen candidate is
// re-checked against the freshness gate ONE MORE TIME at this boundary
// (fail-closed): if it is no longer fresh, the selection is REJECTED with a LOUD
// log and DOWNGRADED to a from-scratch outcome — never a silent broken seed.
export async function selectTemplate(input: SelectTemplateInput): Promise<TemplateSelectionDecision> {
  const now = input.now ?? Date.now();
  const channelPreference = input.channelPreference ?? "lts";
  const { query } = deriveCapabilityQuery(input.lifecycle);

  let candidates: ReadonlyArray<Template>;
  try {
    candidates = await input.registryQuery(query, input.actor);
  } catch (error) {
    // The registry query itself FAILED (a DB error). This is NOT a no-match — we
    // could not even DECIDE. Fail-closed LOUD: a broken registry HALTS onboarding (a
    // needs_attention the operator resolves), it never silently scaffolds the project
    // from an empty repo.
    log.warn("registry query failed — HALTING fail-closed (no project-direct from-scratch)", {}, error);
    throw new TemplateRequiredError(input.lifecycle.stack, error);
  }

  const ranked = rankTemplates(candidates, input.lifecycle, channelPreference, now);
  const top = ranked[0];
  if (top === undefined) {
    // NO eligible candidate → trigger JUST-IN-TIME CREATION (templating-system.md
    // §3 / §2). The `createForNoMatch` seam runs the creation meta-flow SYNCHRONOUSLY
    // and SEEDS from the freshly-published template (the scaffold GATES on it). An
    // absent seam or a failed creation is a LOUD HALT (`TemplateRequiredError`) —
    // there is NO project-direct from-scratch fallback.
    return createForNoMatchOrHalt(input, query);
  }

  // FINAL FAIL-CLOSED RE-CHECK at the decision boundary. The ranker already filtered
  // on freshness, but re-assert here so the SELECTED candidate is provably fresh at
  // the moment of decision (defence in depth — and the seam where a future async gap
  // between query + decide would otherwise leak a stale seed).
  const proof = top.template.manifest.validationProof;
  if (!isTemplateEligible(top.template, now) || proof === null) {
    log.warn(
      "top candidate failed the final freshness re-check (proof stale/missing) — REJECTING the seed; " +
        "treating as a no-match → just-in-time creation (no project-direct from-scratch)",
      { templateId: top.template.id },
    );
    // A stale/unusable top candidate is effectively a no-match: trigger creation (or
    // HALT loud). Never a project-direct from-scratch seed off a stale template.
    return createForNoMatchOrHalt(input, query);
  }

  const selected: SelectedTemplate = {
    templateRef: top.template.id,
    repoRef: top.template.repoRef,
    validationProof: proof,
  };
  const kind: SelectionKind = top.score >= STRONG_MATCH_THRESHOLD ? "strong" : "partial";
  return { kind, selected, query, topScore: top.score, reasons: top.reasons };
}

// The "no eligible template" branch (templating-system.md §3). The `createForNoMatch`
// seam runs the creation meta-flow SYNCHRONOUSLY and, on success, returns a STRONG
// seed from the freshly-published template (the project scaffold GATES on it). The
// seam being ABSENT, or creation FAILING / producing no usable template, is a LOUD
// FAIL-CLOSED HALT (`TemplateRequiredError`) — NOT a project-direct from-scratch
// scaffold. The from-scratch authoring lives ONLY inside the creation flow (it
// authors the TEMPLATE, validated before this seed is returned).
async function createForNoMatchOrHalt(
  input: SelectTemplateInput,
  query: TemplateCapabilityQuery,
): Promise<TemplateSelectionDecision> {
  if (input.createForNoMatch === undefined) {
    // No creation seam wired on a project-init path — we cannot create a validated
    // template, and we will NOT scaffold the project from-scratch. Halt LOUD.
    log.warn(
      "no eligible template AND no creation flow wired — HALTING fail-closed (no from-scratch project scaffold)",
      {
        stack: input.lifecycle.stack,
        query: JSON.stringify(query),
      },
    );
    throw new TemplateRequiredError(input.lifecycle.stack);
  }
  let created: SelectedTemplate | undefined;
  try {
    created = await input.createForNoMatch(input.lifecycle);
  } catch (error) {
    // A creation that FAILED (ungrounded research / failed validation / build
    // non-convergence) is a LOUD HALT — never a silent degrade to from-scratch.
    log.warn(
      "no eligible template — just-in-time creation FAILED; HALTING fail-closed",
      { stack: input.lifecycle.stack },
      error,
    );
    throw new TemplateRequiredError(input.lifecycle.stack, error);
  }
  if (created === undefined) {
    log.warn("no eligible template — just-in-time creation produced no usable template; HALTING fail-closed", {
      stack: input.lifecycle.stack,
    });
    throw new TemplateRequiredError(input.lifecycle.stack);
  }
  // CREATED + SEED: a freshly-validated template seeds the scaffold (a strong match).
  return { kind: "strong", selected: created, query, reasons: ["created", "no-prior-template"] };
}
