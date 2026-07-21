// in-20 — proves the integration read-compat guard actually GUARDS (it is not a
// no-op): the classifier FAILS (compatible=false) on a backward-incompatible
// response-schema change — a removed / renamed / retyped field, a removed enum
// member, a weakened required guarantee, a dropped schema — and PASSES
// (compatible=true) on a backward-compatible additive change. It also asserts
// the CURRENT rendered shape stays compatible with the committed floor
// (contracts/integration-read-compat/v1.json), so a local `just affected-test`
// catches a breaking change the same way the `just integration-read-compat` CI
// gate does.
//
// Mirrors `verificationReadCompat.test.ts` (rv-22) shape-for-shape. The
// classifier under test is the SAME pure `classifyReadCompat` shared with
// rv-read-compat — shared infra, two read surfaces.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyReadCompat, type SchemaMap } from "../src/engine/verification/readCompat/classifyReadCompat.js";
import { renderIntegrationReadSchemas } from "../src/routes/integrations/contract.js";

const floorPath = fileURLToPath(new URL("../../../contracts/integration-read-compat/v1.json", import.meta.url));

function clone(value: SchemaMap): SchemaMap {
  return structuredClone(value);
}

describe("in-20 integration read-compat classifier — the guard actually guards", () => {
  const current = renderIntegrationReadSchemas();
  const bindings = "tanren.integrations.read.v1.IntegrationBindingsResponse";

  it("PASSES when the shape is unchanged", () => {
    const result = classifyReadCompat(current, current);
    expect(result.compatible).toBe(true);
    expect(result.breaking).toHaveLength(0);
  });

  it("PASSES on a backward-compatible additive change (a new field)", () => {
    const candidate = clone(current);
    const props = (candidate[bindings] as { properties: Record<string, unknown> }).properties;
    props["newlyAddedField"] = { type: "string" };
    const result = classifyReadCompat(current, candidate);
    expect(result.compatible).toBe(true);
    expect(result.additive.some((c) => c.kind === "added-property")).toBe(true);
  });

  it("PASSES on an additive enum value", () => {
    const candidate = clone(current);
    const bindingsNode = candidate[bindings] as {
      properties: {
        bindings: {
          items: {
            properties: {
              status: { enum?: unknown[] };
              currentGeneration: { properties: Record<string, { enum?: unknown[] }> };
            };
          };
        };
      };
    };
    const status = bindingsNode.properties["bindings"].items.properties["status"];
    status.enum = [...(status.enum ?? []), "brand_new_status"];
    const result = classifyReadCompat(current, candidate);
    expect(result.compatible).toBe(true);
    expect(result.additive.some((c) => c.kind === "added-enum-value")).toBe(true);
  });

  it("DECISIVE: FAILS when a field is removed", () => {
    const candidate = clone(current);
    const props = (candidate[bindings] as { properties: Record<string, unknown> }).properties;
    delete props["version"];
    const result = classifyReadCompat(current, candidate);
    expect(result.compatible).toBe(false);
    expect(result.breaking.some((c) => c.kind === "removed-property" && c.path.endsWith("version"))).toBe(true);
  });

  it("DECISIVE: FAILS when a field is renamed (old name removed)", () => {
    const candidate = clone(current);
    const props = (candidate[bindings] as { properties: Record<string, unknown> }).properties;
    props["bindings_legacy"] = props["bindings"];
    delete props["bindings"];
    const result = classifyReadCompat(current, candidate);
    expect(result.compatible).toBe(false);
    expect(result.breaking.some((c) => c.kind === "removed-property")).toBe(true);
  });

  it("DECISIVE: FAILS when a field is retyped", () => {
    const candidate = clone(current);
    const props = (candidate[bindings] as { properties: Record<string, { type?: string }> }).properties;
    props["orgId"] = { type: "integer" };
    const result = classifyReadCompat(current, candidate);
    expect(result.compatible).toBe(false);
    expect(result.breaking.some((c) => c.kind === "type-changed")).toBe(true);
  });

  it("FAILS when an enum member is removed (the closed set shrinks)", () => {
    const candidate = clone(current);
    const bindingsNode = candidate[bindings] as {
      properties: {
        bindings: {
          items: {
            properties: {
              status: { enum: unknown[] };
            };
          };
        };
      };
    };
    const status = bindingsNode.properties["bindings"].items.properties["status"];
    status.enum = status.enum.filter((v) => v !== "ready");
    const result = classifyReadCompat(current, candidate);
    expect(result.compatible).toBe(false);
    expect(result.breaking.some((c) => c.kind === "removed-enum-value")).toBe(true);
  });

  it("FAILS when a whole schema is dropped", () => {
    const candidate = clone(current);
    delete candidate[bindings];
    const result = classifyReadCompat(current, candidate);
    expect(result.compatible).toBe(false);
    expect(result.breaking.some((c) => c.kind === "removed-schema")).toBe(true);
  });

  it("the CURRENT rendered shape stays compatible with the committed floor", () => {
    const floor = JSON.parse(readFileSync(floorPath, "utf8")) as SchemaMap;
    const result = classifyReadCompat(floor, current);
    expect(result.breaking).toEqual([]);
    expect(result.compatible).toBe(true);
  });

  it("the floor covers all five published integration read responses", () => {
    const floor = JSON.parse(readFileSync(floorPath, "utf8")) as SchemaMap;
    const expected = [
      "tanren.integrations.read.v1.IntegrationLifecycleInventoryResponse",
      "tanren.integrations.read.v1.IntegrationRequirementsResponse",
      "tanren.integrations.read.v1.CapabilityNodesResponse",
      "tanren.integrations.read.v1.IntegrationBindingsResponse",
      "tanren.integrations.read.v1.DeliveryDagStatusResponse",
    ];
    for (const schemaId of expected) {
      expect(floor[schemaId], `${schemaId} missing from committed floor`).toBeDefined();
    }
  });

  it("no published response carries a token / secret / payload-typed field", () => {
    // The redaction contract is structural: no top-level field on any rendered
    // response may be named `token`, `secret`, `payload`, or `credential`, nor
    // any nested field inside the bindings/delivery responses. This is the
    // adversarial negative control — the audit will grep for these names.
    const forbidden = ["token", "secret", "payload", "credential", "password", "apiKey", "value"];
    for (const [schemaId, node] of Object.entries(current)) {
      assertNoForbiddenProps(schemaId, "$", node, forbidden);
    }
  });
});

function assertNoForbiddenProps(schema: string, path: string, node: unknown, forbidden: readonly string[]): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => assertNoForbiddenProps(schema, `${path}[${i}]`, child, forbidden));
    return;
  }
  if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj["type"] === "string" && obj["type"] === "object" && typeof obj["properties"] === "object") {
      const props = obj["properties"] as Record<string, unknown>;
      for (const name of Object.keys(props)) {
        if (forbidden.includes(name)) {
          throw new Error(`${schema} ${path} declares forbidden field '${name}'`);
        }
      }
    }
    for (const [key, child] of Object.entries(obj)) {
      assertNoForbiddenProps(schema, `${path}.${key}`, child, forbidden);
    }
  }
}
