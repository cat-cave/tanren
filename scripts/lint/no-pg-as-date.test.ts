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
// r6 §4: the scope WIDENED to the whole `routes/` + `db/` + `engine/**/*store*.ts`.
// An out-of-scope file is now an engine module that is NOT a store / forge decode.
const OUT_OF_SCOPE = "services/orchestrator/src/engine/workflow/plannerRun.ts";
// A newly-scoped HTTP read seam outside `routes/runs/` (the whole `routes/` is now in).
const SCOPED_ROUTES_OTHER = "services/orchestrator/src/routes/specs/list.ts";
// A newly-scoped DB-layer decode file (`db/**`).
const SCOPED_DB = "db/src/schemaForge.ts";
// A newly-scoped store/repository decode module (`engine/**/*store*.ts`).
const SCOPED_STORE = "services/orchestrator/src/engine/notifications/store.ts";
// A forge decode site is scoped as an EXACT file.
const FORGE_TURNS = "services/orchestrator/src/engine/forge/turns.ts";
// A sibling in the same dir is NOT scoped (only the listed decode files + globs are).
const FORGE_SIBLING = "services/orchestrator/src/engine/forge/schemas.ts";
// The forge-tools event read seam — scoped (code-integrity r3 finding #4).
const FORGE_TOOLS_READ = "services/orchestrator/src/engine/forge/tools/read.ts";

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

  it("REJECTS a planted `as Date` cast in the scoped engine/forge/turns.ts decode site", async () => {
    const root = await createFixture({
      [FORGE_TURNS]: "return { createdAt: raw.created_at as Date };\n",
    });
    const diagnostics = await runNoPgAsDateLint({ root });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.file).toBe(FORGE_TURNS);
    expect(diagnostics[0]?.message).toMatch(/as Date/u);
  });

  it("REJECTS a planted `JSON.parse(...) as <Type>` cast in engine/forge/turns.ts", async () => {
    const root = await createFixture({
      [FORGE_TURNS]: "const source = JSON.parse(raw.source) as ForgeTurnSource;\n",
    });
    const diagnostics = await runNoPgAsDateLint({ root });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.file).toBe(FORGE_TURNS);
    expect(diagnostics[0]?.message).toMatch(/parse/u);
  });

  it('REJECTS a planted `row["ts"] as Date` cast in the forge-tools read seam (read.ts)', async () => {
    const root = await createFixture({
      [FORGE_TOOLS_READ]: 'return { ts: row["ts"] as Date };\n',
    });
    const diagnostics = await runNoPgAsDateLint({ root });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.file).toBe(FORGE_TOOLS_READ);
    expect(diagnostics[0]?.message).toMatch(/as Date/u);
  });

  it("REJECTS a planted `as Date` cast in a newly-scoped routes/ seam (widened r6 §4)", async () => {
    const root = await createFixture({
      [SCOPED_ROUTES_OTHER]: "return { startedAt: raw.started_at as Date };\n",
    });
    const diagnostics = await runNoPgAsDateLint({ root });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.file).toBe(SCOPED_ROUTES_OTHER);
    expect(diagnostics[0]?.message).toMatch(/as Date/u);
  });

  it("REJECTS a planted `as Date` cast in a newly-scoped db/ decode file (widened r6 §4)", async () => {
    const root = await createFixture({
      [SCOPED_DB]: "return { createdAt: row.created_at as Date };\n",
    });
    const diagnostics = await runNoPgAsDateLint({ root });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.file).toBe(SCOPED_DB);
    expect(diagnostics[0]?.message).toMatch(/as Date/u);
  });

  it("REJECTS a planted `as Date` cast in a newly-scoped engine store module (widened r6 §4)", async () => {
    const root = await createFixture({
      [SCOPED_STORE]: "return { sentAt: row.sent_at as Date };\n",
    });
    const diagnostics = await runNoPgAsDateLint({ root });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.file).toBe(SCOPED_STORE);
    expect(diagnostics[0]?.message).toMatch(/as Date/u);
  });

  it("ignores a cast in a NON-scoped sibling of the forge decode files", async () => {
    const root = await createFixture({
      [FORGE_SIBLING]: "return { createdAt: raw.created_at as Date };\n",
    });
    await expect(runNoPgAsDateLint({ root })).resolves.toEqual([]);
  });

  it("allows `as unknown` (not a domain-shape cast) after a parse", () => {
    expect(scanLineForViolations("const v = JSON.parse(s) as unknown;")).toEqual([]);
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
