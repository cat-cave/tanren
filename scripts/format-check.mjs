// Formatting gate (Track B wave 5). Two layers:
//   1. Prettier (`prettier --check`) owns all the file types it understands
//      (ts/tsx/js/mjs/json/md/yml/yaml) — see .prettierrc / .prettierignore.
//   2. The custom whitespace/newline scan below covers the file types Prettier
//      does NOT format (shell scripts, Dockerfiles, SQL), so trailing
//      whitespace + missing final newlines are still caught there.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { argv, exit } from "node:process";
import { glob } from "node:fs/promises";

const ignored = new Set(["node_modules", "dist", "coverage", ".git"]);
// File types Prettier does not handle — keep the bespoke whitespace scan for
// these so the gate still rejects trailing whitespace / missing final newlines.
const patterns = ["**/*.{sql,sh}", "Dockerfile", "**/Dockerfile"];
const files = new Set();

for (const pattern of patterns) {
  for await (const entry of glob(pattern, { exclude: (name) => ignored.has(name) })) {
    files.add(entry);
  }
}

let failed = false;

// Layer 1: Prettier owns the formats it understands.
const prettier = spawnSync(
  "node",
  ["node_modules/prettier/bin/prettier.cjs", "--check", "**/*.{ts,tsx,js,mjs,json,md,yml,yaml}"],
  { stdio: "inherit" },
);
if (prettier.status !== 0) {
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

  lines.forEach((line, index) => {
    if (/[ \t]$/.test(line)) {
      console.error(`${relative(".", file)}:${index + 1}: trailing whitespace`);
      failed = true;
    }
  });
}

if (argv.includes("--quiet") && failed) {
  exit(1);
}

exit(failed ? 1 : 0);
