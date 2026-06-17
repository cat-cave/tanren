// Native design subsystem (WS-D3) — the DESIGN PHASE: a project-level phase that
// runs the design AGENT (designAgent.ts) to ELABORATE the thin captured design
// intent (WS-D1) into a full, persona-scoped, behavior-covering, domain-appropriate
// `DesignContract`, persisted as the project's HEAD version. It runs ONCE in the
// derive flow (interview → DAG) AFTER personas + behaviors exist (so the moat refs
// resolve to real ids) and BEFORE the build nodes run — so the writer (WS-D2) builds
// from a real DESIGNED contract (`getLatest`) and the oracle (WS-D4) verifies the
// built output against it. This closes the no-handoff loop: interview intent →
// design agent authors the contract → writer implements → oracle verifies.
//
// PLACEMENT — the phase persists a NEW VERSION via `DesignContractStore.create`
// (never-discard versioning, like every design change). Because the writer + oracle
// read `getLatest`, the elaborated version is consumed downstream with NO further
// wiring. WS-D1 already persists a thin version-1 from the interview capture; this
// phase persists the elaborated version on top — so the head a project builds
// against is the DESIGNED contract, not the thin capture.
//
// SCOPE BOUNDARY: the phase authors the CONTRACT only. It never writes product UI —
// the writer realizes the hi-fi from the contract (Tanren's no-handoff model).
//
// FAIL-CLOSED / NO SILENT DEFAULTS:
//   - the agent's output is strictly parsed (loud on malformed — in the wrapper);
//   - EXHAUSTIVE coverage is asserted: every behavior the design is responsible for
//     MUST appear in the agent's `coverage` (a dropped behavior throws — never a
//     silently incomplete contract);
//   - every persona/behavior id the agent references MUST resolve to a real entity
//     id handed to it (a hallucinated/dangling ref throws — never a quiet drop);
//   - the elaborated contract is re-parsed through `DesignContractV1` before persist
//     (the same loud-on-malformed posture as the store).

import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import type { ActorRef } from "../state/actor.js";
import { BehaviorStore } from "../entities/behaviors.js";
import { PersonaStore } from "../entities/personas.js";
import { DesignContractStore, type DesignContractRecord } from "../repositories/designContracts.js";
import { DESIGN_CONTRACT_VERSION, parseDesignContract, type DesignContractV1 } from "./designContract.js";
import type {
  CapturedDesignSeed,
  DesignAgent,
  DesignAgentBehavior,
  DesignAgentInput,
  DesignAgentPersona,
} from "./designAgent.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface RunDesignPhaseInput {
  client: QueryClient;
  orgId: string;
  projectId: string;
  // The design agent that authors the elaborated contract (a real provider answerer
  // in production, a fake in tests).
  agent: DesignAgent;
  // The org-scope carrier for the persona/behavior entity-graph reads.
  actor: ActorContext;
  // The audit/event actor for the contract store reads/writes.
  actorRef: ActorRef;
  // The thin captured seed to elaborate (the interview's `designContract`, mapped to
  // the seed shape). The behaviorRefs/personaRefs already on the captured contract
  // are NOT trusted as the coverage obligation here — the phase resolves the
  // project's FULL persona + behavior set (the design is responsible for ALL of it).
  seed: CapturedDesignSeed;
}

export interface RunDesignPhaseResult {
  // The persisted elaborated contract record (the new HEAD version).
  record: DesignContractRecord;
  // The number of behaviors the design covered (the exhaustive checklist size).
  behaviorsCovered: number;
  // The domain the agent derived (observability of the domain-aware posture).
  domain: string;
}

/**
 * Run the design phase: resolve the project's personas + behaviors, run the design
 * agent to elaborate the thin seed into a full contract, assert exhaustive behavior
 * coverage + strict ref resolution, and persist the elaborated contract as the HEAD
 * version. Returns the persisted record + coverage count + derived domain.
 *
 * Throws LOUDLY (never a silent default) when the agent drops a behavior, references
 * an unknown persona/behavior id, or produces a contract that fails the schema.
 */
