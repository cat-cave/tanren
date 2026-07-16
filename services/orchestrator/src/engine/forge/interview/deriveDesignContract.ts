// Native design subsystem (WS-D1) — the derive helper that persists the captured
// design contract as a first-class versioned `DesignContract` entity, resolving
// THE MOAT links (persona names + behavior keys → the persisted persona/behavior
// ids). Split out of `derive.ts` to keep it under the per-file line cap + the
// dependency cap (it owns the `DesignContractStore` + `designContract` imports).
//
// The capture's core + dimensions map 1:1 onto `DesignContractV1`; this layer
// adds the schema `version` AND binds the contract to the project's REAL typed
// entity graph: captured persona NAMES → persisted persona ids (`personaRefs`),
// captured behavior keys (`persona::title`) → persisted behavior ids
// (`behaviorRefs`). A captured name/key with no persisted entity is a LOUD failure
// (`DanglingDesignRefError`) — design binds only to real personas/behaviors, and a
// dangling ref is a halt (consistent with the design phase + oracle), never a silent
// drop that would shrink the coverage obligation. The persisted
// versioned entity is the durable artifact later workstreams inject into the
// writer (WS-D2) + verify with a design oracle (WS-D4) — the clean seam left here.

import { createHash } from "node:crypto";
import type { ProjectSpecQueryClient } from "../../workflow/projectSpec.js";
import {
  DESIGN_CONTRACT_VERSION,
  designContractDigest,
  normalizeDesignContract,
  parseDesignContract,
  type DesignContractV1,
} from "../../design/designContract.js";
import type {
  CapturedDesignSeed,
  DesignAgentAnswer,
  DesignAgentBehavior,
  DesignAgentInput,
  DesignAgentPersona,
} from "../../design/designAgent.js";
import { designContractFromAnswer } from "../../design/designPhase.js";
import { DesignContractStore } from "../../repositories/designContracts.js";
import type { CaptureDesignContract, InterviewCapture } from "./types.js";

// Thrown when a derive reaches the design step with NO captured design contract.
// FAIL LOUD (no silent no-op) — mirroring `MissingLifecycleError`. The design
// contract is the durable artifact the writer (WS-D2) builds from and the oracle
// (WS-D4) verifies against; an absent one would silently disable the ENTIRE design
// subsystem (no contract persisted, no writer design block, the oracle no-ops). The
// contract must be PRESENT + EXPLICIT — it need not be web-heavy: a genuinely
// design-light project (a headless library) still declares an EXPLICIT minimal
// contract (empty principles/constraints/dimensions), never a silent absence. The
// no-silent-fallback doctrine: a required-missing input is a LOUD halt, never a
// quiet degrade.
export class MissingDesignContractError extends Error {
  constructor() {
    super(
      "greenfield derive requires the design step to capture a design contract " +
        "(domain + identity + intent, with domain-appropriate principles/constraints/dimensions); " +
        "none was captured. The design contract is the durable artifact the writer builds from and the " +
        "design oracle verifies against — it must be declared explicitly (a design-light project declares " +
        "an explicit minimal contract), never silently absent.",
    );
    this.name = "MissingDesignContractError";
  }
}

// Thrown when the thin-capture design path (the engine-graph test seam — no design
// agent wired) encounters a captured persona NAME or behavior KEY that resolves to
// no persisted entity. FAIL LOUD (consistent with the design PHASE + the design
// oracle, which both throw on a dangling ref) — a silently-dropped ref shrinks the
// coverage obligation the oracle assumes EXHAUSTIVE, so a dangling ref is a loud
// halt here too, never a quiet drop.
export class DanglingDesignRefError extends Error {
  constructor(kind: "persona" | "behavior", ref: string) {
    super(
      `design contract references unknown ${kind} ${kind === "persona" ? "name" : "key"} '${ref}' ` +
        `(not a captured project ${kind}) — design binds only to REAL typed ${kind}s; a dangling ref is a ` +
        "loud failure, never a silent drop (consistent with the design phase + oracle).",
    );
    this.name = "DanglingDesignRefError";
  }
}

