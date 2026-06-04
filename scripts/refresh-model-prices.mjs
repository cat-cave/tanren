#!/usr/bin/env node
// refresh-model-prices — re-fetch LiteLLM's `model_prices_and_context_window.json`
// (the same maintained per-model price source ccusage consumes) and vendor it at
// services/orchestrator/src/engine/costs/pricing/model_prices.json.
//
// WHY VENDOR. Tanren prices ANY computed figure — a notional/equivalent cost or a
// forward spec/DAG estimate — from a REAL, MAINTAINED rate source, NEVER a
// hardcoded table. A model missing from the source resolves to a LOUD `unknown`
// (NULL), never a guess. We commit a snapshot so a build/test never needs network;
// this recipe keeps the snapshot current.
//
// SCHEDULE. Run this on the scheduled-CI lane so the snapshot does not drift from
// upstream (it changes as providers add/adjust models). This PR only adds the
// recipe + a manual `just refresh-model-prices`; wiring the schedule into CI is a
// follow-up (do NOT add a cron trigger here).
//
// Usage:
//   node scripts/refresh-model-prices.mjs            # fetch + write the snapshot
//   node scripts/refresh-model-prices.mjs --check     # exit 1 if the snapshot would change

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { argv, exit } from "node:process";

export const SOURCE_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export const VENDORED_PATH = "services/orchestrator/src/engine/costs/pricing/model_prices.json";

// The manifest header keys we PREPEND to the vendored snapshot so the file is
// self-describing (source URL + the refresh recipe + the fetch date). LiteLLM's
// own file uses `sample_spec` as a documentation key; ours uses `_tanren_source`
// (the leading underscore + the modelPriceSource loader's non-model-key skip keep
// it out of the model table).
const MANIFEST_KEY = "_tanren_source";

const repoRoot = resolve(import.meta.dirname, "..");
const vendoredAbsPath = resolve(repoRoot, VENDORED_PATH);

// buildVendoredDocument is the PURE transform: take the raw upstream JSON text and
// the fetch date, return the pretty-printed snapshot text we vendor (manifest
// header prepended). Pure + exported so it is unit-testable without the network.
export function buildVendoredDocument(rawUpstreamText, fetchedAtIso) {
  const upstream = JSON.parse(rawUpstreamText);
  if (typeof upstream !== "object" || upstream === null || Array.isArray(upstream)) {
    throw new Error("refresh-model-prices: upstream JSON is not an object map of models");
  }
  // The manifest rides as the FIRST key so the provenance is visible at the top of
  // the file. The loader skips any key starting with `_` (and `sample_spec`), so
  // this never resolves as a model.
  const manifest = {
    [MANIFEST_KEY]: {
      description:
        "Vendored snapshot of LiteLLM's model_prices_and_context_window.json — the maintained per-model rate source. Do not hand-edit; refresh via `just refresh-model-prices`.",
      source_url: SOURCE_URL,
      fetched_at: fetchedAtIso,
      refresh_command: "just refresh-model-prices",
    },
  };
  return `${JSON.stringify({ ...manifest, ...upstream }, null, 2)}\n`;
}

async function fetchUpstream() {
  const response = await fetch(SOURCE_URL);
  if (!response.ok) {
    throw new Error(`refresh-model-prices: fetch failed (status ${response.status}) for ${SOURCE_URL}`);
  }
  return await response.text();
}

function readVendored() {
  try {
    return readFileSync(vendoredAbsPath, "utf8");
  } catch {
    return null;
  }
}

async function main() {
  const checkOnly = argv.includes("--check");
  const rawUpstreamText = await fetchUpstream();
  // --check must be deterministic against the committed snapshot, so reuse the
  // committed manifest's fetched_at rather than `now` (otherwise the date alone
  // would always drift). A normal refresh stamps the current date.
  const existing = readVendored();
  const fetchedAtIso = checkOnly ? (existingFetchedAt(existing) ?? new Date().toISOString()) : new Date().toISOString();
  const next = buildVendoredDocument(rawUpstreamText, fetchedAtIso);
  if (checkOnly) {
    if (existing !== next) {
      console.error(
        `refresh-model-prices: ${VENDORED_PATH} is stale vs upstream — run \`just refresh-model-prices\` and commit.`,
      );
      exit(1);
    }
    console.log(`refresh-model-prices: ${VENDORED_PATH} is up to date.`);
    return;
  }
  writeFileSync(vendoredAbsPath, next);
  console.log(`refresh-model-prices: wrote ${VENDORED_PATH} (source ${SOURCE_URL}, fetched ${fetchedAtIso}).`);
}

// Pull the prior fetched_at out of the committed snapshot so --check ignores the
// date field (only real rate/model changes should trip drift).
export function existingFetchedAt(existingText) {
  if (existingText === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(existingText);
    const manifest = parsed?.[MANIFEST_KEY];
    return typeof manifest?.fetched_at === "string" ? manifest.fetched_at : null;
  } catch {
    return null;
  }
}

// Only run when invoked directly (not when imported by the unit test).
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
