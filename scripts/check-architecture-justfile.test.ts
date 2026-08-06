import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkNoInlineCommentInDependencies,
  checkSmokeRecipesReachable,
  describeSmokeCoverage,
  parseJustfileRecipes,
} from "./check-architecture-justfile.mjs";
import { runArchitectureChecks } from "./check-architecture.mjs";

// The justfile gates. `just` treats `#` as a comment to end of line even inside a
// recipe's dependency list, so a `#` pasted mid-list deletes every dependency after
// it and `just` reports success having never run them. That happened to `smoke:` and
// hid three real-Postgres RLS proofs from the merge-queue gate for weeks.
//
// These specs pin BOTH directions: the guard must be RED on the shapes that broke
// (the historical inline-`#` truncation, and a leaf simply dropped from the list) and
// GREEN on the shapes that are fine (a doc comment above the recipe, a leaf reached
// through another recipe's dependencies or invoked from its body).

const justfilePath = resolve(import.meta.dirname, "..", "justfile");
const realJustfile = readFileSync(justfilePath, "utf8");

function files(text: string) {
  return [{ file: "justfile", text }];
}

// Everything below is DERIVED from the justfile, never restated. A spec that
// carries its own copy of the recipe list drifts away from the file it guards —
// which is precisely how the defect survived. Nothing here names a smoke recipe.
const smokeLeaves: string[] = parseJustfileRecipes(realJustfile)
  .get("smoke")
  .dependencies.filter((name: string) => name.startsWith("smoke-"));

// Leaves the justfile ALSO invokes from another recipe's body (`just <recipe>`).
// Dropping their dependency edge does NOT make them unreachable, because they
// still run — so a non-detection is correct for exactly these, and only these.
// Derived from the file too, so the carve-out cannot quietly grow.
const bodyInvoked = new Set(
  [...realJustfile.matchAll(/^\s+.*\bjust\s+([A-Za-z0-9_][A-Za-z0-9_-]*)/gmu)].map((match) => match[1]),
);
const dropDetectable = smokeLeaves.filter((leaf) => !bodyInvoked.has(leaf));

// Drop one leaf from the real one-per-line `smoke:` list, the way a bad rebase would.
function withoutSmokeLeaf(text: string, leaf: string): string {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.trim() === `${leaf} \\` || line.trim() === leaf);
  expect([leaf, index > -1]).toEqual([leaf, true]);
  lines.splice(index, 1);
  return lines.join("\n");
}

// Re-collapse the real `smoke:` list onto ONE line with a comment pasted mid-list —
// the exact shape of the historical defect, rebuilt from today's content.
function collapsedWithInlineComment(text: string): { mutated: string; head: string[]; tail: string[] } {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith("smoke:"));
  let end = start;
  while (lines[end].trimEnd().endsWith("\\")) {
    end += 1;
  }
  const tokens = lines
    .slice(start, end + 1)
    .map((line) => line.trim().replace(/\\$/u, "").trim())
    .join(" ")
    .replace(/^smoke:\s*/u, "")
    .split(/\s+/u);
  const split = Math.floor(tokens.length / 2);
  const head = tokens.slice(0, split);
  const tail = tokens.slice(split);
  const collapsed = `smoke: ${head.join(" ")} # rv-24: a doc comment pasted mid-list ${tail.join(" ")}`;
  return { mutated: [...lines.slice(0, start), collapsed, ...lines.slice(end + 1)].join("\n"), head, tail };
}