// The product-vision slice of the project config (the identity `pitch` + a short
// design note) persisted onto `projects.config` so the conflict resolver can frame
// a resolution against the product vision. The design note is the captured design
// contract's one-line `identity` (WS-D1); the full design intent lives in the
// first-class `DesignContract` entity. Only captured fields are written — an
// interview that surfaced neither yields `{}` (a real empty state).
export function productVisionConfig(capture: InterviewCapture): { productVision?: Record<string, string> } {
  const vision: Record<string, string> = {};
  const pitch = capture.identity?.pitch.trim();
  if (pitch !== undefined && pitch !== "") vision["pitch"] = pitch;
  const designNote = capture.designContract?.identity.trim();
  if (designNote !== undefined && designNote !== "") vision["designDna"] = designNote;
  return Object.keys(vision).length > 0 ? { productVision: vision } : {};
}

// The natural key of a behavior in the capture (matches the capture's
// `persona::title` keying). The captured design contract references behaviors by
// this key; the derive resolves it to the persisted behavior id.
export function behaviorKey(persona: string, title: string): string {
  return `${persona.trim().toLowerCase()}::${title.trim().toLowerCase()}`;
}

// Map the captured design contract → the persisted `DesignContractV1`, resolving
// the persona/behavior links against the maps the derive built. A captured name/key
// that resolves to no persisted entity is a LOUD failure (`DanglingDesignRefError`),
// consistent with the design PHASE + design ORACLE — never a silent drop that would
// shrink the coverage obligation the oracle assumes exhaustive.
export function toDesignContract(
  capture: CaptureDesignContract,
  personaIdByName: Map<string, string>,
  behaviorIdByKey: Map<string, string>,
): DesignContractV1 {
  const resolvePersonas = (names: readonly string[]): string[] =>
    names.map((n) => {
      const id = personaIdByName.get(n.trim().toLowerCase());
      if (id === undefined) throw new DanglingDesignRefError("persona", n);
      return id;
    });
  const resolveBehaviors = (keys: readonly string[]): string[] =>
    keys.map((key) => {
      const id = behaviorIdByKey.get(key.trim().toLowerCase());
      if (id === undefined) throw new DanglingDesignRefError("behavior", key);
      return id;
    });
  return parseDesignContract({
    version: DESIGN_CONTRACT_VERSION,
    domain: capture.domain,
    identity: capture.identity,
    intent: capture.intent,
    principles: capture.principles,
    constraints: capture.constraints,
    // THE MOAT: bind to the project's actual persona + behavior entities.
    personaRefs: resolvePersonas(capture.personas),
    behaviorRefs: resolveBehaviors(capture.behaviors),
    dimensions: capture.dimensions.map((d) => ({
      key: d.key,
      label: d.label,
      intent: d.intent,
      guidance: d.guidance,
      personaRefs: resolvePersonas(d.personas),
    })),
  });
}

// The thin captured contract → the design AGENT's seed shape (WS-D3). Drops the
// captured refs/dimensions: the design PHASE resolves the project's FULL persona +
// behavior set as the coverage obligation (the design is responsible for ALL of it)
// and the agent DERIVES the domain-appropriate dimensions itself.
function toDesignSeed(capture: CaptureDesignContract): CapturedDesignSeed {
  return {
    domain: capture.domain,
    identity: capture.identity,
    intent: capture.intent,
    principles: capture.principles,
    constraints: capture.constraints,
  };
}

export interface DerivationDesignPlan {
  inputDigest: string;
  agentInput: DesignAgentInput;
  personaIdByName: Map<string, string>;
  behaviorIdByKey: Map<string, string>;
}

export interface DerivationDesignResult {
  inputDigest: string;
  contract: DesignContractV1;
  contractDigest: string;
}

function plannedId(kind: "persona" | "behavior", fingerprint: string, key: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(["tanren.derivation-graph-identity.v1", fingerprint, kind, key]), "utf8")
    .digest("hex");
  return `${kind}_${digest.slice(0, 32)}`;
}

