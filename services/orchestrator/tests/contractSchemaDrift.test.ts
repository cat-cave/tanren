import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { contractSchemaCatalog, renderContractJsonSchema } from "../src/engine/schemaExport/catalog.js";

// Walks up from the orchestrator package to the repo root so the drift test
// stays correct no matter where vitest is launched from. The committed mirror
// lives at contracts/json/** (the unified JSON-Schema export, Track C §3).
const repoRoot = resolve(import.meta.dirname, "../../..");

function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeys(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out as unknown as T;
  }
  return value;
}

function expectedJson(zod: Parameters<typeof renderContractJsonSchema>[0], schemaId: string): string {
  const annotated = { ...renderContractJsonSchema(zod), "x-tanren-schema-id": schemaId };
  return `${JSON.stringify(sortKeys(annotated), null, 2)}\n`;
}

describe("contract JSON Schema drift", () => {
  it("catalogs every contract family the export covers", () => {
    const families = new Set(contractSchemaCatalog.map((d) => d.family));
    expect([...families].sort()).toEqual(["answerers", "events", "http", "insights", "integrations", "state"]);
  });

  it("emits files into a stable, sorted tree with unique generated paths", () => {
    const files = contractSchemaCatalog.map((d) => d.generatedFile);
    expect(files).toEqual([...files].sort((a, b) => a.localeCompare(b)));
    expect(new Set(files).size).toBe(files.length);
  });

  it("regenerates byte-identical JSON Schema for every committed mirror", () => {
    for (const d of contractSchemaCatalog) {
      const path = resolve(repoRoot, "contracts/json", d.generatedFile);
      const committed = readFileSync(path, "utf8");
      expect(
        committed,
        `${d.generatedFile} drifted from the Zod source; rerun \`corepack pnpm run codegen:contract-schemas\``,
      ).toEqual(expectedJson(d.zod, d.schemaId));
    }
  });

  it("annotates every generated mirror with its x-tanren-schema-id", () => {
    for (const d of contractSchemaCatalog) {
      const path = resolve(repoRoot, "contracts/json", d.generatedFile);
      const committed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(committed["x-tanren-schema-id"]).toBe(d.schemaId);
    }
  });
});
