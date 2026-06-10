// Unit tests for the native entity-change RISK TAXONOMY + deterministic
// classifier (engine/oracle/entityRiskTaxonomy.ts, docs/roadmap/
// entity-analysis-layer.md §3.1). Pins the pure classifier across every risk
// class, the graceful-`unknown` fallback paths, and the observable-failure
// distinction the no-silent-fallback doctrine demands.
import { describe, expect, it } from "vitest";
import {
  classifyEntityRisk,
  isUnexpectedRiskFailure,
  riskClassRank,
  type EntityChange,
  type EntityChangeMap,
} from "../src/engine/oracle/index.js";

function map(...entities: EntityChange[]): EntityChangeMap {
  return { entities };
}

const cosmeticInternal: EntityChange = { kind: "modified", nature: "cosmetic", visibility: "internal" };
const structuralInternal: EntityChange = { kind: "modified", nature: "structural", visibility: "internal" };
const publicSigChange: EntityChange = {
  kind: "modified",
  nature: "structural",
  visibility: "public",
  signatureChanged: true,
};

describe("classifyEntityRisk — graceful unknown (no map available)", () => {
  it("returns unknown/no-producer when the map is undefined (sem absent)", () => {
    const signal = classifyEntityRisk(null);
    expect(signal.riskClass).toBe("unknown");
    expect(signal.provenance).toBe("no-producer");
    expect(signal.counts).toEqual({ total: 0, cosmetic: 0, structural: 0, publicSignature: 0, deletedOrRenamed: 0 });
    expect(isUnexpectedRiskFailure(signal.provenance)).toBe(false);
  });

  it("returns unknown/no-producer when the map is null", () => {
    expect(classifyEntityRisk(null).provenance).toBe("no-producer");
  });

  it("returns unknown/producer-unsupported (quiet) when the stack cannot be parsed", () => {
    const signal = classifyEntityRisk(undefined, "producer-unsupported");
    expect(signal.riskClass).toBe("unknown");
    expect(signal.provenance).toBe("producer-unsupported");
    // Legitimate absence — NOT an unexpected failure.
    expect(isUnexpectedRiskFailure(signal.provenance)).toBe(false);
  });

  it("returns unknown/producer-errored (LOUD) when the producer errored — observable per no-silent-fallback", () => {
    const signal = classifyEntityRisk(undefined, "producer-errored");
    expect(signal.riskClass).toBe("unknown");
    expect(signal.provenance).toBe("producer-errored");
    // This is the UNEXPECTED case the wiring layer must surface loudly.
    expect(isUnexpectedRiskFailure(signal.provenance)).toBe(true);
  });

  it("ignores the unavailable hint when a real map IS present (a present map is always classified)", () => {
    const signal = classifyEntityRisk(map(structuralInternal), "producer-errored");
    expect(signal.provenance).toBe("classified");
    expect(signal.riskClass).not.toBe("unknown");
  });
});

describe("classifyEntityRisk — cosmetic class (the cheap-skip)", () => {
  it("classifies an empty diff (zero entities) as cosmetic", () => {
    const signal = classifyEntityRisk(map());
    expect(signal.riskClass).toBe("cosmetic");
    expect(signal.provenance).toBe("classified");
    expect(signal.counts.total).toBe(0);
  });

  it("classifies an all-cosmetic change as cosmetic", () => {
    const signal = classifyEntityRisk(map(cosmeticInternal, cosmeticInternal));
    expect(signal.riskClass).toBe("cosmetic");
    expect(signal.counts).toMatchObject({ total: 2, cosmetic: 2, structural: 0 });
  });

  it("does NOT downgrade to cosmetic when even one entity is structural", () => {
    const signal = classifyEntityRisk(map(cosmeticInternal, structuralInternal));
    expect(signal.riskClass).not.toBe("cosmetic");
  });
});

