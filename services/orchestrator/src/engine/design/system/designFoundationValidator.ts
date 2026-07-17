// ds-0 — the OFFLINE design foundation validator (the callable proof surface).
//
// A deterministic, no-I/O validator over the ds-0 contracts: it parses a
// `DesignContractV2` + a `FrameworkDesignArtifactManifestV1`, then applies the
// STRUCTURAL invariants a foundation must guarantee before ds-1..8 build on it —
// safe normalized artifact paths (no traversal / absolute / case-collision), a
// canonical-artifact reference on a published release, and manifest↔release
// digest agreement. Failures are returned as normalized findings (the currency
// the Writer loop repairs) AND, for schema-level corruption, throw the typed
// parser errors — fail-closed, never a silent accept.
//
// This is the offline half of the ds-4 A4 validation contract: no bytes are
// rendered here (that is ds-4's live harness); ds-0 proves the structural gate
// exists + catches negative controls (a traversal path, a corrupt contract).

import {
  type DesignSystemReleaseV1,
  type FrameworkDesignArtifactManifestV1,
  parseDesignArtifactManifest,
  parseDesignSystemRelease,
} from "./designArtifactSchemas.js";
import { type DesignContractV2, parseDesignContractV2 } from "./designContractV2.js";

export interface DesignFoundationFinding {
  readonly code: string;
  readonly severity: "p0" | "p1" | "p2" | "p3";
  readonly message: string;
  readonly path?: string;
}

export interface DesignFoundationValidationReport {
  readonly ok: boolean;
  readonly findings: readonly DesignFoundationFinding[];
}

/**
 * Validate a `DesignContractV2` blob offline. Returns a report; a schema-corrupt
 * contract throws `DesignContractV2CorruptError` from the parser (fail-closed).
 */
export function validateDesignContractV2Blob(value: unknown): {
  readonly report: DesignFoundationValidationReport;
  readonly contract: DesignContractV2;
} {
  const contract = parseDesignContractV2(value);
  const findings: DesignFoundationFinding[] = [];
  // A dimension/surface that references a persona must reference one the contract
  // declares (structural coherence — the ds-4 oracle resolves per-persona).
  const declared = new Set(contract.personaRefs);
  for (const dimension of contract.dimensions) {
    for (const persona of dimension.personaRefs) {
      if (!declared.has(persona)) {
        findings.push({
          code: "design.contract.dimension_persona_undeclared",
          severity: "p2",
          message: `dimension '${dimension.key}' references persona '${persona}' not on the contract`,
          path: `dimensions.${dimension.key}`,
        });
      }
    }
  }
  return { report: { ok: findings.length === 0, findings }, contract };
}

/** Normalize + safety-check one artifact-relative path. Returns findings (empty = safe). */
export function checkArtifactPath(path: string): DesignFoundationFinding[] {
  const findings: DesignFoundationFinding[] = [];
  if (path.startsWith("/")) {
    findings.push({ code: "design.artifact.path_absolute", severity: "p0", message: "absolute path", path });
  }
  if (path.includes("\\")) {
    findings.push({ code: "design.artifact.path_backslash", severity: "p0", message: "backslash in path", path });
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      findings.push({
        code: "design.artifact.path_traversal",
        severity: "p0",
        message: `unsafe path segment '${segment}'`,
        path,
      });
      break;
    }
  }
  return findings;
}

/**
 * Validate a `FrameworkDesignArtifactManifestV1` blob offline against its
 * (optional) release. Checks: schema parse, deep artifact-path safety, unique
 * normalized paths (case-insensitive collision), a `manifest` file present, and —
 * when a release is supplied — that the manifest's contract digest matches the
 * release's. A schema-corrupt manifest throws `DesignArtifactSchemaError`.
 */
export function validateArtifactManifestBlob(
  value: unknown,
  release?: DesignSystemReleaseV1,
): {
  readonly report: DesignFoundationValidationReport;
  readonly manifest: FrameworkDesignArtifactManifestV1;
} {
  const manifest = parseDesignArtifactManifest(value);
  const findings: DesignFoundationFinding[] = [];

  const seen = new Map<string, string>();
  const manifestFileCount = manifest.files.filter((file) => file.kind === "manifest").length;
  for (const file of manifest.files) {
    findings.push(...checkArtifactPath(file.path));
    const normalized = file.path.toLowerCase();
    const prior = seen.get(normalized);
    if (prior === undefined) {
      seen.set(normalized, file.path);
    } else {
      findings.push({
        code: "design.artifact.path_collision",
        severity: "p0",
        message: `path collides case-insensitively with '${prior}'`,
        path: file.path,
      });
    }
  }
  if (manifestFileCount === 0) {
    findings.push({
      code: "design.artifact.manifest_file_missing",
      severity: "p1",
      message: "artifact has no file of kind 'manifest'",
    });
  }
  if (release !== undefined && release.contractDigest !== manifest.contractDigest) {
    findings.push({
      code: "design.artifact.contract_digest_mismatch",
      severity: "p0",
      message: `manifest contract digest ${manifest.contractDigest} != release ${release.contractDigest}`,
    });
  }

  return { report: { ok: findings.length === 0, findings }, manifest };
}

/**
 * The whole-foundation offline validation: a contract + a manifest + their
 * release, structurally coherent, with negative controls (traversal path, corrupt
 * blob) caught. Aggregates findings across all three; any P0/P1 fails the report.
 * Throws the typed parser error on schema corruption before returning a report.
 */
export function validateDesignFoundation(input: {
  readonly contract: unknown;
  readonly manifest: unknown;
  readonly release: unknown;
}): DesignFoundationValidationReport {
  const release = parseDesignSystemRelease(input.release);
  const contractResult = validateDesignContractV2Blob(input.contract);
  const manifestResult = validateArtifactManifestBlob(input.manifest, release);
  const findings = [...contractResult.report.findings, ...manifestResult.report.findings];
  return { ok: findings.length === 0, findings };
}
