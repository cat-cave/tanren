// Enforcement-lint tests (audit RC-6). Proves the no-pg-as-date lint REJECTS a
// re-introduced `as Date` (and `.parse(...) as <Type>`) cast in the run-detail
// read seam, ignores casts outside the scoped dir, and ignores casts that appear
// only in comments/prose.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runNoPgAsDateLint, scanLineForViolations } from "./no-pg-as-date.mjs";

const SCOPED = "services/orchestrator/src/routes/runs/list.ts";
const OUT_OF_SCOPE = "services/orchestrator/src/routes/specs/list.ts";

async function createFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tanren-no-pg-as-date-"));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), text);
  }
  return root;
}

describe("no-pg-as-date lint", () => {
  it("passes when the scoped file decodes through a Zod schema (no casts)", async () => {
    const root = await createFixture({
      [SCOPED]: "const ts = RowSchema.parse(raw);\nreturn { startedAt: ts.started_at };\n",
    });
    await expect(runNoPgAsDateLint({ root })).resolves.toEqual([]);
  });

  it("REJECTS a planted `as Date` cast in routes/runs", async () => {
    const root = await createFixture({
      [SCOPED]: "return { startedAt: raw.started_at as Date };\n",
    });
    const diagnostics = await runNoPgAsDateLint({ root });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.file).toBe(SCOPED);
    expect(diagnostics[0]?.line).toBe(1);
    expect(diagnostics[0]?.message).toMatch(/as Date/u);
  });

  it("REJECTS a `.parse(...) as <Type>` cast that strips a parsed value's type", async () => {
    const root = await createFixture({
      [SCOPED]: "const x = Schema.parse(raw) as RunCostRecord;\n",
    });
    const diagnostics = await runNoPgAsDateLint({ root });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toMatch(/parse/u);
  });

  it("ignores an `as Date` cast outside the scoped dir", async () => {
    const root = await createFixture({
      [OUT_OF_SCOPE]: "return { startedAt: raw.started_at as Date };\n",
    });
    await expect(runNoPgAsDateLint({ root })).resolves.toEqual([]);
  });

  it("ignores `as Date` that appears only in a comment", async () => {
    const root = await createFixture({
      [SCOPED]: "// never launder a pg timestamp with `as Date`\nconst ts = RowSchema.parse(raw);\n",
    });
    await expect(runNoPgAsDateLint({ root })).resolves.toEqual([]);
  });

  it("allows `as const` (not a row-shape cast)", () => {
    expect(scanLineForViolations("const x = [1, 2] as const;")).toEqual([]);
  });
});
