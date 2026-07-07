// Design-Oracle stage (WS-D4 of docs/roadmap/native-design-subsystem.md). The
// domain-aware design VERIFICATION answerer: it reads the project's HEAD
// `DesignContract` (WS-D1, via `DesignContractStore.getLatest`), RESOLVES the
// contract's first-class persona + behavior refs against the actual entity graph,
// inspects the built output in a READ-ONLY sandbox, and emits findings for
// behavior-coverage gaps + persona-scoped fidelity misses + violated dimensions.
//
// THE MOAT — this exploits Tanren's native graph in a way no standalone design tool
// can. The contract's `behaviorRefs`/`personaRefs` are TYPED entity ids, so the
// oracle resolves them STRICTLY (no "assume admin" guessing) and builds an
// EXHAUSTIVE behavior-coverage checklist from first-class behaviors. The verification
// MODE is domain-derived (web → render/inspect; novel → prose/typography; …) — Tanren
// NEVER branches on the domain; the agent chooses the mode from the contract.
//
// FINDINGS-ONLY: like the auditor + demo-run, the oracle emits findings (explicit
// P0–P3) and renders NO verdict. The findings are normalized to the frozen `Finding`
// currency so they flow into the SAME triage/convergence routing — a genuine fidelity
// gap RE-DRIVES the writer exactly like any other gate finding (the no-handoff loop).
//
// NO SILENT DEFAULTS:
//   - an ABSENT contract (no `design_contracts` row) is an EXPLICIT state the caller
//     branches on (`hasContract: false`, empty findings) — never a defaulted contract;
//   - a contract ref that DOES NOT RESOLVE against the entity graph (a personaRef /
//     behaviorRef with no row, or off-scope under RLS) is MALFORMED graph state and
//     throws LOUDLY — the oracle never silently drops an obligation it cannot resolve.
//
// RE-ELABORATION GAP (loud, not silent): the design phase runs ONCE at derive, so the
// contract's `behaviorRefs` are the derive-time behavior set. A multi-spec build that
// adds NEW behaviors downstream leaves them OUTSIDE the contract — the design was never
// re-elaborated to cover them, and the moat ("exhaustive behavior coverage") silently
// degrades to "exhaustive as of the first interview". The oracle detects this: it
// compares the contract's `behaviorRefs` against the project's FULL CURRENT behavior
// set and emits an explicit P2 Finding per behavior added after design (rather than
// silently verifying only the stale set). The finding flows into the SAME triage as
// every other oracle finding, surfacing the gap (and re-driving) until the design is
// re-elaborated. The full automatic re-elaboration trigger (re-running the design phase
// to mint a new contract version on a behavior-graph change) is the durable follow-up;
// this loud-gap detection is the no-silent-fallback floor it builds on.
//
// WIRING SEAM (minimal by design — WS-D2 owns the writer-injection side): this module
// exposes `runDesignOracleStage`, which returns the normalized findings + the declared
// verification mode + summary. The live gate / re-drive integration (appending the
// stage to the spec loop next to the demo-run stage, feeding findings into triage) is
// a thin call-site that a follow-up wires once it will not collide with WS-D2's writer
// changes; the capability + its contract are complete here.

import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";
import {
  answererOutputSchemaFor,
  type DesignOracleAnswer,
  DesignOracleAnswer as DesignOracleAnswerSchema,
  normalizeFinding,
} from "../../answerers/schemas/index.js";
import type { Finding } from "../../contracts/findings.js";
import { BehaviorStore } from "../../entities/behaviors.js";
import { PersonaStore } from "../../entities/personas.js";
import type { ActorRef } from "../../state/actor.js";
import type { SpecMode } from "../../state/spec.js";
import type { AnswererAdapter } from "../../providers/types.js";
import { DesignContractStore } from "../../repositories/designContracts.js";
import {
  buildDesignOraclePrompt,
  type ResolvedBehavior,
  type ResolvedDimension,
  type ResolvedPersona,
} from "./designOraclePrompt.js";

/**
 * The design oracle was called with an actor that CANNOT enumerate the project's
 * behaviors — the primary detectable form is `actor.orgId === null`, a caller
 * misconfiguration that would otherwise silently suppress the re-elaboration-gap
 * finding path AND make the store's `absent` state indistinguishable from an
 * off-scope RLS block (Codex critic #7 / #8). A typed class so the finalize guard
 * classifier maps it deterministically and it is never a `crashed` opaque default.
 * Mirrors the neighbor convention (`MalformedAncestorStackError` in
 * `engine/dag/ancestorStack.ts`, PR #740): a caller-config fault throws loud.
 */
