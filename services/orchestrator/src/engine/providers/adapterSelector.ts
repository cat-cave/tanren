import type {
  AuditAnswer,
  CheckAnswer,
  ConflictAnswer,
  ConvergenceAnswer,
  DemoAnswer,
  DemoRunAnswer,
  PlanAnswer,
  ReviewAnswer,
  TriageAnswer,
} from "../answerers/schemas/index.js";
import type { SpecQualityAnswer } from "../answerers/schemas/specQuality.js";
import { type SpecQualityAnswerer, wrapProviderSpecQualityAnswerer } from "../forge/specQuality/index.js";
import type { RoutingChainEntry, RoutingTable } from "../config/shared.js";
import type { RunnerHandle } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { timedAnswererAdapter, timedWriterAdapter } from "../observability/index.js";
import { createAiderWriter } from "./aider.js";
import { createClaudeAnswerer, createClaudeWriter } from "./claude.js";
import { createCodexAnswerer, createCodexWriter } from "./codex.js";
import { ANSWERER_CAPABLE_CLIS, harnessSupportsRole, WRITER_CAPABLE_CLIS } from "./harnessCapability.js";
import { createOpencodeWriter } from "./opencode.js";
import { createPiWriter } from "./pi.js";
import { createReasonixWriter } from "./reasonix.js";
import type { AnswererAdapter, WriterAdapter } from "./types.js";

// resolves a routing-table fallback-chain entry (
// { cli, model, authRef, healthHint? }) into a concrete Writer/Answerer
// adapter. This is the selector the buildAdapters path uses to make the new
// Claude + opencode providers selectable as chain entries — WITHOUT any schema
// or DB migration. The routing schema (RoutingChainEntry in config/shared.ts)
// already models per-role provider chains with free-form `cli`/`model` strings,
// so adding a provider is purely a matter of teaching THIS selector to build
// its adapter from a chain entry; no persisted shape changes.
//
// Supported CLIs:
//   - "codex":    Writer + Answerer (the default template)
//   - "claude":   Writer + Answerer
//   - "opencode": Writer only, Zai GLM 5.1 (no Answerer; mirrors the type-level
//                 AnswererAdapter.cli union which excludes opencode)
//   - "aider":    Writer only (no structured output → no Answerer; rejected as
//                 an answerer by the capability table)
//   - "pi":       Writer only (@earendil-works/pi-coding-agent; per-provider
//                 env-key auth; no structured answer → no Answerer)
//   - "reasonix": Writer only (DeepSeek-native; DEEPSEEK_API_KEY auth;
//                 NDJSON telemetry but no structured answer → no Answerer)

// The provider CLIs this selector can resolve, DERIVED from the harness
// capability table (harnessCapability.ts) — the single source of truth for
// which harness can serve which protocol role. Kept as values (not just types)
// so callers can validate / enumerate selectable providers for the operator UI
// without a separate source of truth. Adding a harness = one capability entry +
// its adapter; these sets and the role checks below follow automatically.
export const SELECTABLE_WRITER_CLIS = WRITER_CAPABLE_CLIS;

export const SELECTABLE_ANSWERER_CLIS = ANSWERER_CAPABLE_CLIS;

export interface AdapterSelectorDependencies {
  secrets: SecretStore;
  ssh: CommandSubstrate;
  target: RunnerHandle;
  runId: string;
  // SaaS Tier-B #5: optional OpenAI-compatible base URL for a MANAGED run. When
  // present (resolveCredentialsForRun returned `providerMode === "managed"`),
  // every adapter this selector builds is pointed at this endpoint (the platform
  // OpenRouter shell). Absent ⇒ BYOK: adapters use their native endpoints
  // (unchanged). It is run-wide, not per-chain-entry, because the toggle lives
  // at the org/project layer, not the routing chain.
  endpointBaseUrl?: string;
}

export class UnsupportedProviderError extends Error {
  constructor(
    readonly cli: string,
    readonly role: "writer" | "answerer",
  ) {
    super(`unsupported ${role} provider cli: ${cli}`);
    this.name = "UnsupportedProviderError";
  }
}

