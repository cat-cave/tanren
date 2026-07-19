// rv-22 — proves the read-compat guard actually GUARDS (it is not a no-op): the
// classifier FAILS (compatible=false) on a backward-incompatible response-schema
// change — a removed / renamed / retyped field, a removed enum member, a weakened
// required guarantee, a dropped schema — and PASSES (compatible=true) on a
// backward-compatible additive change. It also asserts the CURRENT rendered shape
// stays compatible with the committed floor (contracts/rv-read-compat/v1.json),
// so a local `just affected-test` catches a breaking change the same way the
// `just rv-read-compat` CI gate does.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyReadCompat, type SchemaMap } from "../src/engine/verification/readCompat/classifyReadCompat.js";
import { renderVerificationReadSchemas } from "../src/routes/runtimeVerification/contract.js";

const floorPath = fileURLToPath(new URL("../../../contracts/rv-read-compat/v1.json", import.meta.url));

function clone(value: SchemaMap): SchemaMap {
  return structuredClone(value);
}

describe("rv-22 read-compat classifier — the guard actually guards", () => {
  const current = renderVerificationReadSchemas();
  const runDetail = "tanren.rv.read.v1.VerificationRunDetail";

  it("PASSES when the shape is unchanged", () => {
    const result = classifyReadCompat(current, current);
    expect(result.compatible).toBe(true);
    expect(result.breaking).toHaveLength(0);
  });

  it("PASSES on a backward-compatible additive change (a new field)", () => {
    const candidate = clone(current);
    const props = (candidate[runDetail] as { properties: Record<string, unknown> }).properties;
    props["newlyAddedField"] = { type: "string" };
    const result = classifyReadCompat(current, candidate);
    expect(result.compatible).toBe(true);
    expect(result.additive.some((c) => c.kind === "added-property")).toBe(true);
  });

  it("PASSES on an additive enum value", () => {
    const candidate = clone(current);
    const status = (
      candidate[runDetail] as { properties: Record<string, { properties: Record<string, { enum?: unknown[] }> }> }
    ).properties["run"].properties["status"];
    status.enum = [...(status.enum ?? []), "brand_new_status"];
    const result = classifyReadCompat(current, candidate);
    expect(result.compatible).toBe(true);
    expect(result.additive.some((c) => c.kind === "added-enum-value")).toBe(true);
  });

  it("DECISIVE: FAILS when a field is removed", () => {
    const candidate = clone(current);
    const props = (candidate[runDetail] as { properties: Record<string, unknown> }).properties;
    delete props["proofBundleHref"];
    const result = classifyReadCompat(current, candidate);
    expect(result.compatible).toBe(false);
    expect(result.breaking.some((c) => c.kind === "removed-property" && c.path.endsWith("proofBundleHref"))).toBe(true);
  });

  it("DECISIVE: FAILS when a field is renamed (old name removed)", () => {
    const candidate = clone(current);
    const props = (candidate[runDetail] as { properties: Record<string, unknown> }).properties;
    props["proof_bundle_href"] = props["proofBundleHref"];
    delete props["proofBundleHref"];
    const result = classifyReadCompat(current, candidate);
    expect(result.compatible).toBe(false);
    expect(result.breaking.some((c) => c.kind === "removed-property")).toBe(true);
  });

  it("DECISIVE: FAILS when a field is retyped", () => {
    const candidate = clone(current);
    const props = (candidate[runDetail] as { properties: Record<string, { type?: string }> }).properties;
    props["proofBundleHref"] = { type: "integer" };
    const result = classifyReadCompat(current, candidate);
    expect(result.compatible).toBe(false);
    expect(result.breaking.some((c) => c.kind === "type-changed")).toBe(true);
  });

  it("FAILS when an enum member is removed (the closed set shrinks)", () => {
    const candidate = clone(current);
    const outcome = (
      (
        candidate[runDetail] as {
          properties: Record<
            string,
            { properties: Record<string, { items: { properties: Record<string, { enum: unknown[] }> } }> }
          >;
        }
      ).properties["verdicts"] as unknown as { items: { properties: Record<string, { enum: unknown[] }> } }
    ).items.properties["outcome"];
    outcome.enum = outcome.enum.filter((v) => v !== "failed_product");
    const result = classifyReadCompat(current, candidate);
    expect(result.compatible).toBe(false);
    expect(result.breaking.some((c) => c.kind === "removed-enum-value")).toBe(true);
  });

  it("FAILS when a whole schema is dropped", () => {
    const candidate = clone(current);
    delete candidate[runDetail];
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
});