describe("smoke-recipes-reachable", () => {
  it("derives a non-vacuous leaf set from the justfile (an empty sweep would pass silently)", () => {
    // Anti-vacuity: every mutation spec below loops over these. If the derivation
    // ever yields nothing, the loops pass trivially and the negative control is gone.
    expect(smokeLeaves.length).toBeGreaterThan(50);
    expect(dropDetectable.length).toBeGreaterThan(50);
  });

  it("is GREEN on the real justfile — every smoke-* recipe runs when `just smoke` runs", () => {
    expect(checkSmokeRecipesReachable(files(realJustfile))).toEqual([]);
  });

  it("goes RED when ANY single leaf is dropped from the real smoke dependency list", () => {
    // The whole deliverable: the guard must fail on the broken tree, for every leaf,
    // not just the one the author happened to pick. Collect misses so a failure names
    // exactly which leaves the guard would have let through.
    const undetected = dropDetectable.filter((leaf) => {
      const flagged = checkSmokeRecipesReachable(files(withoutSmokeLeaf(realJustfile, leaf)));
      return !flagged.some((item) => item.message.includes(`\`${leaf}\``));
    });
    expect(undetected).toEqual([]);
  });

  it("does NOT flag a dropped leaf that another recipe's body still invokes", () => {
    // The complement of the sweep above: these leaves keep running, so silence is the
    // right answer — and asserting it keeps the carve-out honest rather than assumed.
    for (const leaf of smokeLeaves.filter((name) => bodyInvoked.has(name))) {
      const flagged = checkSmokeRecipesReachable(files(withoutSmokeLeaf(realJustfile, leaf)));
      expect(flagged.some((item) => item.message.includes(`\`${leaf}\``))).toBe(false);
    }
  });

  it("reproduces the historical defect on the REAL list: an inline `#` truncates it", () => {
    const { mutated, head, tail } = collapsedWithInlineComment(realJustfile);
    const flaggedNames = checkSmokeRecipesReachable(files(mutated)).map(
      (item) => /`([^`]+)`/u.exec(item.message)?.[1] ?? "",
    );
    const swallowed = tail.filter((name) => name.startsWith("smoke-") && !bodyInvoked.has(name));
    expect(swallowed.length).toBeGreaterThan(20);
    // Every leaf after the `#` is reported...
    expect(flaggedNames).toEqual(expect.arrayContaining(swallowed));
    // ...and nothing that survived the comment is falsely reported.
    expect(flaggedNames.filter((name) => head.includes(name))).toEqual([]);
  });

  it("flags a swallowed leaf in the minimal synthetic case too", () => {
    const text = [
      "smoke: smoke-kept # a stray note smoke-swallowed",
      "  echo aggregate",
      "",
      "smoke-kept:",
      "  echo kept",
      "",
      "smoke-swallowed:",
      "  echo swallowed",
      "",
    ].join("\n");
    const flagged = checkSmokeRecipesReachable(files(text));
    expect(flagged.map((item) => item.message)).toEqual([expect.stringContaining("`smoke-swallowed`")]);
  });

  it("does NOT flag a leaf reached transitively through another recipe's dependencies", () => {
    const text = ["smoke: smoke-group", "", "smoke-group: smoke-leaf", "", "smoke-leaf:", "  echo leaf", ""].join("\n");
    expect(checkSmokeRecipesReachable(files(text))).toEqual([]);
  });

  it("does NOT flag a leaf invoked from a reachable recipe's BODY (`just <recipe>`)", () => {
    // `smoke-rls-remediation-attempts` runs `smoke-rls-repair-routing` this way; a
    // dependency-only walk would report a recipe that demonstrably runs.
    const text = [
      "smoke: smoke-wrapper",
      "",
      "smoke-wrapper:",
      "  just smoke-inner",
      "",
      "smoke-inner:",
      "  echo inner",
      "",
    ].join("\n");
    expect(checkSmokeRecipesReachable(files(text))).toEqual([]);
  });

  it("follows `&&` post-dependencies, which also run", () => {
    const text = [
      "smoke: smoke-first && smoke-after",
      "",
      "smoke-first:",
      "  echo a",
      "",
      "smoke-after:",
      "  echo b",
      "",
    ].join("\n");
    expect(checkSmokeRecipesReachable(files(text))).toEqual([]);
  });

  it("reports the missing aggregate rather than every smoke recipe at once", () => {
    const flagged = checkSmokeRecipesReachable(files("smoke-orphan:\n  echo orphan\n"));
    expect(flagged.map((item) => item.message)).toEqual([expect.stringContaining("aggregate recipe is missing")]);
  });

  it("stays silent on a justfile with no smoke-* recipes — nothing can be unreachable", () => {
    // A tree with no smoke coverage has none to lose. The absent cases are LOUD
    // (`just smoke` simply does not exist), not the silent-green failure this rule
    // is for — and inventing a diagnostic here flagged every synthetic fixture in
    // scripts/check-architecture.test.ts, which is how this was caught.
    expect(checkSmokeRecipesReachable(files("ci: lint\n\nlint:\n  echo lint\n"))).toEqual([]);
  });

  it("stays silent when there is no justfile at all", () => {
    expect(checkSmokeRecipesReachable([{ file: "package.json", text: "{}" }])).toEqual([]);
    expect(describeSmokeCoverage([{ file: "package.json", text: "{}" }])).toBeNull();
  });
});

