#!/usr/bin/env node
// ---------------------------------------------------------------------------
// select-model.mjs — model ROUTING for the OCR review layer
//
// OCR OSS has no per-task model tiering / --provider flag (DESIGN §"Not
// available"), so routing is a WRAPPER decision made here from the changed
// paths + the preflight result, driven by ops/review/model-routing.json.
//
// Tiers (highest precedence first):
//   1. high_stakes — ANY changed path matches high_stakes.path_globs (merge
//      engine, *Authority*, migrations, orgScope, *runStateAtomic*, *Coordinator*).
//      Uses high_stakes.models; appends ensemble_candidate ONLY when
//      ensemble_enabled=true (cross-confirmation hedge). An oversized diff is
//      treated as high-stakes too (a lot changed -> hedge toward care).
//   2. cheap — EVERY changed path matches cheap.path_globs (docs / test-only).
//      Uses the cheapest capable model.
//   3. default — everything else -> config.default.
//
// Deps: node built-ins only. Config resolved relative to this file (run-from-
// anywhere), so it works from the git root (#287).
//
// Usage:
//   node select-model.mjs --preflight <preflight.json>
//   node select-model.mjs --paths "a.ts,b.md"
//   PATHS="a.ts b.md" node select-model.mjs
//   node select-model.mjs --help
//   node select-model.mjs --selftest
// Env: MODEL_ROUTING (config path override), GITHUB_OUTPUT
// ---------------------------------------------------------------------------

import { readFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";

const HERE = import.meta.dirname;
const DEFAULT_CONFIG = resolve(HERE, "..", "model-routing.json");

// ---- glob matcher (shares semantics with preflight.mjs) ---------------------
function expandBraces(glob) {
  const m = glob.match(/\{([^{}]*)\}/u);
  if (!m) return [glob];
  const out = [];
  for (const alt of m[1].split(",")) {
    out.push(...expandBraces(glob.slice(0, m.index) + alt + glob.slice(m.index + m[0].length)));
  }
  return out;
}
function globPartToRegex(glob) {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp(out + "$", "u");
}
function compileGlobs(globs) {
  return (globs || []).flatMap((g) => expandBraces(g)).map((g) => globPartToRegex(g));
}
function anyMatch(res, paths) {
  return paths.some((p) => res.some((re) => re.test(p)));
}
function allMatch(res, paths) {
  return paths.length > 0 && paths.every((p) => res.some((re) => re.test(p)));
}

// ---- pure routing core ------------------------------------------------------
function selectModel(config, paths, opts = {}) {
  const oversized = !!opts.oversized;
  const high = config.tiers?.high_stakes || {};
  const cheap = config.tiers?.cheap || {};
  const highRes = compileGlobs(high.path_globs);
  const cheapRes = compileGlobs(cheap.path_globs);

  const hitsHigh = anyMatch(highRes, paths);
  if (hitsHigh || oversized) {
    const models = [...(high.models || [config.default])];
    let reason = hitsHigh
      ? `high_stakes: changed path matches ${high.path_globs?.length || 0} fail-open-prone glob(s)`
      : "high_stakes: oversized diff — hedge toward care";
    if (high.ensemble_enabled && high.ensemble_candidate && !models.includes(high.ensemble_candidate)) {
      models.push(high.ensemble_candidate);
      reason += `; ensemble enabled -> cross-confirm with ${high.ensemble_candidate}`;
    } else if (high.ensemble_candidate) {
      reason += `; ensemble candidate ${high.ensemble_candidate} available but disabled`;
    }
    return { tier: "high_stakes", models, reason, provider: config.provider };
  }

  if (allMatch(cheapRes, paths)) {
    return {
      tier: "cheap",
      models: [...(cheap.models || [config.default])],
      reason: "cheap: every changed path is docs/test-only",
      provider: config.provider,
    };
  }

  return {
    tier: "default",
    models: [config.default],
    reason:
      paths.length > 0 ? "default: mixed product changes, no high-stakes path" : "default: no changed paths provided",
    provider: config.provider,
  };
}

// ---- io / cli ---------------------------------------------------------------
function loadConfig(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}
function pathsFromPreflight(pf) {
  if (Array.isArray(pf?.reviewable_files)) return { paths: pf.reviewable_files, oversized: !!pf.oversized };
  if (Array.isArray(pf)) return { paths: pf, oversized: false };
  return { paths: [], oversized: false };
}
function setOutput(key, val) {
  const f = process.env.GITHUB_OUTPUT;
  if (!f) return;
  const s = typeof val === "string" ? val : JSON.stringify(val);
  if (s.includes("\n")) appendFileSync(f, `${key}<<__GH_EOF__\n${s}\n__GH_EOF__\n`);
  else appendFileSync(f, `${key}=${s}\n`);
}
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--selftest") a.selftest = true;
    else if (t === "--preflight") a.preflight = argv[++i];
    else if (t === "--paths") a.paths = argv[++i];
    // --routing: workflow alias
    else if (t === "--config" || t === "--routing") a.config = argv[++i];
    else if (t === "--oversized") a.oversized = true;
  }
  return a;
}
const HELP = `select-model.mjs — route the OCR review to model(s) (config: model-routing.json)

  node select-model.mjs --preflight <preflight.json>
  node select-model.mjs --paths "svc/engine/merge/land.ts,README.md"

In: preflight result (reads .reviewable_files + .oversized) OR a --paths list.
Out: {tier, models:[...], reason, provider} to stdout + GITHUB_OUTPUT.
Precedence: high_stakes (any hot path / oversized) > cheap (all docs+test) > default.
The ensemble candidate is appended ONLY when ensemble_enabled=true in the config.

  --config <p> override config path (default ../model-routing.json, or MODEL_ROUTING)
  --selftest   run in-memory fixture assertions and exit
  --help       this text`;