export class DesignOracleActorConfigError extends Error {
  constructor(
    /** The project the oracle was invoked against (for diagnostics). */
    readonly projectId: string,
    /** The concrete misconfiguration (e.g. "actor.orgId is null"). */
    readonly reason: string,
  ) {
    super(
      `design oracle: actor cannot enumerate project '${projectId}' — ${reason}. ` +
        "A design run REQUIRES a tenant-scoped actor; a null orgId silently suppresses the " +
        "re-elaboration gap detection AND makes the contract-store `absent` state " +
        "indistinguishable from an off-scope RLS block (Codex critic #7 / #8).",
    );
    this.name = "DesignOracleActorConfigError";
  }
}

/**
 * The oracle's answerer returned a `hasContract: true` result but at least one of
 * the timeline-observable fields (`contractVersion`, `verificationMode`, `summary`)
 * was missing or empty. Under the previous silent-fallback shape the loop-stage
 * body coerced these to `0` / `""` on the `designOracle.verdict` event payload,
 * so a malformed oracle result was indistinguishable from a legitimate empty
 * verdict on the run timeline (Codex critic #6). Typed so the finalize guard
 * emits a deterministic `task.failed` + the operator can search for it on the
 * timeline, rather than the `crashed` opaque default.
 */
export class MalformedDesignOracleResultError extends Error {
  constructor(
    /** The specific field(s) that were missing / empty. */
    readonly detail: string,
  ) {
    super(
      `design oracle: hasContract=true result is malformed — ${detail}. The verdict event ` +
        "would otherwise record plausible-looking empty metadata (contractVersion=0, " +
        "verificationMode='', summary='') and hide the oracle regression (Codex critic #6).",
    );
    this.name = "MalformedDesignOracleResultError";
  }
}

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface DesignOracleStageInput {
  client: QueryClient;
  projectId: string;
  // The org-scope carrier for the entity-graph reads (personas/behaviors).
  actor: ActorContext;
  // The audit/event actor for the contract store reads.
  actorRef: ActorRef;
  adapter: AnswererAdapter<DesignOracleAnswer>;
  baselineSha: string;
  // The read-only workspace the oracle self-inspects (the built output).
  workspacePath: string;
  // OPTIONAL spec writer-prompt MODE (audit round-2 H1). Threaded through to the
  // designOracle prompt so a `specialize_seed` spec gets the seeded-mode tail block
  // that scopes the oracle off the pre-existing seed surfaces, mirroring PR #708's
  // checker/auditor lift. Absent / `from_scratch` ⇒ no block (byte-identical to the
  // legacy oracle prompt).
  specMode?: SpecMode;
}

export interface DesignOracleStageResult {
  // false ⇒ the project has no `DesignContract` yet (a real empty state). The caller
  // skips design verification — it NEVER fabricates a defaulted contract.
  hasContract: boolean;
  // The contract version verified against (undefined when `hasContract` is false).
  contractVersion?: number;
  // The domain-derived verification mode the oracle declared it used (undefined when
  // no contract). Recorded for observability of the domain-aware posture.
  verificationMode?: string;
  // The oracle's human-facing narration of what it inspected (undefined when no
  // contract).
  summary?: string;
  // The design fidelity findings, normalized to the frozen `Finding` currency so they
  // merge with the auditor's + demo's into ONE triage input. Empty when design-faithful
  // OR when there is no contract.
  findings: Finding[];
}

/**
 * Run the design oracle against a project's HEAD design contract. Reads the contract
 * via the TYPED-STATE lookup (Codex critic #7 — a `corrupt` row throws loud, never a
 * silent skip; only `absent` legitimately no-ops), RESOLVES every persona/behavior
 * ref the contract names against the entity graph (loud when a ref does not
 * resolve — malformed graph state, never a silent skip), builds the domain-aware
 * oracle prompt, invokes the answerer in the read-only workspace, and returns the
 * normalized findings + the declared verification mode.
 *
 * PRE-STORE ACTOR CHECK (Codex critic #7 / #8): a `null` `actor.orgId` throws
 * {@link DesignOracleActorConfigError} BEFORE the store read — a tenant-less actor
 * cannot enumerate the project's behaviors, so the re-elaboration-gap detector
 * would silently return `[]` AND the store's `absent` state would be
 * indistinguishable from an off-scope RLS block. The upstream check turns both
 * silent-suppression paths into one loud fault.
 *
 * When the project has NO contract (the typed-state `absent` variant), returns
 * `{ hasContract: false, findings: [] }` — an explicit empty state the caller
 * branches on, never a defaulted contract.
 */