// Builds a Writer adapter for a routing chain entry. The entry's `authRef` is
// the per-provider credential ref the adapter materializes at call time, and
// `model` (when present) pins the model the CLI runs.
export function buildWriterAdapter(deps: AdapterSelectorDependencies, entry: RoutingChainEntry): WriterAdapter {
  const base = {
    secrets: deps.secrets,
    ssh: deps.ssh,
    target: deps.target,
    runId: deps.runId,
    credentialRef: entry.authRef,
    endpointBaseUrl: deps.endpointBaseUrl,
  };
  // The harness capability table gates role-eligibility (harnessCapability.ts):
  // a cli the table does not mark "write"-capable is rejected before we try to
  // build an adapter for it.
  if (!harnessSupportsRole(entry.cli, "write")) {
    throw new UnsupportedProviderError(entry.cli, "writer");
  }
  // wrap the built adapter so every real provider call emits a
  // boundary timing record. The adapter's core logic is untouched.
  switch (entry.cli) {
    case "codex":
      return timedWriterAdapter(createCodexWriter(base));
    case "claude":
      return timedWriterAdapter(createClaudeWriter({ ...base, model: entry.model }));
    case "opencode":
      return timedWriterAdapter(createOpencodeWriter({ ...base, model: entry.model }));
    case "aider":
      return timedWriterAdapter(createAiderWriter({ ...base, model: entry.model }));
    case "pi":
      return timedWriterAdapter(createPiWriter({ ...base, model: entry.model }));
    case "reasonix":
      return timedWriterAdapter(createReasonixWriter({ ...base, model: entry.model }));
    default:
      throw new UnsupportedProviderError(entry.cli, "writer");
  }
}

// Builds an Answerer adapter for a routing chain entry. opencode is Writer-only
// in this expansion, so it is intentionally not resolvable here (matching the
// AnswererAdapter.cli type union which excludes "opencode").
export function buildAnswererAdapter<TOutput>(
  deps: AdapterSelectorDependencies,
  entry: RoutingChainEntry,
  // the loop role (plan/check/audit/demo) the resolved Answerer
  // serves, threaded into the boundary timing record. Defaults to the generic
  // "answerer" dimension when a caller does not pin a role.
  role = "answerer",
): AnswererAdapter<TOutput> {
  const base = {
    secrets: deps.secrets,
    ssh: deps.ssh,
    target: deps.target,
    runId: deps.runId,
    credentialRef: entry.authRef,
    endpointBaseUrl: deps.endpointBaseUrl,
  };
  // Answerer-eligibility is the harness's structured-output capability: a cli
  // not marked "answer"-capable in the table (e.g. opencode, writer-only) is
  // rejected here — the same UnsupportedProviderError surfaced for an unknown
  // cli below, just decided from the single capability source of truth.
  if (!harnessSupportsRole(entry.cli, "answer")) {
    throw new UnsupportedProviderError(entry.cli, "answerer");
  }
  switch (entry.cli) {
    case "codex":
      return timedAnswererAdapter(createCodexAnswerer<TOutput>(base), role);
    case "claude":
      return timedAnswererAdapter(createClaudeAnswerer<TOutput>({ ...base, model: entry.model }), role);
    default:
      throw new UnsupportedProviderError(entry.cli, "answerer");
  }
}

// The four loop roles SubtaskLoopAdapters needs. Mirrors the planner-loop seam
// in plannerRun.ts (planner/writer/checker/auditor) so a routing table can be
// resolved into a ready-to-run adapter set without touching the Codex path.
export interface RoutingDrivenAdapters {
  planner: AnswererAdapter<PlanAnswer>;
  writer: WriterAdapter;
  checker: AnswererAdapter<CheckAnswer>;
  auditor: AnswererAdapter<AuditAnswer>;
  // SPEC-LOOP REDESIGN stages (ride the `audit` chain head).
  triage: AnswererAdapter<TriageAnswer>;
  convergence: AnswererAdapter<ConvergenceAnswer>;
  demoRun: AnswererAdapter<DemoRunAnswer>;
}

export class EmptyRoutingChainError extends Error {
  constructor(readonly role: string) {
    super(`routing chain for role '${role}' is empty; no provider to select`);
    this.name = "EmptyRoutingChainError";
  }
}

