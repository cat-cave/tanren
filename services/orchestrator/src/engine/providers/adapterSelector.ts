import type { AuditAnswer, CheckAnswer, DemoAnswer, PlanAnswer } from "../answerers/schemas/index.js";
import type { RoutingChainEntry, RoutingTable } from "../config/shared.js";
import type { SshTarget } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { timedAnswererAdapter, timedWriterAdapter } from "../observability/index.js";
import { createAiderWriter } from "./aider.js";
import { createClaudeAnswerer, createClaudeWriter } from "./claude.js";
import { createCodexAnswerer, createCodexWriter } from "./codex.js";
import { ANSWERER_CAPABLE_CLIS, harnessSupportsRole, WRITER_CAPABLE_CLIS } from "./harnessCapability.js";
import { createOpencodeWriter } from "./opencode.js";
import type { AnswererAdapter, WriterAdapter } from "./types.js";

// P3-0012: resolves a routing-table fallback-chain entry (P2A-0006:
// { cli, model, authRef, healthHint? }) into a concrete Writer/Answerer
// adapter. This is the selector the buildAdapters path uses to make the new
// Claude + opencode providers selectable as chain entries — WITHOUT any schema
// or DB migration. The routing schema (RoutingChainEntry in config/shared.ts)
// already models per-role provider chains with free-form `cli`/`model` strings,
// so adding a provider is purely a matter of teaching THIS selector to build
// its adapter from a chain entry; no persisted shape changes.
//
// Supported CLIs:
//   - "codex":    Writer + Answerer (the P2A template; unchanged)
//   - "claude":   Writer + Answerer
//   - "opencode": Writer only, Zai GLM 5.1 (no Answerer; mirrors the type-level
//                 AnswererAdapter.cli union which excludes opencode)
//   - "aider":    Writer only (no structured output → no Answerer; rejected as
//                 an answerer by the capability table)

// The provider CLIs this selector can resolve, DERIVED from the harness
// capability table (harnessCapability.ts) — the single source of truth for
// which harness can serve which protocol role. Kept as values (not just types)
// so callers can validate / enumerate selectable providers for the operator UI
// without a separate source of truth. Adding a harness = one capability entry +
// its adapter; these sets and the role checks below follow automatically.
export const SELECTABLE_WRITER_CLIS = WRITER_CAPABLE_CLIS;
export type SelectableWriterCli = (typeof SELECTABLE_WRITER_CLIS)[number];

export const SELECTABLE_ANSWERER_CLIS = ANSWERER_CAPABLE_CLIS;
export type SelectableAnswererCli = (typeof SELECTABLE_ANSWERER_CLIS)[number];

export interface AdapterSelectorDependencies {
  secrets: SecretStore;
  ssh: SshSubstrate;
  target: SshTarget;
  runId: string;
}

export class UnsupportedProviderError extends Error {
  constructor(
    readonly cli: string,
    readonly role: "writer" | "answerer"
  ) {
    super(`unsupported ${role} provider cli: ${cli}`);
    this.name = "UnsupportedProviderError";
  }
}

// Builds a Writer adapter for a routing chain entry. The entry's `authRef` is
// the per-provider credential ref the adapter materializes at call time, and
// `model` (when present) pins the model the CLI runs.
export function buildWriterAdapter(deps: AdapterSelectorDependencies, entry: RoutingChainEntry): WriterAdapter {
  const base = { secrets: deps.secrets, ssh: deps.ssh, target: deps.target, runId: deps.runId, credentialRef: entry.authRef };
  // The harness capability table gates role-eligibility (harnessCapability.ts):
  // a cli the table does not mark "write"-capable is rejected before we try to
  // build an adapter for it.
  if (!harnessSupportsRole(entry.cli, "write")) {
    throw new UnsupportedProviderError(entry.cli, "writer");
  }
  // P3-0029: wrap the built adapter so every real provider call emits a
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
  // P3-0029: the loop role (plan/check/audit/demo) the resolved Answerer
  // serves, threaded into the boundary timing record. Defaults to the generic
  // "answerer" dimension when a caller does not pin a role.
  role = "answerer"
): AnswererAdapter<TOutput> {
  const base = { secrets: deps.secrets, ssh: deps.ssh, target: deps.target, runId: deps.runId, credentialRef: entry.authRef };
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
export function buildAdaptersFromRouting(deps: AdapterSelectorDependencies, routing: RoutingTable): RoutingDrivenAdapters {
  return {
    planner: buildAnswererAdapter<PlanAnswer>(deps, chainHead(routing, "plan"), "planner"),
    writer: buildWriterAdapter(deps, chainHead(routing, "write")),
    checker: buildAnswererAdapter<CheckAnswer>(deps, chainHead(routing, "check"), "checker"),
    auditor: buildAnswererAdapter<AuditAnswer>(deps, chainHead(routing, "audit"), "auditor")
  };
}

function chainHead(routing: RoutingTable, role: "plan" | "write" | "check" | "audit"): RoutingChainEntry {
  const head = routing[role].chain[0];
  if (head === undefined) {
    throw new EmptyRoutingChainError(role);
  }
  return head;
}

// P3-0011: resolves the project's `demo` routing chain into an Answerer that
// emits the P2A-0008 DemoAnswer. The demo role defaults to an EMPTY chain
// (see RoutingTable in config/shared.ts), so a project without a configured
// demo credential resolves to `null` — the signal the demo narrator uses to
// fall back to its deterministic template instead of hard-failing. When the
// chain IS configured, its head selects the provider (Codex by default, or
// Claude when the entry's cli is "claude"), reusing buildAnswererAdapter so
// the demo role shares the exact provider seam every other Answerer uses.
export function buildDemoAnswererOrNull(
  deps: AdapterSelectorDependencies,
  routing: RoutingTable
): AnswererAdapter<DemoAnswer> | null {
  const head = routing.demo.chain[0];
  if (head === undefined) {
    return null;
  }
  return buildAnswererAdapter<DemoAnswer>(deps, head, "demo");
}
