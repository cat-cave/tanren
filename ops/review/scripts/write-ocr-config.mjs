#!/usr/bin/env node
// =============================================================================
// write-ocr-config.mjs <template> <dest>
// -----------------------------------------------------------------------------
// Inject the OCR_LLM_TOKEN secret into the trusted config TEMPLATE's
// custom_providers.<provider>.api_key and write the result to <dest>
// (~/.opencodereview/config.json). `ocr review` reads ONLY that default path —
// it ignores OCR_CONFIG_PATH and, once a complete config is present, ignores the
// env-var auth strategy too (verified against OCR v1.8.1) — so the reasoning /
// provider options only take effect when written here as a COMPLETE config.
//
// NO-OP (exit 0, leaving the env-auth fail-closed path intact) when the key is
// empty (a fork PR gets no secret → env token empty → OCR fails closed) or the
// template is missing (bootstrap: the very PR that adds the template reviews
// against a base that lacks it). Reasoning is an enhancement, never a hard
// requirement — a missing config degrades to a keyless/no-reasoning run, it does
// not break the review.
// =============================================================================

import fs from "node:fs";
import path from "node:path";

const [tmpl, dest] = process.argv.slice(2);
const key = process.env.OCR_LLM_TOKEN || "";

function main() {
  if (!tmpl || !dest) {
    process.stderr.write("usage: write-ocr-config.mjs <template> <dest>\n");
    process.exit(2);
  }
  if (!key) {
    console.log("write-ocr-config: no OCR_LLM_TOKEN (fork/unauth) — skip; env auth fails closed");
    return;
  }
  if (!fs.existsSync(tmpl)) {
    console.log(`write-ocr-config: template ${tmpl} absent (bootstrap) — skip; env auth, no reasoning`);
    return;
  }
  const cfg = JSON.parse(fs.readFileSync(tmpl, "utf8"));
  const providers = cfg.custom_providers && typeof cfg.custom_providers === "object" ? cfg.custom_providers : {};
  const names = Object.keys(providers);
  if (names.length === 0) {
    console.log("write-ocr-config: template has no custom_providers — skip");
    return;
  }
  // Inject the key into every declared provider (normally just one: openrouter).
  for (const name of names) providers[name] = { ...providers[name], api_key: key };
  cfg.custom_providers = providers;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Remove any pre-existing file first: writeFileSync's `mode` only applies on
  // CREATION, so an existing config with broader perms would keep them and leave
  // the injected token world-readable. rm + create + explicit chmod = 0600 always.
  fs.rmSync(dest, { force: true });
  fs.writeFileSync(dest, JSON.stringify(cfg), { mode: 0o600 });
  fs.chmodSync(dest, 0o600);
  console.log(`write-ocr-config: wrote ${dest} (reasoning config, key injected into: ${names.join(",")})`);
}

main();
