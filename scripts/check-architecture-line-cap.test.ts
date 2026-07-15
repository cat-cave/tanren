import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkLineMax, readProjectFiles } from "./check-architecture-line-cap.mjs";

// Minimal temp-tree helper for collector-level line-cap fixtures. (The richer
// `createFixture` in check-architecture.test.ts adds the required architecture
// docs the orchestrator checks need; the line-cap collector only needs files on
// disk that the glob can reach, so this stays lean.)
async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tanren-line-cap-"));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), text);
  }
  return root;
}

describe("file-line-max-500: CSS + mission-complete", () => {
  it("flags over-500 CSS and passes a small CSS file", () => {
    expect(checkLineMax([{ file: "big.css", text: ".a{color:red}\n".repeat(501) }]).map((d) => d.rule)).toContain(
      "file-line-max-500",
    );
    expect(checkLineMax([{ file: "small.css", text: ".a{color:red}\n" }])).toEqual([]);
  });
  it("scans runnable modules under docs/roadmap/mission-complete (no blanket exemption)", () => {
    const file = "docs/roadmap/mission-complete/foo.ts";
    expect(checkLineMax([{ file, text: "x\n".repeat(501) }]).map((d) => d.rule)).toContain("file-line-max-500");
  });
  it("does not blanket-exempt unrelated mission-complete docs", () => {
    const file = "docs/roadmap/mission-complete/other.md";
    expect(checkLineMax([{ file, text: "x\n".repeat(501) }]).map((d) => d.rule)).toContain("file-line-max-500");
  });
  it("keeps the named narrative node specs exempt", () => {
    const file = "docs/roadmap/mission-complete/nodes/runtime.md";
    expect(checkLineMax([{ file, text: "x\n".repeat(600) }])).toEqual([]);
  });
});

describe("file-line-max-500: collector finds html/jsx/txt + split passes", () => {
  // Hostile temp-tree tests at the COLLECTOR level (not direct checkLineMax):
  // prove the canonical collector opts html/jsx/txt INTO the cap, that an
  // over-500 file of each newly-tracked type is found AND flagged, and that the
  // same total content split into under-500 modules passes.
  it("collects and flags over-500 css, html, jsx, and txt via readProjectFiles", async () => {
    const root = await makeTree({
      "big.css": "x\n".repeat(501),
      "big.html": "x\n".repeat(501),
      "big.jsx": "x\n".repeat(501),
      "big.txt": "x\n".repeat(501),
    });
    const files = await readProjectFiles(root);
    const collected = new Set(files.map((f) => f.file));
    // The collector must reach every newly-tracked extension at the tree root.
    for (const name of ["big.css", "big.html", "big.jsx", "big.txt"]) {
      expect(collected).toContain(name);
    }
    const flagged = new Set(checkLineMax(files).map((d) => d.file));
    for (const name of ["big.css", "big.html", "big.jsx", "big.txt"]) {
      expect(flagged).toContain(name);
    }
  });

  it("passes a split set: same total content split into under-500 modules", async () => {
    // 600 lines of each type — over the cap as one file, under when split.
    const root = await makeTree({
      "a.css": "x\n".repeat(300),
      "b.css": "x\n".repeat(300),
      "a.html": "x\n".repeat(300),
      "b.html": "x\n".repeat(300),
      "a.jsx": "x\n".repeat(300),
      "b.jsx": "x\n".repeat(300),
      "a.txt": "x\n".repeat(300),
      "b.txt": "x\n".repeat(300),
    });
    const files = await readProjectFiles(root);
    expect(checkLineMax(files)).toEqual([]);
  });
});
