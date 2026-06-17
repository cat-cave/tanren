// Guards the OpenAI strict-structured-outputs contract that
// `renderAnswererJsonSchema` must satisfy. OpenAI's strict mode (which
// `codex exec --output-schema` drives) rejects any object whose `required` does
// not list EVERY key of its `properties`, or that omits
// `additionalProperties:false` — a Forge interview call previously failed live
// with `invalid_json_schema: 'required' is required ... Missing 'identity'`
// because Zod's plain JSON Schema drops optional/`.partial()` keys from
// `required`. These tests pin the rewrite that fixes it, and the round-trip
// that keeps the (now null-bearing) model output parseable.

import { describe, expect, it } from "vitest";

import {
  answererSchemaCatalog,
  renderAnswererJsonSchema,
  type AnswererRole,
} from "../src/engine/answerers/schemas/index.js";
import { InterviewRoundOutput, emptyCapture } from "../src/engine/forge/interview/types.js";
import { mergeCapture } from "../src/engine/forge/interview/capture.js";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Walks every node and collects strict-mode violations: an object whose
// `required` is not exactly its property keys, or that does not pin
// `additionalProperties:false`.
function strictViolations(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => strictViolations(item, `${path}[${i}]`, out));
    return;
  }
  if (!isJsonObject(node)) return;

  const properties = node["properties"];
  if (isJsonObject(properties)) {
    const keys = Object.keys(properties).sort();
    const required = Array.isArray(node["required"]) ? [...(node["required"] as string[])].sort() : [];
    if (JSON.stringify(keys) !== JSON.stringify(required)) {
      out.push(`${path}: required ${JSON.stringify(required)} !== properties ${JSON.stringify(keys)}`);
    }
    if (node["additionalProperties"] !== false) {
      out.push(`${path}: additionalProperties is ${JSON.stringify(node["additionalProperties"])}, expected false`);
    }
  }

  for (const [key, value] of Object.entries(node)) {
    strictViolations(value, `${path}.${key}`, out);
  }
}

describe("renderAnswererJsonSchema → OpenAI strict structured outputs", () => {
  // Every committed Answerer role plus the runtime-only Forge interview schema
  // (which carries the `.partial()` field that triggered the live 400).
  const cases: ReadonlyArray<{ name: string; schema: ReturnType<typeof renderAnswererJsonSchema> }> = [
    ...(Object.keys(answererSchemaCatalog) as AnswererRole[]).map((role) => ({
      name: role,
      schema: renderAnswererJsonSchema(answererSchemaCatalog[role].zod),
    })),
    { name: "interviewRoundOutput", schema: renderAnswererJsonSchema(InterviewRoundOutput) },
  ];

  for (const { name, schema } of cases) {
    it(`emits required==all property keys + additionalProperties:false for every object (${name})`, () => {
      const violations: string[] = [];
      strictViolations(schema, name, violations);
      expect(violations).toEqual([]);
    });
  }

  it("expresses the InterviewRoundOutput captureDelta optionals as nullable + required (the live-400 shape)", () => {
    const schema = renderAnswererJsonSchema(InterviewRoundOutput) as JsonObject;
    const captureDelta = (schema["properties"] as JsonObject)["captureDelta"] as JsonObject;

    // `required` now lists EVERY key — including the `identity` the live API
    // complained was missing.
    const props = Object.keys(captureDelta["properties"] as JsonObject).sort();
    expect([...(captureDelta["required"] as string[])].sort()).toEqual(props);
    expect(captureDelta["required"]).toContain("identity");
    expect(captureDelta["additionalProperties"]).toBe(false);

    // A previously-optional array field (`personas`) is now nullable so the
    // model can return null instead of omitting it.
    const personas = (captureDelta["properties"] as JsonObject)["personas"] as JsonObject;
    const branches = personas["anyOf"] as JsonObject[];
    expect(branches.some((b) => b["type"] === "null")).toBe(true);
    expect(branches.some((b) => b["type"] === "array")).toBe(true);
  });

  it("does not double-wrap an already-nullable property in two null branches", () => {
    // `identity` is `.nullable()` at the Zod source, so it already renders with
    // a single `{type:"null"}` branch — the rewrite must leave it as one.
    const schema = renderAnswererJsonSchema(InterviewRoundOutput) as JsonObject;
    const captureDelta = (schema["properties"] as JsonObject)["captureDelta"] as JsonObject;
    const identity = (captureDelta["properties"] as JsonObject)["identity"] as JsonObject;
    const nullBranches = (identity["anyOf"] as JsonObject[]).filter((b) => b["type"] === "null");
    expect(nullBranches).toHaveLength(1);
  });
});

describe("strict-schema round-trip: null-bearing model output stays parseable", () => {
  it("parses an InterviewRoundOutput whose previously-optional fields are null", () => {
    // The exact shape OpenAI strict mode now returns: every key present, with
    // `null` for the fields the round had nothing to add.
    const modelOutput = {
      say: "Tell me about your product.",
      captureDelta: {
        identity: null,
        personas: null,
        behaviors: null,
        interfaces: null,
        designContract: null,
        architecture: null,
        rulesets: null,
      },
      suggestions: [],
      complete: false,
    };

    const parsed = InterviewRoundOutput.parse(modelOutput);
    expect(parsed.say).toBe("Tell me about your product.");
    expect(parsed.captureDelta.identity).toBeNull();
    expect(parsed.captureDelta.personas).toBeNull();

    // And `null` deltas merge as a no-op (treated like an omitted field).
    const merged = mergeCapture(emptyCapture(), parsed.captureDelta);
    expect(merged).toEqual(emptyCapture());
  });

  it("merges a partially-populated null-bearing delta", () => {
    const modelOutput = {
      say: "Got it.",
      captureDelta: {
        identity: { slug: "acme", pitch: "the thing", repoHint: "" },
        personas: [{ name: "Operator", description: "runs it", surface: "" }],
        behaviors: null,
        interfaces: null,
        designContract: null,
        architecture: null,
        rulesets: null,
      },
      suggestions: [],
      complete: false,
    };

    const parsed = InterviewRoundOutput.parse(modelOutput);
    const merged = mergeCapture(emptyCapture(), parsed.captureDelta);
    expect(merged.identity?.slug).toBe("acme");
    expect(merged.personas).toHaveLength(1);
    expect(merged.behaviors).toEqual([]);
  });
});
