#!/usr/bin/env -S node
// Read a dotenv file and print the value of a single key (no `export` wrapping).
// Handles values bash `source` can't parse cleanly: unquoted commas (e.g. a Fly
// token pair), unquoted slashes, etc. The recipe consumes the output via
// command substitution: `KEY="$(node scripts/dev/dotenv-extract.mjs FILE KEY)"`.
//
// Missing file → exit 0 with empty stdout (caller treats as "key unset").
// Missing key → exit 0 with empty stdout (same).
// Bad args → exit 2 (real usage error).
//
// Multiline values are NOT supported. If a value contains a literal newline,
// quote it on a single line. This matches Tanren's .env files (single-line
// values throughout).
//
// Comments (`#`) and blank lines are skipped. A leading/trailing `"`-pair on a
// value is stripped (`KEY="foo bar"` → `foo bar`); other forms are returned
// verbatim. Single quotes are NOT stripped — they're rare in tokens and would
// break round-trip if the user actually intended them.

import { readFileSync } from "node:fs";

const [, , file, key] = process.argv;
if (!file || !key) {
  process.stderr.write("usage: dotenv-extract.mjs <file> <key>\n");
  process.exit(2);
}

let content;
try {
  content = readFileSync(file, "utf-8");
} catch {
  process.exit(0);
}

for (const rawLine of content.split("\n")) {
  const trimmed = rawLine.trim();
  if (trimmed === "" || trimmed.startsWith("#")) continue;
  const eq = rawLine.indexOf("=");
  if (eq < 0) continue;
  const k = rawLine.slice(0, eq).trim();
  if (k !== key) continue;
  let v = rawLine.slice(eq + 1);
  if (v.length >= 2 && v.startsWith(`"`) && v.endsWith(`"`)) {
    v = v.slice(1, -1);
  }
  process.stdout.write(v);
  break;
}
