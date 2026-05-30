#!/usr/bin/env node
// Regenerates db/src/stateEnums.ts and a SQL preview from the Zod enums in
// services/orchestrator/src/engine/state/*. Acts as both a codegen step and a
// drift check.
//
// Usage:
//   node scripts/generate-state-checks.mjs            # write files if drifted
//   node scripts/generate-state-checks.mjs --check    # exit 1 on drift
//   node scripts/generate-state-checks.mjs --emit-sql # print SQL CHECK clauses
//
// Source of truth: services/orchestrator/src/engine/state/*.ts.
// Committed mirror: db/src/stateEnums.ts.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { exit, argv } from "node:process";

const repoRoot = resolve(import.meta.dirname, "..");
const stateEnumsFile = resolve(repoRoot, "db/src/stateEnums.ts");
const stateIndexFile = resolve(repoRoot, "services/orchestrator/src/engine/state/index.ts");

const dumper = `
import { stateEnumCatalog } from ${JSON.stringify(stateIndexFile)};
const out = {};
for (const [name, descriptor] of Object.entries(stateEnumCatalog)) {
  out[name] = { table: descriptor.table, column: descriptor.column, values: [...descriptor.values] };
}
process.stdout.write(JSON.stringify(out));
`;

function dumpEnumsViaTsx() {
  const result = spawnSync("corepack", ["pnpm", "exec", "tsx", "--eval", dumper], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "tsx eval failed\n");
    exit(1);
  }
  return JSON.parse(result.stdout);
}

function renderStateEnumsTs(enums) {
  const lines = [
    "// GENERATED FILE — do not edit by hand.",
    "// Regenerate via `corepack pnpm run codegen:state` (or `node scripts/generate-state-checks.mjs`).",
    "// Source of truth: services/orchestrator/src/engine/state/*.ts (Zod enums).",
    "// The drift check at `scripts/check-schema-drift.sh` and the dedicated state",
    "// drift check confirm this file matches the Zod source.",
    "",
    "export const stateEnumLists = {",
  ];
  const entries = Object.entries(enums);
  entries.forEach(([name, descriptor], index) => {
    lines.push(`  ${name}: [`);
    descriptor.values.forEach((value, valueIndex) => {
      const trailing = valueIndex === descriptor.values.length - 1 ? "" : ",";
      lines.push(`    ${JSON.stringify(value)}${trailing}`);
    });
    lines.push(`  ]${index === entries.length - 1 ? "" : ","}`);
  });
  lines.push("} as const;", "", "export type StateEnumName = keyof typeof stateEnumLists;", "");
  return lines.join("\n");
}

function renderSqlClauses(enums) {
  const lines = [];
  for (const [name, descriptor] of Object.entries(enums)) {
    const values = descriptor.values.map((value) => `'${value.replaceAll("'", "''")}'`).join(",");
    // Outcome columns are nullable in the schema; render IS NULL OR ... for them.
    const nullable = descriptor.column === "outcome";
    const expression = nullable
      ? `"${descriptor.table}"."${descriptor.column}" IS NULL OR "${descriptor.table}"."${descriptor.column}" IN (${values})`
      : `"${descriptor.table}"."${descriptor.column}" IN (${values})`;
    lines.push(`-- ${name}`);
    lines.push(`ALTER TABLE "${descriptor.table}" ADD CONSTRAINT "${name}_check" CHECK (${expression});`);
  }
  return lines.join("\n");
}

function main() {
  const args = new Set(argv.slice(2));
  const enums = dumpEnumsViaTsx();
  const expectedTs = renderStateEnumsTs(enums);
  const currentTs = (() => {
    try {
      return readFileSync(stateEnumsFile, "utf8");
    } catch {
      return "";
    }
  })();

  if (args.has("--emit-sql")) {
    process.stdout.write(renderSqlClauses(enums));
    process.stdout.write("\n");
  }

  if (args.has("--check")) {
    if (currentTs.trimEnd() !== expectedTs.trimEnd()) {
      process.stderr.write("state enum drift detected. Regenerate with `corepack pnpm run codegen:state`.\n");
      exit(1);
    }
    return;
  }

  if (currentTs.trimEnd() === expectedTs.trimEnd()) {
    process.stdout.write("state enum mirror up to date\n");
  } else {
    writeFileSync(stateEnumsFile, expectedTs);
    process.stdout.write(`updated ${stateEnumsFile}\n`);
  }
}

main();