export async function runDesignPhase(input: RunDesignPhaseInput): Promise<RunDesignPhaseResult> {
  // Resolve the project's FULL persona + behavior set — the design is responsible for
  // covering every behavior the product carries (strict resolution, the moat).
  const personaRows = await PersonaStore.listForProject(
    input.client,
    { orgId: input.orgId, projectId: input.projectId },
    input.actor,
  );
  const personas: DesignAgentPersona[] = personaRows.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
  }));
  const personaIds = new Set(personas.map((p) => p.id));

  const behaviors: DesignAgentBehavior[] = [];
  for (const persona of personaRows) {
    const rows = await BehaviorStore.listForPersona(input.client, persona.id, input.actor);
    for (const row of rows) {
      /* eslint-disable unicorn/no-thenable */
      // "then" is the BDD Given/When/Then vocabulary (the behavior row's column),
      // not a thenable — the lint about awaitable objects does not apply.
      behaviors.push({
        id: row.id,
        personaId: row.personaId,
        title: row.title,
        given: row.given,
        when: row.when,
        thenOutcome: row.then,
      });
      /* eslint-enable unicorn/no-thenable */
    }
  }
  const behaviorIds = new Set(behaviors.map((b) => b.id));

  const agentInput: DesignAgentInput = { seed: input.seed, personas, behaviors };
  const answer = await input.agent.elaborate(agentInput);

  // EXHAUSTIVE COVERAGE — every behavior the design is responsible for MUST appear in
  // the agent's coverage. A dropped behavior is a silently-incomplete contract → loud.
  const coveredBehaviorIds = new Set(answer.coverage.map((c) => c.behaviorId));
  const uncovered = [...behaviorIds].filter((id) => !coveredBehaviorIds.has(id));
  if (uncovered.length > 0) {
    throw new Error(
      `design phase: the elaborated contract does not cover ${uncovered.length} behavior(s) [${uncovered.join(", ")}] — ` +
        "every behavior the design is responsible for must map to a designed surface (exhaustive checklist)",
    );
  }

  // STRICT RESOLUTION — every behavior/persona id the agent referenced MUST be one of
  // the real ids it was handed (no hallucinated/dangling refs leak into the contract).
  for (const surface of answer.coverage) {
    if (!behaviorIds.has(surface.behaviorId)) {
      throw new Error(
        `design phase: coverage references unknown behavior id '${surface.behaviorId}' (not a project behavior)`,
      );
    }
    if (!personaIds.has(surface.personaId)) {
      throw new Error(
        `design phase: coverage references unknown persona id '${surface.personaId}' (not a project persona)`,
      );
    }
  }
  const dimensionKeys = new Set(answer.dimensions.map((d) => d.key));
  for (const surface of answer.coverage) {
    if (!dimensionKeys.has(surface.dimensionKey)) {
      throw new Error(
        `design phase: coverage references unknown dimension key '${surface.dimensionKey}' (not a declared dimension)`,
      );
    }
  }
  for (const dimension of answer.dimensions) {
    for (const id of dimension.personaIds) {
      if (!personaIds.has(id)) {
        throw new Error(
          `design phase: dimension '${dimension.key}' references unknown persona id '${id}' (not a project persona)`,
        );
      }
    }
  }

  // The behaviors covered are the contract's behavior obligation; the personas the
  // coverage touches (plus any persona-scoped dimension) are its persona binding.
  const contractPersonaRefs = new Set<string>();
  for (const surface of answer.coverage) contractPersonaRefs.add(surface.personaId);
  for (const dimension of answer.dimensions) {
    for (const id of dimension.personaIds) contractPersonaRefs.add(id);
  }

  // Build the elaborated contract + re-parse through the schema (loud on malformed —
  // the same posture as the store's mapRow). The agent's domain-derived dimensions +
  // exhaustive coverage become the persisted contract's dimensions + behaviorRefs.
  const contract: DesignContractV1 = parseDesignContract({
    version: DESIGN_CONTRACT_VERSION,
    domain: answer.domain,
    identity: answer.identity,
    intent: answer.intent,
    principles: answer.principles,
    constraints: answer.constraints,
    // THE MOAT — bind to the project's real persona + behavior entities.
    personaRefs: [...contractPersonaRefs],
    behaviorRefs: [...coveredBehaviorIds],
    dimensions: answer.dimensions.map((d) => ({
      key: d.key,
      label: d.label,
      intent: d.intent,
      guidance: d.guidance,
      personaRefs: d.personaIds,
    })),
  });

  const record = await DesignContractStore.create(
    input.client,
    { orgId: input.orgId, projectId: input.projectId, contract },
    input.actorRef,
  );

  return { record, behaviorsCovered: coveredBehaviorIds.size, domain: contract.domain };
}