describe("justfile-no-inline-comment-in-dependencies", () => {
  it("is GREEN on the real justfile", () => {
    expect(checkNoInlineCommentInDependencies(files(realJustfile))).toEqual([]);
  });

  it("flags an inline `#` in a dependency list, on the line it truncates", () => {
    const text = ["build: compile # and then link", "  echo build", "", "compile:", "  echo compile", ""].join("\n");
    const flagged = checkNoInlineCommentInDependencies(files(text));
    expect(flagged.map((item) => item.rule)).toEqual(["justfile-no-inline-comment-in-dependencies"]);
    expect(flagged[0]?.line).toBe(1);
    expect(flagged[0]?.message).toContain("`build`");
  });

  it("flags an inline `#` on a CONTINUATION line of a multi-line dependency list", () => {
    const text = ["build: \\", "  compile \\", "  link # trailing note", "  echo build", ""].join("\n");
    const flagged = checkNoInlineCommentInDependencies(files(text));
    expect(flagged.map((item) => item.line)).toEqual([3]);
  });

  it("does NOT flag a doc comment on its own line above the recipe", () => {
    const text = ["# what build does", "build: compile", "  echo build", ""].join("\n");
    expect(checkNoInlineCommentInDependencies(files(text))).toEqual([]);
  });

  it("does NOT flag a `#` inside a quoted parameter default (not a comment to `just`)", () => {
    const text = ['tag anchor="#top": compile', "  echo {{anchor}}", ""].join("\n");
    expect(checkNoInlineCommentInDependencies(files(text))).toEqual([]);
  });
});

// A check that can silently not-run is indistinguishable from one that ran and
// passed, so the gate states what it verified on the success path too.
describe("describeSmokeCoverage (name what was verified, not only what failed)", () => {
  it("reports full coverage of the real justfile, with a count that is not zero", () => {
    const line = describeSmokeCoverage(files(realJustfile));
    const [, covered, total] = /: (\d+)\/(\d+) /u.exec(line ?? "") ?? [];
    expect(Number(total)).toBeGreaterThan(50);
    expect(covered).toBe(total);
    expect(line).toContain("reachable from `just smoke`");
  });

  it("the number MOVES when a leaf stops being reachable", () => {
    const before = describeSmokeCoverage(files(realJustfile));
    const after = describeSmokeCoverage(files(withoutSmokeLeaf(realJustfile, dropDetectable[0] ?? "")));
    expect(after).not.toBe(before);
  });
});

describe("parseJustfileRecipes", () => {
  it("reads a backslash-continued dependency list as one recipe", () => {
    const recipes = parseJustfileRecipes("smoke: \\\n  a \\\n  b\n  echo run\n");
    expect(recipes.get("smoke")?.dependencies).toEqual(["a", "b"]);
  });

  // The guard models `just`'s parse. If the model drifts from the tool, the guard
  // is guessing — so pin them against each other on the real file. `just --dump`
  // is `just`'s own view of the recipe graph; ci-light installs `just`, and a
  // missing binary fails LOUDLY here rather than skipping (a silently-skipped
  // check is the exact defect class this file exists for).
  it("agrees with `just --dump` about the real justfile's recipes", () => {
    const dump = spawnSync("just", ["--dump", "--dump-format", "json"], {
      cwd: resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
    // `just` must be on PATH for this comparison; a spawn error surfaces as a
    // failure here rather than as a quietly skipped test.
    expect(dump.error).toBeUndefined();
    expect(`${dump.status} ${dump.stderr}`).toBe("0 ");
    const fromJust = Object.keys(JSON.parse(dump.stdout).recipes).toSorted();
    const fromParser = [...parseJustfileRecipes(realJustfile).keys()].toSorted();
    expect(fromJust.length).toBeGreaterThan(100);
    expect(fromParser).toEqual(fromJust);
  });

  it("does not mistake assignments, settings or aliases for recipes", () => {
    const recipes = parseJustfileRecipes(
      'set shell := ["bash", "-c"]\nexport TOKEN := env_var_or_default("TOKEN", "dev")\nalias b := build\nbuild:\n  echo build\n',
    );
    expect([...recipes.keys()]).toEqual(["build"]);
  });
});

// ENFORCEMENT wiring: both rules are part of `runArchitectureChecks` (the exit-1
// aggregator), so a swallowed smoke recipe FAILS CI rather than being reported.
describe("the justfile gates are CI-GATING (folded into the exit-1 set)", () => {
  const scriptPath = resolve(import.meta.dirname, "check-architecture.mjs");
  const broken = [
    "smoke: smoke-kept # note smoke-swallowed",
    "  echo aggregate",
    "",
    "smoke-kept:",
    "  echo kept",
    "",
    "smoke-swallowed:",
    "  echo swallowed",
    "",
  ].join("\n");

  it("runArchitectureChecks SURFACES a swallowed smoke recipe", async () => {
    const root = mkdtempSync(join(tmpdir(), "arch-justfile-enforce-"));
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "justfile"), broken);
      const diagnostics = await runArchitectureChecks({ root });
      expect(diagnostics.some((item) => item.rule === "smoke-recipes-reachable")).toBe(true);
      expect(diagnostics.some((item) => item.rule === "justfile-no-inline-comment-in-dependencies")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the CLI EXITS NON-ZERO on a swallowed smoke recipe", () => {
    const root = mkdtempSync(join(tmpdir(), "arch-justfile-cli-"));
    try {
      writeFileSync(join(root, "justfile"), broken);
      const run = spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: "utf8" });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("smoke-recipes-reachable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
