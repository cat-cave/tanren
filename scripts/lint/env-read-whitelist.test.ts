// Enforcement-lint tests for env-read-whitelist (Codex r5 §4). The widened scan
// must now ALSO govern the project's `env("LITERAL")` indirection HELPER — not just
// bare `process.env.X` — because the helper was a hole the reaper's reads slipped
// through. These plant un-allowlisted reads in a fixture tree and assert the check
// flags them; and prove the legit existing reads keep PASSING.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runEnvReadWhitelistCheck } from "./env-read-whitelist.mjs";

// A file under services/ that is NOT in either allowlist — any governed env read in
// it must be flagged.
const UNLISTED = "services/orchestrator/src/engine/somethingNew.ts";

async function createFixture(files) {
  const root = await mkdtemp(join(tmpdir(), "tanren-env-read-whitelist-"));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), text);
  }
  return root;
}

describe("env-read-whitelist lint", () => {
  it('FLAGS a new un-allowlisted `env("TANREN_NEW")` HELPER call (the §4 hole)', async () => {
    const root = await createFixture({
      [UNLISTED]: 'const v = env("TANREN_NEW");\n',
    });
    const violations = await runEnvReadWhitelistCheck({ root });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe(UNLISTED);
    expect(violations[0]?.snippet).toMatch(/TANREN_NEW/u);
    expect(violations[0]?.reason).toBe("tanren-file");
  });

  it("FLAGS a new un-allowlisted bare `process.env.TANREN_NEW` read", async () => {
    const root = await createFixture({
      [UNLISTED]: "const v = process.env.TANREN_NEW;\n",
    });
    const violations = await runEnvReadWhitelistCheck({ root });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toBe("tanren-file");
  });

  it('FLAGS an un-allowlisted non-`TANREN_` `env("DEBUG_FLAG")` helper call by VAR', async () => {
    const root = await createFixture({
      [UNLISTED]: 'const v = env("DEBUG_FLAG");\n',
    });
    const violations = await runEnvReadWhitelistCheck({ root });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toBe("non-tanren-var");
  });

  it("FLAGS a dynamic `env(name)` helper call in an un-allowlisted file (no static name)", async () => {
    const root = await createFixture({
      [UNLISTED]: "const name = pick();\nconst v = env(name);\n",
    });
    const violations = await runEnvReadWhitelistCheck({ root });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toBe("dynamic-env-file");
  });

  it('does NOT flag `someObj.env("X")` or `parseEnv("X")` (not the standalone helper)', async () => {
    const root = await createFixture({
      [UNLISTED]: 'const a = cfg.env("X");\nconst b = parseEnv("X");\n',
    });
    await expect(runEnvReadWhitelistCheck({ root })).resolves.toEqual([]);
  });

  it("does NOT flag a `TANREN_*` helper read in a whitelisted boot file", async () => {
    const root = await createFixture({
      // buildAllocator.ts is now whitelisted for its `env("TANREN_*")` helper reads.
      ["services/orchestrator/src/engine/allocators/buildAllocator.ts"]: 'const v = env("TANREN_RUNNER_SSH_HOST");\n',
    });
    await expect(runEnvReadWhitelistCheck({ root })).resolves.toEqual([]);
  });

  it("PASSES the real repo tree (the widened scan governs every existing read)", async () => {
    // Run against the actual repo root: every shipped env read — bare AND helper —
    // is already accounted for, so the widened lint must stay green.
    await expect(runEnvReadWhitelistCheck()).resolves.toEqual([]);
  });
});
