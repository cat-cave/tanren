// ds-7 — shared framework-core branch tests. They exercise non-projection
// contracts which each concrete adapter inherits, including loud unsupported
// capability failures rather than a partial materialization.

import { describe, expect, it } from "vitest";
import { buildBevyAdapter } from "../src/engine/design/system/bevyAdapter.js";
import { flattenTokenSet } from "../src/engine/design/system/frameworkAdapterCore.js";
import { UnsupportedDesignCapabilityError } from "../src/engine/design/system/designTargetAdapter.js";

const TOKENS = {
  color: { primary: { $type: "color", $value: "#155eef" } },
  space: { md: { $type: "dimension", $value: "0.5rem" } },
} as const;

describe("FrameworkDesignTargetAdapter shared fail-closed contracts", () => {
  it("flattens nested tokens while ignoring null and scalar leaves", () => {
    expect(flattenTokenSet({ ignoredNull: null, ignoredScalar: "plain", nested: TOKENS })).toEqual({
      "nested.color.primary": { $type: "color", $value: "#155eef" },
      "nested.space.md": { $type: "dimension", $value: "0.5rem" },
    });
  });

  it("builds only catalog descriptors and rejects target/capability drift loudly", async () => {
    const adapter = buildBevyAdapter(TOKENS);
    const catalog = await adapter.buildCatalog(
      await adapter.bootstrapPlainSystem({ target: "bevy", capabilities: [] }),
    );
    expect(catalog).toHaveLength(1);
    expect(catalog.every((file) => file.kind === "catalog")).toBe(true);

    await expect(adapter.bootstrapPlainSystem({ target: "swiftui", capabilities: [] })).rejects.toBeInstanceOf(
      UnsupportedDesignCapabilityError,
    );
    await expect(
      adapter.materialize(
        [{ targetCapabilities: ["not-a-bevy-capability"] }] as never,
        await adapter.bootstrapPlainSystem({ target: "bevy", capabilities: [] }),
      ),
    ).rejects.toBeInstanceOf(UnsupportedDesignCapabilityError);
  });
});
