import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EventRegistry, isEventName, sensitivityFor } from "../src/engine/events/index.js";
import { runtimeVocabularyRegistry } from "../src/engine/events/schemas/runtimeVocabulary.js";
import { eventDefaultSeverity } from "../src/engine/notifications/index.js";

// rv-25 REGISTRATION-COMPLETENESS GUARD.
//
// The runtime behavior-proof vocabulary is FROZEN in runtimeVocabulary.ts and
// fully registered (schema in the EventRegistry, a sensitivity rule for every
// payload field, a default severity, and a mirror row in the committed
// db/src/eventTypesSeed.ts). This guard makes that completeness a CI invariant:
// it FAILS if any runtime-verification event that (a) is frozen in the
// vocabulary or (b) is actually EMITTED by a runtime-verification code path
// loses ANY of its four registration facets. It runs under `just fast-check`
// via the existing `test` step — no separate wiring needed.
//
// A future rv node that adds an emitter for a NOT-fully-registered event name
// (missing schema / sensitivity / severity / seed-mirror) trips this guard.

const VALID_SEVERITIES = new Set(["ok", "info", "warn", "fail"]);

// The runtime-verification subsystem source roots. Every `.ts` file under these
// (excluding tests) is scanned for the event names it emits.
const RUNTIME_VERIFICATION_SOURCE_ROOTS = [
  "../src/engine/verification",
  "../src/engine/demo",
  "../src/engine/postMerge",
  "../src/engine/runtimeVerification",
  "../src/engine/deploy",
] as const;

// ---------------------------------------------------------------------------
// Zod leaf-path walker (mirrors eventSemanticFields.test.ts): enumerates every
// reachable payload field so sensitivity coverage is checked against the ACTUAL
// schema shape, not a hand-maintained list.
// ---------------------------------------------------------------------------
function collectZodPaths(schema: unknown, prefix = ""): string[] {
  const paths: string[] = [];
  const def = (
    schema as {
      def?: {
        type?: string;
        shape?: Record<string, unknown>;
        element?: unknown;
        innerType?: unknown;
        options?: unknown[];
      };
    }
  ).def;
  if (def === undefined) {
    if (prefix !== "") paths.push(prefix);
    return paths;
  }
  const type = def.type;
  if (type === "object" && def.shape !== undefined) {
    for (const [key, value] of Object.entries(def.shape)) {
      paths.push(...collectZodPaths(value, prefix === "" ? key : `${prefix}.${key}`));
    }
    return paths;
  }
  if (type === "array" && def.element !== undefined) {
    paths.push(...collectZodPaths(def.element, `${prefix}[]`));
    return paths;
  }
  if ((type === "optional" || type === "nullable" || type === "default") && def.innerType !== undefined) {
    paths.push(...collectZodPaths(def.innerType, prefix));
    return paths;
  }
  if (type === "union" && Array.isArray(def.options)) {
    const first = def.options.find((opt) => (opt as { def?: { type?: string } }).def?.type !== "null");
    if (first !== undefined) {
      paths.push(...collectZodPaths(first, prefix));
      return paths;
    }
  }
  if (prefix !== "") paths.push(prefix);
  return paths;
}

// ---------------------------------------------------------------------------
// Registration facets. `registrationGaps` returns the facets a name is MISSING;
// an empty array means the name is fully registered. This one function is the
// guard core — the real assertions require it to be empty, and the negative
// control proves it discriminates (so the guard can never silently pass).
// ---------------------------------------------------------------------------
const seedRows = [
  ...readFileSync(fileURLToPath(new URL("../../../db/src/eventTypesSeed.ts", import.meta.url)), "utf8").matchAll(
    /\{ name: "(?<name>[^"]+)", defaultSeverity: "(?<severity>ok|info|warn|fail)" \}/gu,
  ),
].map((match) => ({ name: match.groups?.["name"] ?? "", severity: match.groups?.["severity"] ?? "" }));
const seedNames = new Set(seedRows.map((row) => row.name));

