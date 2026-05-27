#!/usr/bin/env node
// Regenerates services/orchestrator/src/engine/answerers/schemas/generated/*.json
// from the Zod schemas in services/orchestrator/src/engine/answerers/schemas/.
// Acts as both a codegen step (no flags) and a drift check (--check).
//
// Usage:
//   node scripts/answerer-schema-export.mjs           # write files if drifted
//   node scripts/answerer-schema-export.mjs --check   # exit 1 on drift
//
// Source of truth: services/orchestrator/src/engine/answerers/schemas/*.ts.
// Committed mirror: services/orchestrator/src/engine/answerers/schemas/generated/*.json.
// These JSON files are passed to `codex exec --output-schema` so the runtime
// validator and the LLM see the same shape that the Zod source produces.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argv, exit } from "node:process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedDir = resolve(
  repoRoot,
  "services/orchestrator/src/engine/answerers/schemas/generated"
);
const catalogEntry = resolve(
  repoRoot,
  "services/orchestrator/src/engine/answerers/schemas/index.ts"
);

const dumper = `
import { answererSchemaCatalog, renderAnswererJsonSchema } from ${JSON.stringify(catalogEntry)};
const out = {};
for (const [role, descriptor] of Object.entries(answererSchemaCatalog)) {
  out[role] = {
    schemaId: descriptor.schemaId,
    generatedFile: descriptor.generatedFile,
    jsonSchema: renderAnswererJsonSchema(descriptor.zod)
  };
}
process.stdout.write(JSON.stringify(out));
`;

function dumpSchemasViaTsx() {
  const result = spawnSync("corepack", ["pnpm", "exec", "tsx", "--eval", dumper], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "tsx eval failed\n");
    exit(1);
  }
  return JSON.parse(result.stdout);
}

// Recursively sort object keys so the committed JSON files are byte-stable
// regardless of the order Zod's generator emits properties.
function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys(value[key]);
    }
    return out;
  }
  return value;
}

function renderJson(jsonSchema, schemaId) {
  const annotated = { ...jsonSchema };
  // Embed the Tanren schema id (e.g. "tanren.check_answer.v2") alongside the
  // generated JSON Schema so downstream tooling can identify the role
  // without a path lookup.
  annotated["x-tanren-schema-id"] = schemaId;
  return `${JSON.stringify(sortKeys(annotated), null, 2)}\n`;
}

function readCurrent(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function main() {
  const args = new Set(argv.slice(2));
  const check = args.has("--check");
  const schemas = dumpSchemasViaTsx();
  const drifted = [];

  for (const [role, { schemaId, generatedFile, jsonSchema }] of Object.entries(schemas)) {
    const filePath = resolve(generatedDir, generatedFile);
    const expected = renderJson(jsonSchema, schemaId);
    const current = readCurrent(filePath);

    if (current === expected) {
      if (!check) {
        process.stdout.write(`up to date: ${generatedFile}\n`);
      }
      continue;
    }

    if (check) {
      drifted.push(role);
      continue;
    }

    writeFileSync(filePath, expected);
    process.stdout.write(`updated: ${generatedFile}\n`);
  }

  if (check && drifted.length > 0) {
    process.stderr.write(
      `answerer JSON Schema drift detected for: ${drifted.join(", ")}.\n` +
        "Regenerate with `corepack pnpm run codegen:answerer-schemas`.\n"
    );
    exit(1);
  }
}

main();
