#!/usr/bin/env node
// Regenerates db/src/eventTypes.ts (the committed mirror used by the schema
// CHECK constraint) from the Zod EventRegistry in
// services/orchestrator/src/engine/events/registry.ts. The check constraint
// admits only names that exist in the registry; the Zod schemas remain the
// single source of truth for payload shape (no SQL payload schema).
//
// Usage:
//   node scripts/generate-event-type-check.mjs            # write if drifted
//   node scripts/generate-event-type-check.mjs --check    # exit 1 on drift
//   node scripts/generate-event-type-check.mjs --emit-sql # print SQL CHECK

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { exit, argv } from "node:process";

const repoRoot = resolve(import.meta.dirname, "..");
const eventTypesFile = resolve(repoRoot, "db/src/eventTypes.ts");
const registryFile = resolve(repoRoot, "services/orchestrator/src/engine/events/registry.ts");

const dumper = `
import { listEventNames } from ${JSON.stringify(registryFile)};
process.stdout.write(JSON.stringify(listEventNames()));
`;

function dumpEventNamesViaTsx() {
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

function renderEventTypesTs(names) {
  const lines = [
    "// GENERATED FILE — do not edit by hand.",
    "// Regenerate via `corepack pnpm run codegen:events` (or `node scripts/generate-event-type-check.mjs`).",
    "// Source of truth: services/orchestrator/src/engine/events/registry.ts (Zod EventRegistry).",
    "",
    "export const eventTypeNames = [",
  ];
  names.forEach((name, index) => {
    const trailing = index === names.length - 1 ? "" : ",";
    lines.push(`  ${JSON.stringify(name)}${trailing}`);
  });
  lines.push(
    "] as const;",
    "",
    // `@public`: this generated type is part of the event-name contract (the union
    // mirror of the registry). It is intentionally exported for downstream/typed
    // consumers even when this monorepo has no internal reference — the tag tells
    // knip it is a deliberate public surface, not dead code.
    "/** @public */",
    "export type EventTypeName = (typeof eventTypeNames)[number];",
    "",
  );
  return lines.join("\n");
}

function renderSqlClause(names) {
  const values = names.map((name) => `'${name.replaceAll("'", "''")}'`).join(",");
  return `ALTER TABLE "events" ADD CONSTRAINT "events_event_type_check" CHECK ("events"."event_type" IN (${values}));`;
}

function main() {
  const args = new Set(argv.slice(2));
  const names = dumpEventNamesViaTsx();
  const expected = renderEventTypesTs(names);
  const current = (() => {
    try {
      return readFileSync(eventTypesFile, "utf8");
    } catch {
      return "";
    }
  })();

  if (args.has("--emit-sql")) {
    process.stdout.write(renderSqlClause(names));
    process.stdout.write("\n");
  }

  if (args.has("--check")) {
    if (current.trimEnd() !== expected.trimEnd()) {
      process.stderr.write("event type mirror drift detected. Regenerate with `corepack pnpm run codegen:events`.\n");
      exit(1);
    }
    return;
  }

  if (current.trimEnd() === expected.trimEnd()) {
    process.stdout.write("event type mirror up to date\n");
  } else {
    writeFileSync(eventTypesFile, expected);
    process.stdout.write(`updated ${eventTypesFile}\n`);
  }
}

main();
