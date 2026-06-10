// Unit tests for the risk-class → checker POSTURE mapping (engine/oracle/
// checkerRiskPosture.ts, §3.1). Pins the scrutiny/severity-weight per class and
// the steer-rendering (empty for unknown = the graceful-fallback path).
import { describe, expect, it } from "vitest";
import {
  checkerPostureFor,
  classifyEntityRisk,
  renderRiskPostureLines,
  type EntityChange,
  type EntityChangeMap,
} from "../src/engine/oracle/index.js";

function map(...entities: EntityChange[]): EntityChangeMap {
  return { entities };
}

const cosmetic = classifyEntityRisk(map({ kind: "modified", nature: "cosmetic", visibility: "internal" }));
const internalLogic = classifyEntityRisk(map({ kind: "modified", nature: "structural", visibility: "internal" }));
const publicSig = classifyEntityRisk(
  map({ kind: "modified", nature: "structural", visibility: "public", signatureChanged: true }),
);
const structural = classifyEntityRisk(map({ kind: "deleted", nature: "structural", visibility: "internal" }));
const unknown = classifyEntityRisk(null);

describe("checkerPostureFor — scrutiny + severity weight per class", () => {
  it("cosmetic ⇒ skip scrutiny, down-weighted severity", () => {
    const p = checkerPostureFor(cosmetic);
    expect(p.scrutiny).toBe("skip");
    expect(p.severityWeight).toBeLessThan(1);
  });

  it("internal-logic ⇒ standard scrutiny, neutral weight", () => {
    const p = checkerPostureFor(internalLogic);
    expect(p.scrutiny).toBe("standard");
    expect(p.severityWeight).toBe(1);
  });

  it("structural ⇒ heightened scrutiny, up-weighted severity", () => {
    const p = checkerPostureFor(structural);
    expect(p.scrutiny).toBe("heightened");
    expect(p.severityWeight).toBeGreaterThan(1);
  });

  it("public-api-signature ⇒ maximal scrutiny, highest weight", () => {
    const p = checkerPostureFor(publicSig);
    expect(p.scrutiny).toBe("maximal");
    expect(p.severityWeight).toBeGreaterThan(checkerPostureFor(structural).severityWeight);
  });

  it("unknown ⇒ standard scrutiny, neutral weight, NO steer (graceful fallback)", () => {
    const p = checkerPostureFor(unknown);
    expect(p.scrutiny).toBe("standard");
    expect(p.severityWeight).toBe(1);
    expect(p.emphasisLines).toEqual([]);
  });
});

describe("renderRiskPostureLines — concrete steer, empty on unknown", () => {
  it("renders the cosmetic steer telling the checker a light pass suffices", () => {
    const lines = renderRiskPostureLines(cosmetic).join("\n");
    expect(lines).toContain("COSMETIC-ONLY");
    expect(lines).toContain("light completeness pass");
  });

  it("renders the public-api-signature steer concentrating scrutiny on dependents", () => {
    const lines = renderRiskPostureLines(publicSig).join("\n");
    expect(lines).toContain("PUBLIC-API SIGNATURE");
    expect(lines).toContain("HIGHEST structural risk class");
  });

  it("folds the headline entity counts into the steer (no raw entity list injected)", () => {
    const lines = renderRiskPostureLines(publicSig).join("\n");
    expect(lines).toContain("entity-change map:");
    expect(lines).toContain("public-signature");
  });

  it("returns an EMPTY steer for unknown so a caller can append unconditionally", () => {
    expect(renderRiskPostureLines(unknown)).toEqual([]);
  });
});