describe("classifyEntityRisk — internal-logic class (bounded blast radius)", () => {
  it("classifies a small internal structural change with no public signature as internal-logic", () => {
    const signal = classifyEntityRisk(map(structuralInternal, structuralInternal));
    expect(signal.riskClass).toBe("internal-logic");
    expect(signal.counts).toMatchObject({ structural: 2, publicSignature: 0, deletedOrRenamed: 0 });
  });

  it("treats an unknown-nature change conservatively as structural (not cosmetic)", () => {
    const signal = classifyEntityRisk(map({ kind: "modified", nature: "unknown", visibility: "internal" }));
    expect(signal.riskClass).toBe("internal-logic");
    expect(signal.counts.structural).toBe(1);
  });
});

describe("classifyEntityRisk — public-api-signature class (highest risk)", () => {
  it("classifies a public signature change as public-api-signature", () => {
    const signal = classifyEntityRisk(map(publicSigChange));
    expect(signal.riskClass).toBe("public-api-signature");
    expect(signal.counts.publicSignature).toBe(1);
  });

  it("treats an added public entity as a public-api-signature change", () => {
    const signal = classifyEntityRisk(map({ kind: "added", nature: "structural", visibility: "public" }));
    expect(signal.riskClass).toBe("public-api-signature");
  });

  it("treats a deleted public entity as a public-api-signature change", () => {
    const signal = classifyEntityRisk(map({ kind: "deleted", nature: "structural", visibility: "public" }));
    expect(signal.riskClass).toBe("public-api-signature");
  });

  it("out-ranks a diffuse structural change: public signature wins even amid many internal edits", () => {
    const signal = classifyEntityRisk(map(publicSigChange, structuralInternal, structuralInternal, structuralInternal));
    expect(signal.riskClass).toBe("public-api-signature");
  });

  it("does NOT escalate a cosmetic-nature public entity to public-api-signature", () => {
    const signal = classifyEntityRisk(
      map({ kind: "modified", nature: "cosmetic", visibility: "public", signatureChanged: true }),
    );
    // Cosmetic nature dominates: no structural entity ⇒ cosmetic class.
    expect(signal.riskClass).toBe("cosmetic");
  });
});

describe("classifyEntityRisk — structural class (diffuse blast radius)", () => {
  it("classifies ≥3 internal structural changes as structural", () => {
    const signal = classifyEntityRisk(map(structuralInternal, structuralInternal, structuralInternal));
    expect(signal.riskClass).toBe("structural");
  });

  it("classifies any internal deletion/rename as structural (no public-signature focal point)", () => {
    const signal = classifyEntityRisk(map({ kind: "deleted", nature: "structural", visibility: "internal" }));
    expect(signal.riskClass).toBe("structural");
    expect(signal.counts.deletedOrRenamed).toBe(1);
  });

  it("counts a renamed entity as deleted-or-renamed", () => {
    const signal = classifyEntityRisk(map({ kind: "renamed", nature: "structural", visibility: "internal" }));
    expect(signal.counts.deletedOrRenamed).toBe(1);
    expect(signal.riskClass).toBe("structural");
  });
});

describe("classifyEntityRisk — determinism + ranking", () => {
  it("is pure/deterministic: same input ⇒ identical output", () => {
    const input = map(publicSigChange, structuralInternal);
    expect(classifyEntityRisk(input)).toEqual(classifyEntityRisk(input));
  });

  it("ranks the classes low→high with unknown at the floor and public-api-signature at the top", () => {
    expect(riskClassRank("unknown")).toBe(0);
    expect(riskClassRank("cosmetic")).toBeLessThan(riskClassRank("internal-logic"));
    expect(riskClassRank("internal-logic")).toBeLessThan(riskClassRank("structural"));
    expect(riskClassRank("structural")).toBeLessThan(riskClassRank("public-api-signature"));
    // unknown must never out-rank a real class (an unclassifiable signal cannot escalate).
    expect(riskClassRank("unknown")).toBeLessThan(riskClassRank("cosmetic"));
  });

  it("always populates counts (non-negative integers) for a classified signal", () => {
    const c = classifyEntityRisk(map(publicSigChange, cosmeticInternal, structuralInternal)).counts;
    expect(c.total).toBe(3);
    expect(c.cosmetic).toBe(1);
    expect(c.structural).toBe(2);
    expect(c.publicSignature).toBe(1);
  });
});
