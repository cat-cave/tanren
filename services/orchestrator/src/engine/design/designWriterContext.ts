// Tanren-native design subsystem (WS-D2) — inject the project's HEAD
// `DesignContract` (WS-D1) into the WRITER prompt. This closes the core fidelity
// gap: today the writer/build agent receives ZERO design context, so UI/UX
// fidelity is whatever the LLM improvises from functional specs. WS-D2 threads the
// durable design artifact straight into Tanren's OWN implementing agent, in the
// SAME loop — the no-handoff proof (docs/roadmap/native-design-subsystem.md, the
// "structural advantage" + "moat" sections). Standalone design tools END at
// "handoff to a coding agent" and must ASK "who is this for? assume admin?"; this
// module instead RESOLVES the contract's first-class `personaRefs`/`behaviorRefs`
// against the project's REAL typed entity graph (the `personas`/`behaviors` tables)
// and renders a persona-scoped, behavior-linked design block.
//
// DOMAIN-GENERAL BY CONSTRUCTION. The render NEVER assumes web. It walks WHATEVER
// `dimensions` the contract declares (a SaaS app's tokens/components/layout, a
// game's art-direction/ui/game-feel, a novel's typography/voice/cover) — Tanren
// names no privileged dimension, exactly as the contract schema does not. The
// descriptive `domain` label is surfaced verbatim; Tanren never branches on it.
//
// NO SILENT DEFAULTS. A project with NO design contract yields `undefined` (the
// caller omits the design block entirely — a real empty state, never a fabricated
// "here's some default tokens" stub). A malformed persisted contract fails LOUDLY
// upstream in the store's `mapRow` (re-parse through the schema) before it ever
// reaches this render — a half-described contract is a loud failure, not a quiet
// degrade.
//
// This module is the LOAD + RENDER seam only. The writer prompt assembly
// (subtaskInnerLoop.ts) consumes the rendered block; the design ORACLE that
// verifies fidelity against the same contract is WS-D4.

import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import type { OrgScope } from "../credentials/resolveCredentials.js";
import { BehaviorStore } from "../entities/behaviors.js";
import { PersonaStore } from "../entities/personas.js";
import { DesignContractStore, type DesignContractRecord } from "../repositories/designContracts.js";
import type { DesignContractV1, DesignDimension } from "./designContract.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * A persona ref resolved to its human-readable identity. The writer needs the
 * NAME (and design-relevant description) — not the opaque `persona_<uuid>` id — so
 * it builds the right surface for the right role with no "assume default admin"
 * guessing.
 */
export interface ResolvedPersona {
  id: string;
  name: string;
  description: string;
}

/**
 * A behavior ref resolved to its given/when/then. These are the design ACCEPTANCE
 * CRITERIA the design is responsible for COVERING — surfaced to the writer so
 * design and implementation are driven by the SAME behaviors (closing the
 * designer↔implementor gap). `persona` attributes the behavior to its role.
 */
export interface ResolvedBehavior {
  id: string;
  persona: string;
  title: string;
  given: string;
  when: string;
  // The BDD then-OUTCOME (named `thenOutcome` to avoid a `then` object key, which
  // reads as a thenable — the same naming the conflict resolver's behavior shape uses).
  thenOutcome: string;
}

/** The contract + its refs resolved against the real entity graph, ready to render. */
export interface ResolvedDesignContext {
  contract: DesignContractV1;
  /** The contract-level personas this design serves (by id, in `personaRefs` order). */
  personasById: Map<string, ResolvedPersona>;
  /** The behaviors this design must cover (by id, in `behaviorRefs` order). */
  behaviorsById: Map<string, ResolvedBehavior>;
}

// ---- Render ----------------------------------------------------------------

function bulletList(lines: readonly string[]): string[] {
  return lines.map((line) => `- ${line}`);
}

