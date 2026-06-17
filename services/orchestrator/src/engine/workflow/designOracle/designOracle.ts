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
import type { AnswererAdapter } from "../../providers/types.js";
import { DesignContractStore } from "../../repositories/designContracts.js";
import {
  buildDesignOraclePrompt,
  type ResolvedBehavior,
  type ResolvedDimension,
  type ResolvedPersona,
} from "./designOraclePrompt.js";

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
  timeoutMs: number;
  // The read-only workspace the oracle self-inspects (the built output).
  workspacePath: string;
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
 * (loud on a malformed persisted row — the store re-parses through the schema),
 * RESOLVES every persona/behavior ref the contract names against the entity graph
 * (loud when a ref does not resolve — malformed graph state, never a silent skip),
 * builds the domain-aware oracle prompt, invokes the answerer in the read-only
 * workspace, and returns the normalized findings + the declared verification mode.
 *
 * When the project has NO contract, returns `{ hasContract: false, findings: [] }` —
 * an explicit empty state the caller branches on, never a defaulted contract.
 */
export async function runDesignOracleStage(input: DesignOracleStageInput): Promise<DesignOracleStageResult> {
  const record = await DesignContractStore.getLatest(input.client, input.projectId, input.actorRef);
  if (record === undefined) {
    return { hasContract: false, findings: [] };
  }
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
  });

  const outputSchema = answererOutputSchemaFor("designOracle", DesignOracleAnswerSchema);
  const verdict = await input.adapter.runAnswerer({
    prompt,
    timeoutMs: input.timeoutMs,
    workspace: input.workspacePath,
    outputSchema,
  });

  return {
    hasContract: true,
    contractVersion: record.version,
    verificationMode: verdict.verificationMode,
    summary: verdict.summary,
    findings: verdict.findings.map((finding) => normalizeFinding(finding)),
  };
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
