// Formatting gate (Track B wave 5). Two layers:
//   1. oxfmt (`oxfmt --check`) owns all the file types it understands
//      (ts/tsx/js/mjs/json/md/yml/yaml) — config in .oxfmtrc.json. oxfmt is the
//      oxc formatter (same VoidZero stack as oxlint); it replaced Prettier with
//      byte-identical output on this codebase.
//   2. The custom whitespace/newline scan below covers the file types oxfmt does
//      NOT format (shell scripts, Dockerfiles, SQL), so trailing whitespace +
//      missing final newlines are still caught there.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { argv, exit } from "node:process";
import { glob } from "node:fs/promises";

const ignored = new Set(["node_modules", "dist", "coverage", ".git"]);
// File types oxfmt does not handle — keep the bespoke whitespace scan for
// these so the gate still rejects trailing whitespace / missing final newlines.
const patterns = ["**/*.{sql,sh}", "Dockerfile", "**/Dockerfile"];
const files = new Set();

for (const pattern of patterns) {
  for await (const entry of glob(pattern, { exclude: (name) => ignored.has(name) })) {
    files.add(entry);
  }
}

let failed = false;

// Layer 1: oxfmt owns the formats it understands.
const oxfmt = spawnSync("node_modules/.bin/oxfmt", ["--check", "**/*.{ts,tsx,js,mjs,json,md,yml,yaml}"], {
  stdio: "inherit",
});
if (oxfmt.status !== 0) {
  failed = true;
}

// Layer 2: bespoke whitespace/newline scan for the non-Prettier formats.
for (const file of [...files].toSorted()) {
  const text = await readFile(file, "utf8");
  const lines = text.split("\n");

  if (!text.endsWith("\n")) {
    console.error(`${relative(".", file)}: missing trailing newline`);
    failed = true;
  }

  for (const [index, line] of lines.entries()) {
    if (/[ \t]$/u.test(line)) {
      console.error(`${relative(".", file)}:${index + 1}: trailing whitespace`);
      failed = true;
    }
  }
}

if (argv.includes("--quiet") && failed) {
  exit(1);
}

exit(failed ? 1 : 0);