// Resolves a routing table into the loop's four adapters by taking the HEAD of
// each role's fallback chain (the primary provider). The plan→planner,
// write→writer, check→checker, audit→auditor mapping matches the loop roles.
// This is the buildAdapters seam through which Claude + opencode become
// selectable: a project whose `write` chain heads with
// { cli: "opencode", model: "zai/glm-5.1", authRef } now runs the opencode
// Writer, with NO schema or DB migration (the chain shape is unchanged).
export function buildAdaptersFromRouting(
  deps: AdapterSelectorDependencies,
  routing: RoutingTable,
): RoutingDrivenAdapters {
  // SPEC-LOOP REDESIGN: triage/convergence/demoRun are answerers with no dedicated
  // routing chain (like review/conflict) — they ride the `audit` chain head, the same
  // judge-shaped role, with NO schema/DB migration.
  const auditHead = chainHead(routing, "audit");
  return {
    planner: buildAnswererAdapter<PlanAnswer>(deps, chainHead(routing, "plan"), "planner"),
    writer: buildWriterAdapter(deps, chainHead(routing, "write")),
    checker: buildAnswererAdapter<CheckAnswer>(deps, chainHead(routing, "check"), "checker"),
    auditor: buildAnswererAdapter<AuditAnswer>(deps, auditHead, "auditor"),
    triage: buildAnswererAdapter<TriageAnswer>(deps, auditHead, "triage"),
    convergence: buildAnswererAdapter<ConvergenceAnswer>(deps, auditHead, "convergence"),
    demoRun: buildAnswererAdapter<DemoRunAnswer>(deps, auditHead, "demoRun"),
  };
}

function chainHead(routing: RoutingTable, role: "plan" | "write" | "check" | "audit"): RoutingChainEntry {
  const head = routing[role].chain[0];
  if (head === undefined) {
    throw new EmptyRoutingChainError(role);
  }
  return head;
}

// Resolves the simulated reviewer's Answerer (reviewPolicy: "simulated"). There
// is no dedicated `review` routing chain — the reviewer is a final-verdict judge
// over the PR diff + acceptance criteria, the same shape the `audit` role plays,
// so it reuses the `audit` chain head (Codex by default, or whatever the audit
// chain names). This keeps the simulated reviewer selectable with NO schema or
// DB migration: it rides the existing per-role routing DATA.
export function buildSimulatedReviewerAdapter(
  deps: AdapterSelectorDependencies,
  routing: RoutingTable,
): AnswererAdapter<ReviewAnswer> {
  return buildAnswererAdapter<ReviewAnswer>(deps, chainHead(routing, "audit"), "review");
}

// Resolves the spec-quality VALIDATOR (workstream 1 of the spec-loop redesign) — the
// read-only answerer that gates every spec-emitter's output (incl. the loop's TRIAGE)
// against the four-part spec-quality contract before it lands in the DAG. Like the
// reviewer/conflict answerers it has no dedicated routing chain; it is a judge over
// authored spec content, so it rides the `audit` chain head with NO schema/DB
// migration. Wrapped so a malformed answer THROWS (loud, never a default pass).
export function buildSpecQualityValidator(
  deps: AdapterSelectorDependencies,
  routing: RoutingTable,
): SpecQualityAnswerer {
  const adapter = buildAnswererAdapter<SpecQualityAnswer>(deps, chainHead(routing, "audit"), "specQuality");
  return wrapProviderSpecQualityAnswerer(adapter);
}

// Resolves the intent-preserving conflict-resolution Answerer (
// autonomy-engine.md §2b). Like the simulated reviewer, there is no dedicated
// `conflict` routing chain — resolving a DAG-aware conflict is a high-stakes
// reasoning judgment over BOTH specs' intent + the conflict hunks + the DAG
// edge, the same provider class the `audit` role plays — so it rides the
// `audit` chain head (Codex by default, or whatever the audit chain names). This
// keeps the resolver selectable with NO schema or DB migration: it rides the
// existing per-role routing DATA, exactly like every other Answerer.
export function buildConflictResolverAdapter(
  deps: AdapterSelectorDependencies,
  routing: RoutingTable,
): AnswererAdapter<ConflictAnswer> {
  return buildAnswererAdapter<ConflictAnswer>(deps, chainHead(routing, "audit"), "conflict");
}

// resolves the project's `demo` routing chain into an Answerer that
// emits the DemoAnswer. The demo role defaults to an EMPTY chain
// (see RoutingTable in config/shared.ts), so a project without a configured
// demo credential resolves to `null` — the signal the demo narrator uses to
// fall back to its deterministic template instead of hard-failing. When the
// chain IS configured, its head selects the provider (Codex by default, or
// Claude when the entry's cli is "claude"), reusing buildAnswererAdapter so
// the demo role shares the exact provider seam every other Answerer uses.
export function buildDemoAnswererOrNull(
  deps: AdapterSelectorDependencies,
  routing: RoutingTable,
): AnswererAdapter<DemoAnswer> | null {
  const head = routing.demo.chain[0];
  if (head === undefined) {
    return null;
  }
  return buildAnswererAdapter<DemoAnswer>(deps, head, "demo");
}
