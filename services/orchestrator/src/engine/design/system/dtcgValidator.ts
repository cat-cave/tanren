// ds-1 — offline structural validation for DTCG source + resolved graph.

import type { DesignSystemArtifactValidatedEvent, DesignSystemCoreEventEmitter } from "./designSystemCoreEvents.js";
import {
  DtcgDocumentError,
  isDtcgError,
  DtcgMalformedPointerError,
  DtcgReferenceCycleError,
  DtcgReferenceTypeMismatchError,
  DtcgUnresolvedReferenceError,
  parseDtcgDocument,
  resolveDtcgDocument,
  type DtcgError,
  type DtcgResolution,
} from "./dtcgResolver.js";

export interface DtcgValidationFinding {
  readonly code: string;
  readonly severity: "p0" | "p1" | "p2" | "p3";
  readonly message: string;
  readonly path?: string;
}

export interface DtcgValidationReport {
  readonly ok: boolean;
  readonly findings: readonly DtcgValidationFinding[];
  readonly resolution?: DtcgResolution;
}

export interface ValidateDtcgArtifactInput {
  readonly document: unknown;
  readonly event: DesignSystemArtifactValidatedEvent;
  readonly eventEmitter?: DesignSystemCoreEventEmitter;
}

/**
 * Validate DTCG's source structure and its fully-resolved alias graph without
 * touching the filesystem or a database. Invalid inputs return a normalized
 * finding so the Writer loop can repair them; callers that need a parsed graph
 * receive it only when the report is sound.
 */
export function validateDtcgDocument(value: unknown): DtcgValidationReport {
  try {
    const resolution = resolveDtcgDocument(parseDtcgDocument(value));
    return { ok: true, findings: [], resolution };
  } catch (error: unknown) {
    return { ok: false, findings: [findingFor(error)] };
  }
}

/** Validate an artifact's DTCG graph, then emit the existing frozen validation event on success. */
export function validateDtcgArtifact(input: ValidateDtcgArtifactInput): DtcgValidationReport {
  const report = validateDtcgDocument(input.document);
  if (report.ok) input.eventEmitter?.emit({ type: "designSystem.artifact.validated", payload: input.event });
  return report;
}

function findingFor(error: unknown): DtcgValidationFinding {
  if (error instanceof DtcgDocumentError) return asFinding(error, "p0", error.path);
  if (error instanceof DtcgUnresolvedReferenceError) return asFinding(error, "p1", error.from);
  if (error instanceof DtcgMalformedPointerError) return asFinding(error, "p1", error.from);
  if (error instanceof DtcgReferenceCycleError) return asFinding(error, "p1", error.cycle[0]);
  if (error instanceof DtcgReferenceTypeMismatchError) return asFinding(error, "p1", error.from);
  if (isDtcgError(error)) return asFinding(error, "p1");
  const message = error instanceof Error ? error.message : "unknown DTCG validation failure";
  return { code: "design.dtcg.validation_failed", severity: "p0", message };
}

function asFinding(
  error: DtcgError,
  severity: DtcgValidationFinding["severity"],
  path?: string,
): DtcgValidationFinding {
  return { code: error.code, severity, message: error.message, ...(path === undefined ? {} : { path }) };
}
