#!/usr/bin/env node
// Track C §3 — unified JSON-Schema export of the project's Zod-defined
// contracts. Emits one JSON Schema file per contract under `contracts/json/**`
// (the language-neutral source-of-truth a future Rust port generates serde
// types from). Acts as both a codegen step (no flags) and a drift check
// (--check), mirroring scripts/answerer-schema-export.mjs.
//
// Usage:
//   node scripts/contract-schema-export.mjs           # write files if drifted
//   node scripts/contract-schema-export.mjs --check    # exit 1 on drift
//
// Source of truth: services/orchestrator/src/engine/schemaExport/catalog.ts
// (which itself imports the already-authored Zod schemas — event payloads,
// state enums, answerer schemas, HTTP request/response, workflow insights).
// Committed mirror: contracts/json/**.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argv, exit } from "node:process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(repoRoot, "contracts/json");
const catalogEntry = resolve(repoRoot, "services/orchestrator/src/engine/schemaExport/catalog.ts");

const dumper = `
import { contractSchemaCatalog, renderContractJsonSchema } from ${JSON.stringify(catalogEntry)};
const out = [];
for (const d of contractSchemaCatalog) {
  out.push({
    family: d.family,
    generatedFile: d.generatedFile,
    schemaId: d.schemaId,
    jsonSchema: renderContractJsonSchema(d.zod),
  });
}
process.stdout.write(JSON.stringify(out));
`;

function dumpSchemasViaTsx() {
  const result = spawnSync("corepack", ["pnpm", "exec", "tsx", "--eval", dumper], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
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
  const annotated = { ...jsonSchema, "x-tanren-schema-id": schemaId };
  return `${JSON.stringify(sortKeys(annotated), null, 2)}\n`;
}

function readCurrent(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

// Walk the committed tree so we can detect stale files (a contract removed from
// the catalog must drop its JSON). Returns repo-relative `contracts/json/...`
// paths.
function listExistingJson(dir, prefix) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of entries) {
    const abs = resolve(dir, name);
    const rel = `${prefix}/${name}`;
    if (statSync(abs).isDirectory()) {
      found.push(...listExistingJson(abs, rel));
    } else if (name.endsWith(".json")) {
      found.push(rel);
    }
  }
  return found;
}

function main() {
  const args = new Set(argv.slice(2));
  const check = args.has("--check");
  const schemas = dumpSchemasViaTsx();
  const drifted = [];
  const expectedFiles = new Set();

  for (const { generatedFile, schemaId, jsonSchema } of schemas) {
    const rel = `contracts/json/${generatedFile}`;
    expectedFiles.add(rel);
    const filePath = resolve(outDir, generatedFile);
    const expected = renderJson(jsonSchema, schemaId);
    const current = readCurrent(filePath);

    if (current === expected) {
      continue;
    }
    if (check) {
      drifted.push(generatedFile);
      continue;
    }
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, expected);
    process.stdout.write(`updated: ${rel}\n`);
  }

  // Stale files: present on disk but no longer in the catalog.
  const stale = listExistingJson(outDir, "contracts/json").filter((rel) => !expectedFiles.has(rel));
  for (const rel of stale) {
    if (check) {
      drifted.push(`${rel} (stale)`);
    } else {
      rmSync(resolve(repoRoot, rel));
      process.stdout.write(`removed stale: ${rel}\n`);
    }
  }

  if (check && drifted.length > 0) {
    process.stderr.write(
      `contract JSON Schema drift detected for: ${drifted.join(", ")}.\n` +
        "Regenerate with `corepack pnpm run codegen:contract-schemas`.\n",
    );
    exit(1);
  }

  if (!check) {
    process.stdout.write(`contract JSON Schemas up to date (${schemas.length} files).\n`);
  }
}

main();
