// §5 grep-guard: the wrong fallback runner image (`ghcr.io/tanren/runner`) must
// NEVER reappear in the orchestrator's SOURCE. The canonical image is
// `ghcr.io/cat-cave/tanren-runner:v0`, sourced from the ONE shared constant
// `CANONICAL_RUNNER_IMAGE` (engine/config/shared.ts, derived from the
// AllocatorConfig schema default). A wrong image makes the runner alloc pull a
// non-existent image → an infra-hold, so any reintroduced literal fails CI here.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CANONICAL_RUNNER_IMAGE } from "../src/engine/config/shared.js";

const srcRoot = resolve(import.meta.dirname, "../src");

function tsSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...tsSourceFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("runner-image guard (§5)", () => {
  it("the canonical runner image is the cat-cave v0 image", () => {
    expect(CANONICAL_RUNNER_IMAGE).toBe("ghcr.io/cat-cave/tanren-runner:v0");
  });

  it("no source file references the WRONG `ghcr.io/tanren/runner` image", () => {
    const offenders = tsSourceFiles(srcRoot).filter((file) =>
      readFileSync(file, "utf8").includes("ghcr.io/tanren/runner"),
    );
    expect(offenders, `wrong runner image found in:\n${offenders.join("\n")}`).toEqual([]);
  });
});
