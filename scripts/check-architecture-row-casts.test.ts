// Regression for `no-raw-row-casts-in-workflow`: the empty allowlist must actually
// fire on identifier AND object-literal casts (a bare `[A-Za-z_$]` stem missed
// `as { … }`, so clearing the allowlist was previously a no-op).
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runArchitectureChecks } from "./check-architecture.mjs";

async function createFixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "tanren-row-cast-"));
  const requiredDocs = {
    "AGENTS.md": "# Agents\n",
    "docs/playbooks/spec-template.md": "# Spec Template\n",
    "docs/playbooks/version-verification.md": "# Version Verification\n",
    "docs/playbooks/github-workflow.md": "# GitHub Workflow\n",
    "docs/contracts/architecture-checks.md": "# Architecture Checks\n",
  };
  for (const [file, text] of Object.entries({ ...requiredDocs, ...files })) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), text);
  }
  return root;
}

const pkg = JSON.stringify({
  type: "module",
  scripts: {
    check:
      "pnpm run check:schema-drift && pnpm run check:state-drift && pnpm run check:answerer-schema-drift && pnpm run check:contract-schema-drift",
    "check:schema-drift": "bash scripts/check-schema-drift.sh",
    "check:state-drift": "node scripts/generate-state-checks.mjs --check",
    "check:answerer-schema-drift": "node scripts/answerer-schema-export.mjs --check",
    "check:contract-schema-drift": "node scripts/contract-schema-export.mjs --check",
  },
});

describe("no-raw-row-casts-in-workflow (empty allowlist enforced)", () => {
  it("rejects identifier + object-literal casts under workflow/**", async () => {
    const root = await createFixture({
      "package.json": `${pkg}\n`,
      "scripts/check-schema-drift.sh": "#!/usr/bin/env bash\n",
      "scripts/generate-state-checks.mjs": "#!/usr/bin/env node\n",
      "scripts/answerer-schema-export.mjs": "#!/usr/bin/env node\n",
      "scripts/contract-schema-export.mjs": "#!/usr/bin/env node\n",
      ".github/workflows/ci.yml": "steps:\n  - uses: actions/checkout@v6\n  - uses: actions/setup-node@v6\n",
      "services/orchestrator/src/engine/eventStore.ts": "export const ok = true;\n",
      "services/orchestrator/src/engine/workflow/castFixture.ts": [
        "type TaskRow = { task_id: string };",
        "export function bad(existing: { rows: unknown[] }) {",
        "  const a = existing.rows[0] as { task_id: string } | undefined;",
        "  const row = existing.rows[0];",
        "  const b = row as TaskRow;",
        "  const rows = existing.rows;",
        "  const c = rows as TaskRow[];",
        "  return { a, b, c };",
        "}",
      ].join("\n"),
    });
    const diagnostics = await runArchitectureChecks({ root });
    const rowCasts = diagnostics.filter((d) => d.rule === "no-raw-row-casts-in-workflow");
    expect(rowCasts.length).toBeGreaterThanOrEqual(3);
    expect(rowCasts.every((d) => d.file.endsWith("castFixture.ts"))).toBe(true);
  });

  it("accepts Zod-decoded rows (no raw cast)", async () => {
    const root = await createFixture({
      "package.json": `${pkg}\n`,
      "scripts/check-schema-drift.sh": "#!/usr/bin/env bash\n",
      "scripts/generate-state-checks.mjs": "#!/usr/bin/env node\n",
      "scripts/answerer-schema-export.mjs": "#!/usr/bin/env node\n",
      "scripts/contract-schema-export.mjs": "#!/usr/bin/env node\n",
      ".github/workflows/ci.yml": "steps:\n  - uses: actions/checkout@v6\n  - uses: actions/setup-node@v6\n",
      "services/orchestrator/src/engine/eventStore.ts": "export const ok = true;\n",
      "services/orchestrator/src/engine/workflow/zodFixture.ts": [
        'import { z } from "zod";',
        "const Row = z.object({ task_id: z.string() });",
        "export function good(existing: { rows: unknown[] }) {",
        "  const raw = existing.rows[0];",
        "  return raw === undefined ? undefined : Row.parse(raw);",
        "}",
      ].join("\n"),
    });
    const diagnostics = await runArchitectureChecks({ root });
    expect(diagnostics.map((d) => d.rule)).not.toContain("no-raw-row-casts-in-workflow");
  });
});
