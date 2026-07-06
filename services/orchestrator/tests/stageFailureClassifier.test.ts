// Pins the typed-error classifier arms in `classifyStageFailureKind`. The
// prior classifier only mapped provider-timeout / usage-limit / schema-parse /
// recorder / event-append failures — every OTHER typed throw fell through to
// the opaque `crashed` default, erasing the rich `issues`/`rawValue`/`detail`
// context that the four PR #740 / #745 error classes carry for triage.
//
// The four typed arms this covers:
//   - MalformedAncestorStackError    → "malformed_ancestor_stack"
//   - DesignContractCorruptError     → "design_contract_corrupt"
//   - DesignOracleActorConfigError   → "design_oracle_actor_config"
//   - MalformedDesignOracleResultError → "malformed_design_oracle_result"
//
// The test also RE-pins the closed-vocabulary fallback (`crashed`) so an
// arbitrary unknown throw is still swallowed to the safe default — the new
// arms MUST NOT widen what an unrecognized throw surfaces.

import { describe, expect, it } from "vitest";
import { MalformedAncestorStackError } from "../src/engine/dag/ancestorStack.js";
import { DesignContractCorruptError } from "../src/engine/repositories/designContracts.js";
import {
  DesignOracleActorConfigError,
  MalformedDesignOracleResultError,
} from "../src/engine/workflow/designOracle/designOracle.js";
import { classifyStageFailureKind } from "../src/engine/workflow/stageFailureKind.js";

describe("classifyStageFailureKind — typed-error arms (PR #740 + #745)", () => {
  it("maps MalformedAncestorStackError → malformed_ancestor_stack", () => {
    const error = new MalformedAncestorStackError(
      [{ code: "invalid_type", path: ["0", "specId"], message: "expected string" } as never],
      { corrupt: "payload" },
    );
    expect(classifyStageFailureKind(error)).toBe("malformed_ancestor_stack");
  });

  it("maps DesignContractCorruptError → design_contract_corrupt", () => {
    const error = new DesignContractCorruptError("project_a", { corrupt: true }, "expected object at .foo");
    expect(classifyStageFailureKind(error)).toBe("design_contract_corrupt");
  });

  it("maps DesignOracleActorConfigError → design_oracle_actor_config", () => {
    const error = new DesignOracleActorConfigError("project_a", "actor.orgId is null");
    expect(classifyStageFailureKind(error)).toBe("design_oracle_actor_config");
  });

  it("maps MalformedDesignOracleResultError → malformed_design_oracle_result", () => {
    const error = new MalformedDesignOracleResultError("missing/empty field(s): contractVersion");
    expect(classifyStageFailureKind(error)).toBe("malformed_design_oracle_result");
  });

  it("falls through to `crashed` for an unrecognized throw (closed-vocabulary fallback)", () => {
    expect(classifyStageFailureKind(new Error("some novel unclassified throw"))).toBe("crashed");
    expect(classifyStageFailureKind("a bare non-Error throw")).toBe("crashed");
    expect(classifyStageFailureKind(null)).toBe("crashed");
  });
});
