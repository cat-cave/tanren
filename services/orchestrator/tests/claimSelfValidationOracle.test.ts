// Unit tests for the PURE self-validating Claim oracle (§3.3,
// engine/oracle/claimSelfValidation.ts). The cornerstone invariant: a Claim
// SELF-RESOLVES ONLY on POSITIVE evidence the entity is GONE (`removed`); EVERY
// absence of evidence (`unavailable`, any reason) keeps it OPEN — a missing
// entity-analysis NEVER dismisses a defect.

import { describe, expect, it } from "vitest";
import { validateClaimAgainstEntity } from "../src/engine/oracle/claimSelfValidation.js";

describe("validateClaimAgainstEntity (§3.3 self-validating Claim oracle)", () => {
  it("self-resolves ONLY on positive `removed` evidence (decidable)", () => {
    const v = validateClaimAgainstEntity({ status: "removed" });
    expect(v.selfResolved).toBe(true);
    expect(v.transition).toBe("self_resolved");
    expect(v.decidability).toBe("decidable");
    expect(v.unexpectedUnavailable).toBe(false);
  });

  it("keeps an entity that is still present OPEN (decidable, stands)", () => {
    const v = validateClaimAgainstEntity({ status: "present" });
    expect(v.selfResolved).toBe(false);
    expect(v.transition).toBe("open");
    expect(v.decidability).toBe("decidable");
  });

  it("follows a RENAME (same structural identity) — stays OPEN, re-anchors display", () => {
    const v = validateClaimAgainstEntity({
      status: "renamed",
      renamedToName: "decodeAuthToken",
      renamedToPath: "src/auth/decode.ts",
    });
    expect(v.selfResolved).toBe(false);
    expect(v.transition).toBe("open");
    expect(v.decidability).toBe("decidable");
    expect(v.followToName).toBe("decodeAuthToken");
    expect(v.followToPath).toBe("src/auth/decode.ts");
  });

  it("a MODIFIED (present-but-changed) entity is ambiguous → stays OPEN, needs_agent", () => {
    const v = validateClaimAgainstEntity({ status: "modified" });
    expect(v.selfResolved).toBe(false);
    expect(v.transition).toBe("open");
    expect(v.decidability).toBe("needs_agent");
  });

  it("NEVER self-resolves on absence of evidence (no-producer) — keeps OPEN, quiet", () => {
    const v = validateClaimAgainstEntity({ status: "unavailable", unavailableReason: "no-producer" });
    expect(v.selfResolved).toBe(false);
    expect(v.transition).toBe("open");
    expect(v.decidability).toBe("needs_agent");
    expect(v.unexpectedUnavailable).toBe(false);
  });

  it("NEVER self-resolves on a producer-unsupported stack — keeps OPEN, quiet", () => {
    const v = validateClaimAgainstEntity({ status: "unavailable", unavailableReason: "producer-unsupported" });
    expect(v.selfResolved).toBe(false);
    expect(v.transition).toBe("open");
    expect(v.unexpectedUnavailable).toBe(false);
  });

  it("a producer ERROR is the LOUD unavailable case but STILL keeps the Claim OPEN", () => {
    const v = validateClaimAgainstEntity({ status: "unavailable", unavailableReason: "producer-errored" });
    expect(v.selfResolved).toBe(false);
    expect(v.transition).toBe("open");
    // Loud (the wiring layer logs it) — but absence of evidence never resolves.
    expect(v.unexpectedUnavailable).toBe(true);
  });

  it("carries a non-empty rationale for every outcome", () => {
    for (const probe of [
      { status: "removed" as const },
      { status: "present" as const },
      { status: "renamed" as const },
      { status: "modified" as const },
      { status: "unavailable" as const, unavailableReason: "no-producer" as const },
    ]) {
      expect(validateClaimAgainstEntity(probe).rationale.length).toBeGreaterThan(0);
    }
  });
});
