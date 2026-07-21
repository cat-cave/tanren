#!/usr/bin/env node
// in-20 — the READ-COMPAT guard for the integration HTTP read surface. Pins the
// exposed response shape against a committed compatibility FLOOR
// (contracts/integration-read-compat/v1.json) so a downstream consumer (the
// in-21 Integration Control Center UI, external readers) can never be silently
// broken.
//
// Mirrors `scripts/rv-read-compat.mjs` (rv-22) shape-for-shape. Unlike the
// byte-drift guard (`contract-schema-drift`), which fails on ANY change, this
// guard is SEMANTIC: it classifies the current shape against the floor and
// fails ONLY on a backward-INCOMPATIBLE change (a removed / renamed / retyped
// field, a removed enum member, a weakened required guarantee, a dropped
// schema). A backward-COMPATIBLE additive change (a new field / enum member /
// schema) leaves the floor intact and PASSES — additive growth above the floor
// is allowed without regenerating.
//
// Usage:
//   node scripts/integration-read-compat.mjs           # raise the floor to the current shape
//   node scripts/integration-read-compat.mjs --check    # exit 1 on an incompatible change
//
// Source of truth (current shape): services/orchestrator/src/routes/integrations/contract.ts
// Committed floor: contracts/integration-read-compat/v1.json
// Classifier: services/orchestrator/src/engine/verification/readCompat/classifyReadCompat.ts
// (the SAME pure classifier rv-read-compat uses — shared infra.)

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { argv, exit } from "node:process";

const repoRoot = resolve(import.meta.dirname, "..");
const contractEntry = resolve(repoRoot, "services/orchestrator/src/routes/integrations/contract.ts");
const baselinePath = resolve(repoRoot, "contracts/integration-read-compat/v1.json");

const dumper = `
import { renderIntegrationReadSchemas } from ${JSON.stringify(contractEntry)};
process.stdout.write(JSON.stringify(renderIntegrationReadSchemas()));
`;

function renderCurrentSchemas() {
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

// Recursively sort object keys so the committed floor is byte-stable regardless
// of the order Zod's generator emits properties. Identical to the rv-read-compat
// helper — kept duplicated (not shared) so each guard remains standalone.
function sortKeys(value) {
  if (Array.isArray(value)) return value.map((item) => sortKeys(item));
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

function renderJson(schemas) {
  return `${JSON.stringify(sortKeys(schemas), null, 2)}\n`;
}

function readBaseline() {
  try {
    return JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch {
    /* no committed baseline yet — treated as first-run */
  }
}

// The classifier is TS; run it via a tsx eval that reads both maps from env
// vars. Identical shape to rv-read-compat's `classify` — re-uses the SAME
// classifier (shared infra: classifyReadCompat.ts).
function classify(baseline, current) {
  const classifierEntry = resolve(
    repoRoot,
    "services/orchestrator/src/engine/verification/readCompat/classifyReadCompat.ts",
  );
  const program = `
  import { classifyReadCompat } from ${JSON.stringify(classifierEntry)};
  const baseline = JSON.parse(process.env.INTEGRATION_READ_COMPAT_BASELINE);
  const current = JSON.parse(process.env.INTEGRATION_READ_COMPAT_CURRENT);
  process.stdout.write(JSON.stringify(classifyReadCompat(baseline, current)));
  `;
  const result = spawnSync("corepack", ["pnpm", "exec", "tsx", "--eval", program], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      INTEGRATION_READ_COMPAT_BASELINE: JSON.stringify(baseline),
      INTEGRATION_READ_COMPAT_CURRENT: JSON.stringify(current),
    },
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "classifier eval failed\n");
    exit(1);
  }
  return JSON.parse(result.stdout);
}

function main() {
  const args = new Set(argv.slice(2));
  const check = args.has("--check");
  const current = renderCurrentSchemas();
  const baseline = readBaseline();

  if (baseline === undefined) {
    if (check) {
      process.stderr.write(
        `integration read-compat floor missing at contracts/integration-read-compat/v1.json.\n` +
          "Generate it with `corepack pnpm run codegen:integration-read-compat`.\n",
      );
      exit(1);
    }
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, renderJson(current));
    process.stdout.write(`wrote initial integration read-compat floor: contracts/integration-read-compat/v1.json\n`);
    return;
  }

  const verdict = classify(baseline, current);

  if (check) {
    if (!verdict.compatible) {
      process.stderr.write("integration read-compat FAILED — the read surface changed backward-INCOMPATIBLY:\n");
      for (const change of verdict.breaking) {
        process.stderr.write(`  [${change.kind}] ${change.schema} ${change.path}: ${change.detail}\n`);
      }
      process.stderr.write(
        "\nA read consumer (in-21 Control Center UI / external readers) would break. Either revert the\n" +
          "change, or — if intentional — bump INTEGRATION_READ_SURFACE_VERSION and regenerate the floor with\n" +
          "`corepack pnpm run codegen:integration-read-compat` (the diff makes the floor change reviewable).\n",
      );
      exit(1);
    }
    process.stdout.write(
      `integration read-compat OK (${Object.keys(current).length} schemas; ${verdict.additive.length} additive change(s) above the floor).\n`,
    );
    return;
  }

  // Regenerate mode: raise the floor to the current shape (an intentional, reviewable act).
  if (!verdict.compatible) {
    process.stdout.write("note: lowering the integration read-compat floor (a backward-incompatible change) —\n");
    for (const change of verdict.breaking) {
      process.stdout.write(`  [${change.kind}] ${change.schema} ${change.path}: ${change.detail}\n`);
    }
    process.stdout.write("consider bumping INTEGRATION_READ_SURFACE_VERSION.\n");
  }
  writeFileSync(baselinePath, renderJson(current));
  process.stdout.write(`updated integration read-compat floor: contracts/integration-read-compat/v1.json\n`);
}

main();