// Render the personas a surface serves, resolved to names. `refs` is the ordered
// persona-ref list (contract-level or a dimension's). Unresolved refs are SKIPPED
// (the derive already drops dangling refs; this is belt-and-suspenders so a stale
// ref never leaks an opaque id into the prompt). Empty ⇒ undefined (the caller
// omits the line — for a dimension that means "applies to every persona on the
// contract", a real all-personas state).
function renderPersonaScope(refs: readonly string[], personasById: Map<string, ResolvedPersona>): string | undefined {
  const names = refs.map((id) => personasById.get(id)?.name).filter((name): name is string => name !== undefined);
  return names.length > 0 ? names.join(", ") : undefined;
}

// Render ONE domain-adaptive dimension. The dimension's `key`/`label`/`intent` are
// surfaced verbatim (the bar the writer builds toward); its OWN `personaRefs`
// express "THIS persona's view of THIS surface" (persona-scoped design) and are
// resolved to names. Tanren names no dimension — this renders whatever the
// contract declared.
function renderDimension(dimension: DesignDimension, personasById: Map<string, ResolvedPersona>): string[] {
  const out: string[] = [`- ${dimension.label} (${dimension.key}): ${dimension.intent}`];
  const scope = renderPersonaScope(dimension.personaRefs, personasById);
  if (scope !== undefined) {
    out.push(`  Persona view: ${scope}`);
  }
  if (dimension.guidance.trim() !== "") {
    out.push(`  Guidance: ${dimension.guidance}`);
  }
  return out;
}

// Render the resolved personas as a who-this-is-for block. Each carries its
// description so the writer designs the surface for the ACTUAL role, not a guessed
// one.
function renderPersonas(context: ResolvedDesignContext): string[] {
  const personas = context.contract.personaRefs
    .map((id) => context.personasById.get(id))
    .filter((p): p is ResolvedPersona => p !== undefined);
  if (personas.length === 0) return [];
  return [
    "Personas this design serves (build each surface for its resolved persona, never assume a default role):",
    ...bulletList(personas.map((p) => (p.description.trim() === "" ? p.name : `${p.name} — ${p.description}`))),
    "",
  ];
}

// Render the resolved behaviors as the design's acceptance-criteria checklist —
// the SAME behaviors the implementation is driven by (the designer↔implementor
// gap closed). Each is attributed to its persona and rendered given/when/then.
function renderBehaviors(context: ResolvedDesignContext): string[] {
  const behaviors = context.contract.behaviorRefs
    .map((id) => context.behaviorsById.get(id))
    .filter((b): b is ResolvedBehavior => b !== undefined);
  if (behaviors.length === 0) return [];
  return [
    "Behaviors this design must cover (every one needs a designed surface/flow):",
    ...behaviors.map((b) => `- [${b.persona}] ${b.title} — given ${b.given}, when ${b.when}, then ${b.thenOutcome}`),
    "",
  ];
}

/**
 * Render the resolved design context into the writer-prompt design block —
 * domain-general (walks the declared dimensions, no web assumption), persona-scoped
 * (personas resolved to real names; per-dimension persona views surfaced), and
 * behavior-linked (the design's acceptance-criteria behaviors surfaced). Returns
 * the block as a single string (no trailing newline); the caller slots it into the
 * prompt.
 */
