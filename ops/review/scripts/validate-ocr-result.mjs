#!/usr/bin/env node
// =============================================================================
// validate-ocr-result.mjs — certify OCR produced a WELL-FORMED result.
// -----------------------------------------------------------------------------
// Exit 0 iff argv[2] parses to a non-null object (not an array) whose findings
// live in an array `comments`. A crash, a missing LLM key (fork PRs get none), a
// partial/garbled stream, or a merely-valid-JSON body (`{}`, `null`, `[]`,
// `{comments:"x"}`) exits 1 → the untrusted workflow records review_complete=false
// → verdict.mjs FAILS CLOSED. A clean review still emits `comments: []`, so an
// empty result is NOT over-rejected. See DESIGN §SECURITY.6.
// =============================================================================

import fs from "node:fs";

export function isWellFormedOcrResult(o) {
  return Boolean(o) && typeof o === "object" && !Array.isArray(o) && Array.isArray(o.comments);
}

function main() {
  const p = process.argv[2];
  if (!p) {
    process.stderr.write("usage: validate-ocr-result.mjs <ocr-raw.json>\n");
    process.exit(2);
  }
  let o;
  try {
    o = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    process.exit(1);
  }
  process.exit(isWellFormedOcrResult(o) ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
