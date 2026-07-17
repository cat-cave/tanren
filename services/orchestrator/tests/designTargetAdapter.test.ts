// ds-0 — DesignTargetAdapter registry seam + typed gap errors (foundation slots).

import { describe, expect, it } from "vitest";
import {
  DesignAdapterNotRegisteredError,
  DesignTargetAdapterRegistry,
  UnsupportedDesignCapabilityError,
  type DesignTargetAdapter,
} from "../src/engine/design/system/designTargetAdapter.js";

function stubAdapter(target: string): DesignTargetAdapter {
  // A minimal registry-only stub — the real projection is ds-2. Every method
  // rejects loudly (a foundation slot must never pretend to render).
  const notImplemented = async (): Promise<never> => {
    throw new UnsupportedDesignCapabilityError(target, "not-implemented-in-foundation");
  };
  return {
    target,
    detectTarget: notImplemented,
    bootstrapPlainSystem: notImplemented,
    materialize: notImplemented,
    buildCatalog: notImplemented,
    validateStatic: notImplemented,
    renderScenarioMatrix: notImplemented,
    export: notImplemented,
    enumerateProofRequirements: notImplemented,
  };
}

describe("DesignTargetAdapterRegistry", () => {
  it("registers + resolves an adapter by target key", () => {
    const registry = new DesignTargetAdapterRegistry();
    registry.register(stubAdapter("web-react"));
    expect(registry.has("web-react")).toBe(true);
    expect(registry.resolve("web-react").target).toBe("web-react");
    expect(registry.registeredTargets()).toEqual(["web-react"]);
  });

  it("NEGATIVE CONTROL — resolving an unregistered target is a loud typed error (never a stub render)", () => {
    const registry = new DesignTargetAdapterRegistry();
    expect(() => registry.resolve("bevy")).toThrow(DesignAdapterNotRegisteredError);
  });

  it("rejects a duplicate registration", () => {
    const registry = new DesignTargetAdapterRegistry();
    registry.register(stubAdapter("web-react"));
    expect(() => registry.register(stubAdapter("web-react"))).toThrow(/duplicate/u);
  });

  it("an unsupported capability is a typed F2D gap, not a silent omission", () => {
    const err = new UnsupportedDesignCapabilityError("bevy", "tactical-hud");
    expect(err.name).toBe("UnsupportedDesignCapabilityError");
    expect(err.capability).toBe("tactical-hud");
  });
});