export async function runDesignOracleStage(input: DesignOracleStageInput): Promise<DesignOracleStageResult> {
  // Pre-store actor check: without a tenant scope we cannot enumerate the project's
  // behaviors (re-elaboration-gap detector needs listForProject) AND the store's
  // absent-vs-off-scope collision becomes indistinguishable. Fail loud upstream so
  // the finalize guard emits `DesignOracleActorConfigError` — not a `crashed` opaque
  // default AND not a silent skip (Codex critic #7 / #8).
  if (input.actor.orgId === null) {
    throw new DesignOracleActorConfigError(input.projectId, "actor.orgId is null");
  }
  // Read the project's HEAD contract. H2 BLOCKING (unify): the DesignContract
  // is PROJECT-scoped (shared across every spec type — scaffold specs need
  // product identity for README naming; feature specs need it for behavior
  // grading; there is exactly ONE product-level head per project). The prior
  // per-writer-prompt-mode split silently no-op'd for scaffold/build/deploy
  // specs — migration 0028 collapsed it. The oracle prompt's `specMode` tail
  // block (below) remains the v64-load-bearing writer-vs-oracle mode signal.
  const lookup = await DesignContractStore.getLatestState(input.client, input.projectId, input.actorRef);
  if (lookup.kind === "corrupt") {
    // Never a silent skip — a corrupt persisted contract is a hard fault the
    // finalize guard closes the task row on and the operator sees on the
    // timeline (Codex critic #7). Re-throw the typed error the store built.
    throw lookup.error;
  }
  if (lookup.kind === "absent") {
    return { hasContract: false, findings: [] };
  }
  const record = lookup.record;
  const contract = record.contract;

  // Resolve persona refs STRICTLY: a ref with no row (or off-scope under RLS) is
  // malformed graph state — throw, never silently drop a persona obligation.
  const personas = await resolvePersonas(input.client, contract.personaRefs, input.actor);

  // Resolve behavior refs STRICTLY (the exhaustive coverage obligation): each ref
  // must resolve to a real behavior, else the coverage checklist would be silently
  // incomplete — a loud failure.
  const behaviors = await resolveBehaviors(input.client, contract.behaviorRefs, input.actor);

  const dimensions: ResolvedDimension[] = contract.dimensions.map((dimension) => ({
    key: dimension.key,
    label: dimension.label,
    intent: dimension.intent,
    guidance: dimension.guidance,
    personaRefs: dimension.personaRefs,
  }));

  const prompt = buildDesignOraclePrompt({
    domain: contract.domain,
    identity: contract.identity,
    intent: contract.intent,
    principles: contract.principles,
    constraints: contract.constraints,
    dimensions,
    personas,
    behaviors,
    baselineSha: input.baselineSha,
    ...(input.specMode !== undefined && { specMode: input.specMode }),
  });

  const outputSchema = answererOutputSchemaFor("designOracle", DesignOracleAnswerSchema);
  const verdict = await input.adapter.runAnswerer({
    prompt,
    workspace: input.workspacePath,
    outputSchema,
  });

  // RE-ELABORATION GAP — loud-surface behaviors added to the project AFTER the design
  // phase ran (the contract's `behaviorRefs` are the derive-time set). Each such
  // behavior is un-designed: the contract was never re-elaborated to cover it. Emit an
  // explicit Finding per uncovered behavior so the gap is surfaced + re-driven, never
  // silently passed (the moat would otherwise degrade to "exhaustive as of derive").
  const reElaborationFindings = await detectReElaborationGap(input, contract.behaviorRefs);

  return {
    hasContract: true,
    contractVersion: record.version,
    verificationMode: verdict.verificationMode,
    summary: verdict.summary,
    findings: [...reElaborationFindings, ...verdict.findings.map((finding) => normalizeFinding(finding))],
  };
}