function registrationGaps(name: string): string[] {
  const gaps: string[] = [];
  // (a) schema — registered in the EventRegistry as a parseable Zod schema.
  const schema = isEventName(name) ? EventRegistry[name] : undefined;
  if (schema === undefined || typeof schema.parse !== "function") {
    gaps.push("schema");
  } else {
    // (b) sensitivity — every reachable payload field carries a registered tag.
    for (const path of collectZodPaths(schema)) {
      if (sensitivityFor(name, path) === undefined) {
        gaps.push(`sensitivity:${path}`);
      }
    }
  }
  // (c) severity — a valid default severity is mapped for the name.
  const severity = (eventDefaultSeverity as Record<string, string>)[name];
  if (severity === undefined || !VALID_SEVERITIES.has(severity)) {
    gaps.push("severity");
  }
  // (d) seed-mirror — a row exists in the committed event_types seed mirror.
  if (!seedNames.has(name)) {
    gaps.push("seed");
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// Static discovery of the ACTUALLY-EMITTED runtime-verification event names:
// every `eventType: "..."` literal under the subsystem source roots.
// ---------------------------------------------------------------------------
function collectEmittedEventNames(): string[] {
  const emitted = new Set<string>();
  for (const root of RUNTIME_VERIFICATION_SOURCE_ROOTS) {
    const rootDir = fileURLToPath(new URL(root, import.meta.url));
    for (const entry of readdirSync(rootDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      const source = readFileSync(join(entry.parentPath, entry.name), "utf8");
      for (const match of source.matchAll(/eventType:\s*"(?<name>[a-z0-9_.]+)"/gu)) {
        const name = match.groups?.["name"];
        if (name !== undefined) emitted.add(name);
      }
    }
  }
  return [...emitted].sort();
}

const FROZEN_RUNTIME_EVENTS = Object.keys(runtimeVocabularyRegistry).sort();
const EMITTED_RUNTIME_EVENTS = collectEmittedEventNames();

describe("runtime-verification event registration completeness (rv-25)", () => {
  it("discovers the emitted runtime-verification event names by static scan", () => {
    // A broken scan (0 hits) must fail loudly rather than vacuously pass.
    expect(EMITTED_RUNTIME_EVENTS.length).toBeGreaterThan(0);
    // Sanity anchors: the frozen post-merge + deployment lanes are emitted.
    expect(EMITTED_RUNTIME_EVENTS).toContain("post_merge.behavior.verified");
    expect(EMITTED_RUNTIME_EVENTS).toContain("deployment.promoted");
  });

  it("registers every FROZEN runtime vocabulary event with schema + sensitivity + severity + seed", () => {
    const incomplete = FROZEN_RUNTIME_EVENTS.map((name) => [name, registrationGaps(name)] as const).filter(
      ([, gaps]) => gaps.length > 0,
    );
    expect(incomplete).toEqual([]);
    // The frozen vocabulary schema objects ARE the ones in the live registry.
    for (const name of FROZEN_RUNTIME_EVENTS) {
      expect(EventRegistry[name as keyof typeof EventRegistry]).toBe(
        runtimeVocabularyRegistry[name as keyof typeof runtimeVocabularyRegistry],
      );
    }
  });

  it("registers every EMITTED runtime-verification event with schema + sensitivity + severity + seed", () => {
    const incomplete = EMITTED_RUNTIME_EVENTS.map((name) => [name, registrationGaps(name)] as const).filter(
      ([, gaps]) => gaps.length > 0,
    );
    expect(incomplete).toEqual([]);
  });

  it("is not a no-op: registrationGaps flags an unregistered event on every facet (negative control)", () => {
    // An event name no code emits and nothing registers must report ALL facets
    // missing — proving the guard discriminates rather than always passing.
    const gaps = registrationGaps("behavior.__unregistered_probe__.missing");
    expect(gaps).toContain("schema");
    expect(gaps).toContain("severity");
    expect(gaps).toContain("seed");

    // And a real, registered event reports NO gaps through the same function —
    // so removing any facet's registration for it would surface here.
    expect(registrationGaps("deployment.promoted")).toEqual([]);
  });
});
