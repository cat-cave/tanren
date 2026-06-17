import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  answererSchemaCatalog,
  type AnswererRole,
  renderAnswererJsonSchema,
} from "../src/engine/answerers/schemas/index.js";

// Walks up from the orchestrator package to the repo root so the drift test
// stays correct no matter where vitest is launched from.
const repoRoot = resolve(import.meta.dirname, "../../..");

function generatedFilePath(role: AnswererRole): string {
  return resolve(
    repoRoot,
    "services/orchestrator/src/engine/answerers/schemas/generated",
    answererSchemaCatalog[role].generatedFile,
  );
}

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

function expectedJson(role: AnswererRole): string {
  const descriptor = answererSchemaCatalog[role];
  const annotated = {
    ...renderAnswererJsonSchema(descriptor.zod),
    "x-tanren-schema-id": descriptor.schemaId,
  };
  return `${JSON.stringify(sortKeys(annotated), null, 2)}\n`;
}

describe("answerer JSON Schema drift", () => {
  it("exposes the Answerer roles in a stable order", () => {
    const roles = Object.keys(answererSchemaCatalog) as AnswererRole[];
    expect(roles).toEqual([
      "plan",
      "check",
      "audit",
      "triage",
      "convergence",
      "demo",
      "demoRun",
      "designOracle",
      "forge",
      "review",
      "conflict",
    ]);
  });

  it("regenerates byte-identical JSON Schema for every committed mirror", () => {
    const roles = Object.keys(answererSchemaCatalog) as AnswererRole[];
    for (const role of roles) {
      const path = generatedFilePath(role);
      const committed = readFileSync(path, "utf8");
      expect(
        committed,
        `${role}.json drifted from the Zod source; rerun \`corepack pnpm run codegen:answerer-schemas\``,
      ).toEqual(expectedJson(role));
    }
  });

  it("annotates every generated mirror with its x-tanren-schema-id", () => {
    const roles = Object.keys(answererSchemaCatalog) as AnswererRole[];
    for (const role of roles) {
      const committed = JSON.parse(readFileSync(generatedFilePath(role), "utf8")) as Record<string, unknown>;
      expect(committed["x-tanren-schema-id"]).toBe(answererSchemaCatalog[role].schemaId);
    }
  });
});