/** Preassign the identities a provider-authored design may reference before graph I/O. */
export function buildDerivationDesignPlan(capture: InterviewCapture, fingerprint: string): DerivationDesignPlan {
  if (capture.designContract === null) throw new MissingDesignContractError();
  const personaIdByName = new Map<string, string>();
  const personas: DesignAgentPersona[] = capture.personas.map((persona) => {
    const key = persona.name.trim().toLowerCase();
    if (personaIdByName.has(key)) throw new Error(`duplicate captured persona '${persona.name}'`);
    const id = plannedId("persona", fingerprint, key);
    personaIdByName.set(key, id);
    return { id, name: persona.name, description: persona.description };
  });

  const behaviorIdByKey = new Map<string, string>();
  const behaviors: DesignAgentBehavior[] = capture.behaviors.map((behavior) => {
    const key = behaviorKey(behavior.persona, behavior.title);
    if (behaviorIdByKey.has(key)) throw new Error(`duplicate captured behavior '${key}'`);
    const personaId = personaIdByName.get(behavior.persona.trim().toLowerCase());
    if (personaId === undefined) {
      throw new DanglingDesignRefError("persona", behavior.persona);
    }
    const id = plannedId("behavior", fingerprint, key);
    behaviorIdByKey.set(key, id);
    return {
      id,
      personaId,
      title: behavior.title,
      given: behavior.given,
      when: behavior.when,
      thenOutcome: behavior.then,
    };
  });
  const agentInput: DesignAgentInput = {
    seed: toDesignSeed(capture.designContract),
    personas,
    behaviors,
  };
  const inputDigest = `sha256:${createHash("sha256")
    .update(JSON.stringify(["tanren.derivation-design-input.v1", agentInput]), "utf8")
    .digest("hex")}`;
  return { inputDigest, agentInput, personaIdByName, behaviorIdByKey };
}

export function capturedDesignResult(
  capture: CaptureDesignContract,
  plan: DerivationDesignPlan,
): DerivationDesignResult {
  const contract = normalizeDesignContract(toDesignContract(capture, plan.personaIdByName, plan.behaviorIdByKey));
  return { inputDigest: plan.inputDigest, contract, contractDigest: designContractDigest(contract) };
}

export function providerDesignResult(answer: DesignAgentAnswer, plan: DerivationDesignPlan): DerivationDesignResult {
  const contract = normalizeDesignContract(
    designContractFromAnswer({ answer, personas: plan.agentInput.personas, behaviors: plan.agentInput.behaviors }),
  );
  return { inputDigest: plan.inputDigest, contract, contractDigest: designContractDigest(contract) };
}

// Persist the project's first-class `DesignContract` entity (WS-D1/WS-D3), returning
// the HEAD record's id. The captured contract is REQUIRED (the derive guards it with
// `MissingDesignContractError` before reaching here) — a null capture is a LOUD failure,
// never a silently-skipped row that would disable the design subsystem. Called LAST in
// the derive (after personas + behaviors exist) so THE MOAT links resolve to real ids.
//
// WS-D3 — the DESIGN PHASE. When a `designAgent` is wired (production via the route
// factory), the captured intent is ELABORATED by the design agent into a full,
// persona-scoped, behavior-COVERING, domain-appropriate contract (the durable
// designed artifact the writer builds from + the oracle verifies), persisted as the
// HEAD version. Absent an agent (engine-level graph tests — the injected-seam path,
// exactly like the optional `templateRegistryQuery`/`createTemplateForNoMatch`
// seams), the thin captured contract is persisted verbatim as version 1.
export async function persistDesignContract(
  pool: ProjectSpecQueryClient,
  input: {
    orgId: string;
    projectId: string;
    design: DerivationDesignResult;
  },
): Promise<{ id: string; version: number; domain: string; digest: string }> {
  const contract = normalizeDesignContract(input.design.contract);
  const digest = designContractDigest(contract);
  if (digest !== input.design.contractDigest) throw new Error("design result contract digest mismatch");
  // The provider call (when present) already completed behind the derivation's
  // durable result boundary. This transaction only persists the validated answer.
  // The design contract is PROJECT-scoped (H2 BLOCKING unify): the whole-product
  // contract lives at a single per-project head (migration 0028 collapsed the
  // broken mode-keying), shared across every spec type in the project.
  const record = await DesignContractStore.create(
    pool,
    {
      orgId: input.orgId,
      projectId: input.projectId,
      contract,
    },
    { kind: "operator" },
  );
  return { id: record.id, version: record.version, domain: record.domain, digest };
}
