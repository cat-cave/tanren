import { describe, expect, it } from "vitest";
import { validateDtcgArtifact, validateDtcgDocument } from "../src/engine/design/system/dtcgValidator.js";
import type { DesignSystemCoreEvent } from "../src/engine/design/system/designSystemCoreEvents.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

describe("offline DTCG validator", () => {
  it("accepts a structurally valid document with a resolved alias graph", () => {
    const report = validateDtcgDocument({
      color: { primary: { $type: "color", $value: "#0057ff" } },
      semantic: { action: { $type: "color", $value: "{color.primary}" } },
    });

    expect(report.ok).toBe(true);
    expect(report.resolution?.tokenAt("semantic.action")?.value).toBe("#0057ff");
  });

  it("returns a normalized structural finding rather than performing I/O", () => {
    const report = validateDtcgDocument({ semantic: { action: { $type: "color", $ref: "#/color/~2primary" } } });

    expect(report).toMatchObject({
      ok: false,
      findings: [{ code: "design.dtcg.reference_malformed", severity: "p1" }],
    });
  });

  it("emits the frozen artifact-validated event only for a sound resolved graph", () => {
    const events: DesignSystemCoreEvent[] = [];
    const report = validateDtcgArtifact({
      document: { color: { primary: { $type: "color", $value: "#0057ff" } } },
      event: {
        releaseId: "release_1",
        artifactId: "artifact_1",
        artifactDigest: digest("a"),
        validationRunId: "validation_1",
        expectedMatrixDigest: digest("b"),
      },
      eventEmitter: { emit: (event) => events.push(event) },
    });

    expect(report.ok).toBe(true);
    expect(events[0]).toMatchObject({ type: "designSystem.artifact.validated", payload: { artifactId: "artifact_1" } });
  });
});