/**
 * Detect behaviors added to the project AFTER the design phase: the project's FULL
 * current behavior set minus the contract's `behaviorRefs`. Each leftover is a behavior
 * the design has never covered (the phase runs ONCE at derive) — surfaced as an explicit
 * P2 Finding ("behavior X added after design; design not re-elaborated") so it enters
 * triage and re-drives, rather than the oracle silently verifying only the stale set.
 *
 * Domain-general: it reasons over first-class behavior entities, never any product
 * specifics. Reads are org-scoped (RLS) + actor-authorized, exactly like the resolution
 * above. A behavior that resolves above is necessarily in the project set, so this
 * never double-flags a covered ref.
 */
async function detectReElaborationGap(
  input: DesignOracleStageInput,
  behaviorRefs: ReadonlyArray<string>,
): Promise<Finding[]> {
  const covered = new Set(behaviorRefs);
  // The project's behavior set is enumerated org-scoped; an actor with no org has no
  // tenant to enumerate against. The prior fallback returned `[]` on `orgId === null`,
  // silently converting "cannot enumerate project behaviors" into "no re-elaboration
  // gaps" — a misconfigured design actor suppressed the ENTIRE re-elaboration-finding class
  // (Codex critic #8). The tenant-scope invariant is upheld here as a defense-in-depth
  // typed throw; the primary check runs upstream in `runDesignOracleStage` before the
  // store read, so this branch is unreachable under the normal call path — but if a
  // future caller invokes `detectReElaborationGap` directly, it still fails loud.
  if (input.actor.orgId === null) {
    throw new DesignOracleActorConfigError(
      input.projectId,
      "actor.orgId is null (re-elaboration-gap detector requires a tenant-scoped actor)",
    );
  }
  const personaRows = await PersonaStore.listForProject(
    input.client,
    { orgId: input.actor.orgId, projectId: input.projectId },
    input.actor,
  );
  const findings: Finding[] = [];
  for (const persona of personaRows) {
    const rows = await BehaviorStore.listForPersona(input.client, persona.id, input.actor);
    for (const row of rows) {
      if (covered.has(row.id)) continue;
      findings.push({
        // Stable per (project, behavior) so a re-audit dedupes the same gap.
        id: `design-re-elaboration:${input.projectId}:${row.id}`,
        severity: "P2",
        title: `behavior '${row.title}' added after design; design not re-elaborated`,
        body:
          `Behavior '${row.id}' ("${row.title}") exists in the project but is NOT in the HEAD design ` +
          "contract's behaviorRefs — it was added after the design phase ran (the phase runs once at " +
          "derive). The design has never covered this behavior, so its persona-scoped surface/flow is " +
          "undesigned. Re-elaborate the design contract to cover the FULL current behavior set " +
          "(DesignContractStore mints a new version — never-discard).",
        fixHint:
          "Re-run the design phase to author a new DesignContract version covering this behavior " +
          `(behaviorId '${row.id}', persona '${persona.id}').`,
      });
    }
  }
  return findings;
}

async function resolvePersonas(
  client: QueryClient,
  personaRefs: ReadonlyArray<string>,
  actor: ActorContext,
): Promise<ResolvedPersona[]> {
  const resolved: ResolvedPersona[] = [];
  for (const id of personaRefs) {
    const row = await PersonaStore.get(client, id, actor);
    if (row === undefined) {
      throw new Error(
        `design oracle: contract personaRef '${id}' does not resolve to a persona (missing or off-scope) — malformed graph state`,
      );
    }
    resolved.push({ id: row.id, name: row.name, description: row.description });
  }
  return resolved;
}

async function resolveBehaviors(
  client: QueryClient,
  behaviorRefs: ReadonlyArray<string>,
  actor: ActorContext,
): Promise<ResolvedBehavior[]> {
  const resolved: ResolvedBehavior[] = [];
  for (const id of behaviorRefs) {
    const row = await BehaviorStore.get(client, id, actor);
    if (row === undefined) {
      throw new Error(
        `design oracle: contract behaviorRef '${id}' does not resolve to a behavior (missing or off-scope) — malformed graph state`,
      );
    }
    /* eslint-disable unicorn/no-thenable */
    // "then" is the BDD Given/When/Then vocabulary (the behavior row's column name),
    // not a thenable object; the lint warning about awaitable objects does not apply.
    resolved.push({
      id: row.id,
      personaId: row.personaId,
      title: row.title,
      given: row.given,
      when: row.when,
      then: row.then,
    });
    /* eslint-enable unicorn/no-thenable */
  }
  return resolved;
}
