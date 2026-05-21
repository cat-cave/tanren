import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { argv, exit } from "node:process";
import { glob } from "node:fs/promises";

const ignored = new Set(["node_modules", "dist", "coverage", ".git"]);
const patterns = ["**/*.{ts,tsx,js,mjs,json,md,yml,yaml,sql,sh,Dockerfile}", "Dockerfile", "**/Dockerfile"];
const files = new Set();

for (const pattern of patterns) {
  for await (const entry of glob(pattern, { exclude: (name) => ignored.has(name) })) {
    files.add(entry);
  }
}

let failed = false;
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