function assert(c, m) {
  if (!c) throw new Error("SELFTEST FAIL: " + m);
}

function selftest() {
  // exercise the REAL shipped config
  const base = loadConfig(DEFAULT_CONFIG);

  // high-stakes path
  let r = selectModel(base, ["services/orchestrator/src/engine/merge/land.ts"]);
  assert(r.tier === "high_stakes", "merge path -> high_stakes, got " + r.tier);
  // Config-aware: ensemble appends the candidate on high-stakes ONLY when enabled.
  const hs = base.tiers.high_stakes;
  const expectEnsemble = hs.ensemble_enabled && hs.ensemble_candidate;
  assert(
    r.models.length === (expectEnsemble ? 2 : 1),
    `high_stakes model count ${expectEnsemble ? "with ensemble -> 2" : "-> 1"}, got ${r.models.length}`,
  );
  if (expectEnsemble) assert(r.models.includes(hs.ensemble_candidate), "ensemble enabled -> candidate present");

  // *Authority* and orgScope and Coordinator globs
  assert(
    selectModel(base, ["services/orchestrator/src/engine/MergeAuthority.ts"]).tier === "high_stakes",
    "*Authority* hot",
  );
  assert(selectModel(base, ["db/src/orgScope.ts"]).tier === "high_stakes", "orgScope hot");
  assert(selectModel(base, ["services/x/BaseShiftCoordinator.ts"]).tier === "high_stakes", "*Coordinator* hot");
  assert(selectModel(base, ["db/migrations/0112_x.sql"]).tier === "high_stakes", "migrations hot");

  // cheap: docs + test only
  r = selectModel(base, ["README.md", "docs/x.md", "services/x/a.test.ts"]);
  assert(r.tier === "cheap", "all docs/test -> cheap, got " + r.tier);

  // default: mixed product code
  r = selectModel(base, ["services/x/src/util.ts", "README.md"]);
  assert(r.tier === "default", "mixed -> default, got " + r.tier);

  // oversized forces high_stakes even on plain paths
  r = selectModel(base, ["services/x/src/util.ts"], { oversized: true });
  assert(r.tier === "high_stakes", "oversized -> high_stakes, got " + r.tier);

  // ensemble ON: candidate appended
  const ensembleCfg = JSON.parse(JSON.stringify(base));
  ensembleCfg.tiers.high_stakes.ensemble_enabled = true;
  r = selectModel(ensembleCfg, ["db/migrations/0001.sql"]);
  assert(
    r.models.length === 2 && r.models.includes(ensembleCfg.tiers.high_stakes.ensemble_candidate),
    "ensemble appends candidate: " + JSON.stringify(r.models),
  );

  console.log("select-model.mjs selftest: OK");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.selftest) {
    selftest();
    return;
  }
  const configPath = args.config || process.env.MODEL_ROUTING || DEFAULT_CONFIG;
  const config = loadConfig(configPath);

  let paths = [];
  let oversized = !!args.oversized;
  if (args.preflight) {
    const pf = JSON.parse(readFileSync(args.preflight, "utf8"));
    const derived = pathsFromPreflight(pf);
    paths = derived.paths;
    oversized = oversized || derived.oversized;
  } else {
    const raw = args.paths || process.env.PATHS || "";
    paths = raw
      .split(/[\s,]+/u)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const result = selectModel(config, paths, { oversized });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  setOutput("models", JSON.stringify(result.models));
  setOutput("tier", result.tier);
  setOutput("reason", result.reason);
}

main();