export function renderDesignContractBlock(context: ResolvedDesignContext): string {
  const { contract } = context;
  const lines: string[] = [
    "Design contract — build the product to honor this design (domain-general, persona-scoped):",
    `Design domain: ${contract.domain}`,
    `Design identity: ${contract.identity}`,
    `Design intent: ${contract.intent}`,
    "",
  ];
  if (contract.principles.length > 0) {
    lines.push("Design principles (the durable rules):", ...bulletList(contract.principles), "");
  }
  if (contract.constraints.length > 0) {
    lines.push("Design constraints (non-negotiable):", ...bulletList(contract.constraints), "");
  }
  lines.push(...renderPersonas(context));
  lines.push(...renderBehaviors(context));
  if (contract.dimensions.length > 0) {
    lines.push("Design dimensions (build to each; what good looks like on each):");
    for (const dimension of contract.dimensions) {
      lines.push(...renderDimension(dimension, context.personasById));
    }
    lines.push("");
  }
  // Drop the single trailing blank line so the block joins cleanly.
  while (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines.join("\n");
}

// ---- Load ------------------------------------------------------------------

/**
 * A platform-admin actor carrying the run's org (the SAME pattern the conflict
 * resolver's `ProductVisionReader` + the DagWalker enqueuer use): it admits the
 * org-scoped persona/behavior rows while the underlying client stays RLS-scoped to
 * the org, so a cross-org row is both unreadable AND un-attributable.
 */
function designResolverActor(orgId: string, projectId: string): ActorContext {
  return {
    userId: "design-writer-context",
    orgId,
    projectId,
    scopes: ["platform:admin"],
    source: "local_dev",
  };
}

/**
 * Resolve a persisted design contract's first-class `personaRefs`/`behaviorRefs`
 * against the project's REAL entity graph (the moat — strict resolution, no
 * guessing). A ref with no live row is DROPPED (no dangling ref leaks into the
 * prompt); the underlying reads are org-scoped (RLS) AND actor-authorized.
 */
export async function resolveDesignContext(
  client: QueryClient,
  record: DesignContractRecord,
  actor: ActorContext,
): Promise<ResolvedDesignContext> {
  const { contract } = record;
  // Every persona referenced by the contract OR by any dimension's persona view.
  const personaRefIds = new Set<string>(contract.personaRefs);
  for (const dimension of contract.dimensions) {
    for (const id of dimension.personaRefs) personaRefIds.add(id);
  }
  const personasById = new Map<string, ResolvedPersona>();
  for (const id of personaRefIds) {
    const persona = await PersonaStore.get(client, id, actor);
    if (persona !== undefined) {
      personasById.set(id, { id: persona.id, name: persona.name, description: persona.description });
    }
  }
  const behaviorsById = new Map<string, ResolvedBehavior>();
  for (const id of contract.behaviorRefs) {
    const behavior = await BehaviorStore.get(client, id, actor);
    if (behavior !== undefined) {
      behaviorsById.set(id, {
        id: behavior.id,
        persona: personasById.get(behavior.personaId)?.name ?? behavior.personaId,
        title: behavior.title,
        given: behavior.given,
        when: behavior.when,
        thenOutcome: behavior.then,
      });
    }
  }
  return { contract, personasById, behaviorsById };
}

/**
 * Load + render the project's HEAD design contract into the writer-prompt design
 * block, or `undefined` when the project has NO design contract (a real empty
 * state — the writer simply gets no design block; NEVER a fabricated default).
 * Read under the run's org scope (the passed client is already RLS-scoped); a
 * malformed persisted contract fails LOUDLY in the store before it reaches here.
 *
 * `orgScope` is the run's resolved scope (the same `{ kind: "org", orgId }` the
 * credential resolve uses). A run is ALWAYS tenant-scoped — an `unscopedPlatform`
 * scope has no tenant to resolve personas/behaviors against, so it yields no block
 * (rather than reading off the wrong scope), mirroring the conflict resolver's
 * no-org guard.
 */
export async function loadDesignContextBlock(input: {
  client: QueryClient;
  orgScope: OrgScope;
  projectId: string;
}): Promise<string | undefined> {
  if (input.orgScope.kind !== "org") return undefined;
  const actor = designResolverActor(input.orgScope.orgId, input.projectId);
  const record = await DesignContractStore.getLatest(input.client, input.projectId, { kind: "operator" });
  if (record === undefined) return undefined;
  const context = await resolveDesignContext(input.client, record, actor);
  return renderDesignContractBlock(context);
}
