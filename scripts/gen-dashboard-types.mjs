#!/usr/bin/env node
// Move #3 of docs/architecture/future-refactor-and-scale.md — generate the
// dashboard's client-side response types from the orchestrator's JSON-Schema
// export instead of hand-mirroring them. This closes the largest type-sharing
// gap in the system: the BFF↔orchestrator HTTP contract was a third
// hand-maintained copy (Zod → JSON-Schema → hand-typed TS mirror) with no
// drift gate.
//
// Source of truth: contracts/json/http/**  (the neutral JSON-Schema artifact
//   the orchestrator emits via scripts/contract-schema-export.mjs from Zod).
// Generated output: services/dashboard/src/api/http.gen.ts
//   (one exported `interface`/`type` per HTTP schema; the dashboard's
//   api/types.ts re-exports the subset it consumes).
//
// Acts as both a codegen step (no flags) and a drift check (--check), mirroring
// scripts/contract-schema-export.mjs and scripts/answerer-schema-export.mjs.
//
// Usage:
//   node scripts/gen-dashboard-types.mjs           # write the file if drifted
//   node scripts/gen-dashboard-types.mjs --check    # exit 1 on drift
//
// A future Rust backend reuses the SAME contracts/json/** source via `typify`
// → serde (docs/architecture/portability-and-longevity.md §3); this script is
// the TypeScript arm of that single-neutral-source pipeline.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { argv, exit } from "node:process";

const repoRoot = resolve(import.meta.dirname, "..");
const httpSchemaDir = resolve(repoRoot, "contracts/json/http");
const outFile = resolve(repoRoot, "services/dashboard/src/api/http.gen.ts");
const outFileRel = "services/dashboard/src/api/http.gen.ts";

// Convert one JSON-Schema node to a TypeScript type expression. The exporter
// emits self-contained schemas (no $ref) in a small, closed dialect:
//   - { enum: [...], type: "string" }          → string-literal union
//   - { anyOf: [...] }                          → union (covers nullable +
//                                                  number|string id columns)
//   - { type: "object", properties, required } → inline object literal
//   - { type: "array", items }                 → T[]
//   - { type: "string"|"integer"|"number"|"boolean"|"null" } → primitive
//   - {} (empty schema)                         → unknown (z.unknown() fields:
//                                                  payload, insights, recentTurns)
// Anything outside this dialect throws, so a contract that grows a construct
// the generator can't represent fails loudly instead of emitting `any`.
// Exported so the drift-gate behavior test can exercise the mapping directly.
export function tsType(node) {
  if (node === null || typeof node !== "object") {
    throw new Error(`unexpected schema node: ${JSON.stringify(node)}`);
  }

  // Empty schema {} (modulo the format/default annotations the exporter may
  // attach) means "any JSON value" — z.unknown(). We treat it as `unknown`.
  const structuralKeys = ["enum", "anyOf", "allOf", "oneOf", "type", "properties", "items"];
  const hasStructure = structuralKeys.some((k) => k in node);
  if (!hasStructure) {
    return "unknown";
  }

  if (Array.isArray(node.enum)) {
    return node.enum.map((v) => JSON.stringify(v)).join(" | ");
  }

  if (Array.isArray(node.anyOf)) {
    return unionOf(node.anyOf);
  }
  if (Array.isArray(node.oneOf)) {
    return unionOf(node.oneOf);
  }

  switch (node.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const item = node.items === undefined ? {} : node.items;
      const inner = tsType(item);
      // Wrap union element types in Array<...> so `A | B[]` is not ambiguous.
      return /[| ]/u.test(inner) ? `Array<${inner}>` : `${inner}[]`;
    }
    case "object":
      return objectType(node);
    default:
      throw new Error(`unsupported schema type: ${JSON.stringify(node.type)}`);
  }
}

function unionOf(variants) {
  const parts = variants.map((variant) => tsType(variant));
  // De-dupe (e.g. anyOf of identical refined strings) while preserving order.
  const seen = new Set();
  const unique = [];
  for (const p of parts) {
    if (!seen.has(p)) {
      seen.add(p);
      unique.push(p);
    }
  }
  return unique.join(" | ");
}

function objectType(node) {
  const properties = node.properties ?? {};
  const required = new Set(node.required ?? []);
  const keys = Object.keys(properties).sort();
  if (keys.length === 0) {
    return "Record<string, unknown>";
  }
  const lines = keys.map((key) => {
    const optional = required.has(key) ? "" : "?";
    const propType = tsType(properties[key]);
    return `  ${propName(key)}${optional}: ${propType};`;
  });
  return `{\n${lines.join("\n")}\n}`;
}

// Quote keys that are not plain identifiers (none today, but keep it safe).
function propName(key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? key : JSON.stringify(key);
}

// Derive the exported TS name from the schema id (`tanren.http.RunDetail` →
// `RunDetail`); fall back to the filename.
function typeName(schema, file) {
  const id = schema["x-tanren-schema-id"];
  if (typeof id === "string") {
    const parts = id.split(".");
    return parts.at(-1);
  }
  return file.replace(/\.json$/u, "");
}

function renderFile() {
  const files = readdirSync(httpSchemaDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  const blocks = files.map((file) => {
    const schema = JSON.parse(readFileSync(resolve(httpSchemaDir, file), "utf8"));
    const name = typeName(schema, file);
    const body = tsType(schema);
    const id = schema["x-tanren-schema-id"] ?? `http/${file}`;
    // Top-level object schemas become `interface`; anything else (none today)
    // becomes a `type` alias.
    if (body.startsWith("{")) {
      return `/** Generated from \`${id}\` (contracts/json/http/${file}). */\nexport interface ${name} ${body}`;
    }
    return `/** Generated from \`${id}\` (contracts/json/http/${file}). */\nexport type ${name} = ${body};`;
  });

  const header =
    "// @generated by scripts/gen-dashboard-types.mjs from contracts/json/http/** — regenerate with `corepack pnpm run codegen:dashboard-types`; do not edit.\n";

  return `${header}${blocks.join("\n\n")}\n`;
}

// Run the rendered source through oxfmt (the project's formatter, configured by
// .oxfmtrc.json) so the committed file is already format-clean — otherwise the
// `format:check` gate would reformat it and reintroduce drift against codegen.
// oxfmt has no Node API, so format via its stdin mode (the filepath only tells
// it which parser to use; the .oxfmtrc.json is picked up from the repo root).
function renderFormatted() {
  const raw = renderFile();
  const result = spawnSync("oxfmt", ["--stdin-filepath", outFile], { input: raw, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`oxfmt failed to format generated types: ${result.stderr || result.error}`);
  }
  return result.stdout;
}

function readCurrent() {
  try {
    return readFileSync(outFile, "utf8");
  } catch {
    // missing file → treat as no current content
  }
}

function main() {
  const check = new Set(argv.slice(2)).has("--check");
  const expected = renderFormatted();
  const current = readCurrent();

  if (current === expected) {
    if (!check) {
      process.stdout.write(`dashboard types up to date (${outFileRel}).\n`);
    }
    return;
  }

  if (check) {
    process.stderr.write(
      `dashboard generated types drift detected: ${outFileRel} differs from the ` +
        "committed JSON Schema.\n" +
        "Regenerate with `corepack pnpm run codegen:dashboard-types` and commit.\n",
    );
    exit(1);
  }

  writeFileSync(outFile, expected);
  process.stdout.write(`updated: ${outFileRel}\n`);
}

// Only run the CLI when invoked directly (not when imported by the test).
if (process.argv[1] === import.meta.filename) {
  main();
}
