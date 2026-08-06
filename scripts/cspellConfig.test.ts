import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const configPath = join(root, "cspell.json");
const cspellPath = join(root, "node_modules", "cspell", "bin.mjs");
const builtInDictionaries = ["typescript", "node", "npm", "html", "css", "softwareTerms", "bash", "filetypes"];

function runCspell(filePath: string) {
  return spawnSync(process.execPath, [cspellPath, "--no-progress", "--config", configPath, filePath], {
    cwd: root,
    encoding: "utf8",
  });
}

describe("cspell project dictionary configuration", () => {
  it("keeps every built-in dictionary alongside the Tanren dictionary", () => {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      dictionaries?: string[];
      dictionaryDefinitions?: Array<{ name: string; path: string }>;
    };

    expect(config.dictionaries).toEqual([...builtInDictionaries, "tanren"]);
    expect(config.dictionaryDefinitions).toEqual([{ name: "tanren", path: "./cspell-words.txt" }]);
    expect(readFileSync(join(root, "cspell-words.txt"), "utf8")).toContain("\ntanren\n");
  });

  it("accepts built-in vocabulary and rejects an unknown token", () => {
    const fixtureDirectory = mkdtempSync(join(root, ".tmp-cspell-"));
    const acceptedPath = join(fixtureDirectory, "accepted.md");
    const rejectedPath = join(fixtureDirectory, "rejected.md");

    try {
      writeFileSync(
        acceptedPath,
        [
          "tsconfig tsserver tsx",
          "node_modules nodejs unref",
          "npmrc pnpx semver",
          "aria blockquote fieldset textarea",
          "flexbox rgba subgrid webkit",
          "localhost NDJSON OAuth",
          "builtin coproc shopt",
          "jsonc mdx toml yaml",
          "",
        ].join("\n"),
      );
      writeFileSync(rejectedPath, "zzqvnbxkq\n");

      const accepted = runCspell(acceptedPath);
      expect(accepted.status).toBe(0);

      const rejected = runCspell(rejectedPath);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stdout + rejected.stderr).toContain("zzqvnbxkq");
    } finally {
      rmSync(fixtureDirectory, { recursive: true, force: true });
    }
  });
});
