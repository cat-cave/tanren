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
// (`behaviorRefs`). A captured name/key with no persisted entity is DROPPED (no
// dangling ref) — design binds only to real personas/behaviors. The persisted
// versioned entity is the durable artifact later workstreams inject into the
// writer (WS-D2) + verify with a design oracle (WS-D4) — the clean seam left here.

import type pg from "pg";
import { DESIGN_CONTRACT_VERSION, parseDesignContract, type DesignContractV1 } from "../../design/designContract.js";
import { DesignContractStore } from "../../repositories/designContracts.js";
import type { CaptureDesignContract, InterviewCapture } from "./types.js";

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
// the persona/behavior links against the maps the derive built.
export function toDesignContract(
  capture: CaptureDesignContract,
  personaIdByName: Map<string, string>,
  behaviorIdByKey: Map<string, string>,
): DesignContractV1 {
  const resolvePersonas = (names: readonly string[]): string[] =>
    names.map((n) => personaIdByName.get(n.trim().toLowerCase())).filter((id): id is string => id !== undefined);
  return parseDesignContract({
    version: DESIGN_CONTRACT_VERSION,
    domain: capture.domain,
    identity: capture.identity,
    intent: capture.intent,
    principles: capture.principles,
    constraints: capture.constraints,
    // THE MOAT: bind to the project's actual persona + behavior entities.
    personaRefs: resolvePersonas(capture.personas),
    behaviorRefs: capture.behaviors
      .map((key) => behaviorIdByKey.get(key.trim().toLowerCase()))
      .filter((id): id is string => id !== undefined),
    dimensions: capture.dimensions.map((d) => ({
      key: d.key,
      label: d.label,
      intent: d.intent,
      guidance: d.guidance,
      personaRefs: resolvePersonas(d.personas),
    })),
  });
}

// Persist the captured design contract as version 1 of the project's first-class
// `DesignContract` entity, returning its id (or undefined when no contract was
// captured — a real empty state, never a defaulted row). Called LAST in the derive
// (after personas + behaviors exist) so THE MOAT links resolve to real ids.
export async function persistDesignContract(
  pool: pg.Pool,
  input: {
    orgId: string;
    projectId: string;
    capture: CaptureDesignContract | null;
    personaIdByName: Map<string, string>;
    behaviorIdByKey: Map<string, string>;
  },
): Promise<string | undefined> {
  if (input.capture === null) return undefined;
  const record = await DesignContractStore.create(
    pool,
    {
      orgId: input.orgId,
      projectId: input.projectId,
      contract: toDesignContract(input.capture, input.personaIdByName, input.behaviorIdByKey),
    },
    { kind: "operator" },
  );
  return record.id;
}
