import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runArchitectureChecks } from "./check-architecture.mjs";
import {
  checkCrossPackageDeepImports,
  checkCyclomaticComplexity,
  checkMaxParams,
  COMPLEXITY_CAP,
  MAX_PARAMS_CAP,
} from "./check-architecture-structure.mjs";

async function createFixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "tanren-architecture-"));
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

describe("architecture checker", () => {
  it("accepts a minimal compliant fixture", async () => {
    const root = await createFixture({
      "package.json":
        '{"type":"module","scripts":{"check":"pnpm run check:schema-drift && pnpm run check:state-drift && pnpm run check:answerer-schema-drift && pnpm run check:contract-schema-drift","check:schema-drift":"bash scripts/check-schema-drift.sh","check:state-drift":"node scripts/generate-state-checks.mjs --check","check:answerer-schema-drift":"node scripts/answerer-schema-export.mjs --check","check:contract-schema-drift":"node scripts/contract-schema-export.mjs --check"}}\n',
      "scripts/check-schema-drift.sh": "#!/usr/bin/env bash\n",
      "scripts/generate-state-checks.mjs": "#!/usr/bin/env node\n",
      "scripts/answerer-schema-export.mjs": "#!/usr/bin/env node\n",
      "scripts/contract-schema-export.mjs": "#!/usr/bin/env node\n",
      ".github/workflows/ci.yml": "steps:\n  - uses: actions/checkout@v6\n  - uses: actions/setup-node@v6\n",
      "db/migrations/0001.sql":
        "CHECK (cost_basis IN ('ccusage','provider_pricing','unknown'))\nCHECK (billing_mode IN ('per_token','subscription','self_hosted'))\n",
      "services/orchestrator/src/engine/eventStore.ts": "export const ok = true;\n",
    });

    await expect(runArchitectureChecks({ root })).resolves.toEqual([]);
  });

  it("rejects architecture violations in fixture files", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": "steps:\n  - uses: actions/checkout@v5\n",
      "services/orchestrator/src/bad.ts": [
        `import { spawn } from "node:${"child_process"}";`,
        `const badCost = "${"legacy"}_unknown";`,
        `const sql = "${"INSERT INTO"} events (payload) VALUES ('{}')";`,
        "export const both = ['runWriter', 'runAnswerer'];",
      ].join("\n"),
    });

    const diagnostics = await runArchitectureChecks({ root });
    expect(diagnostics.map((item) => item.rule)).toEqual(
      expect.arrayContaining([
        "github-actions-current-major",
        "no-host-process-spawn",
        "no-unknown-cost-source",
        "single-event-writer",
        "writer-answerer-separation",
      ]),
    );
  });

  it("requires schema drift checking to stay wired into the root check", async () => {
    const root = await createFixture({
      "package.json": '{"type":"module","scripts":{"check":"pnpm run typecheck"}}\n',
      "scripts/check-schema-drift.sh": "#!/usr/bin/env bash\n",
    });

    const diagnostics = await runArchitectureChecks({ root });
    expect(diagnostics.map((item) => item.rule)).toContain("schema-drift-check-wired");
  });

  it("requires answerer schema drift checking to stay wired into the root check", async () => {
    const root = await createFixture({
      "package.json": '{"type":"module","scripts":{"check":"pnpm run typecheck"}}\n',
      "scripts/check-schema-drift.sh": "#!/usr/bin/env bash\n",
      "scripts/generate-state-checks.mjs": "#!/usr/bin/env node\n",
      "scripts/answerer-schema-export.mjs": "#!/usr/bin/env node\n",
    });

    const diagnostics = await runArchitectureChecks({ root });
    expect(diagnostics.map((item) => item.rule)).toContain("answerer-schema-drift-check-wired");
  });

  it("requires contract schema drift checking to stay wired into the root check", async () => {
    const root = await createFixture({
      "package.json": '{"type":"module","scripts":{"check":"pnpm run typecheck"}}\n',
      "scripts/check-schema-drift.sh": "#!/usr/bin/env bash\n",
      "scripts/generate-state-checks.mjs": "#!/usr/bin/env node\n",
      "scripts/answerer-schema-export.mjs": "#!/usr/bin/env node\n",
      "scripts/contract-schema-export.mjs": "#!/usr/bin/env node\n",
    });

    const diagnostics = await runArchitectureChecks({ root });
    expect(diagnostics.map((item) => item.rule)).toContain("contract-schema-drift-check-wired");
  });

  it("accepts root check delegation through just ci when the just recipe includes schema drift", async () => {
    const root = await createFixture({
      "package.json":
        '{"type":"module","scripts":{"check":"just ci","check:schema-drift":"bash scripts/check-schema-drift.sh","check:state-drift":"node scripts/generate-state-checks.mjs --check","check:answerer-schema-drift":"node scripts/answerer-schema-export.mjs --check","check:contract-schema-drift":"node scripts/contract-schema-export.mjs --check"}}\n',
      justfile:
        "ci: schema-drift state-drift answerer-schema-drift contract-schema-drift\n\nschema-drift:\n  corepack pnpm run check:schema-drift\n\nstate-drift:\n  corepack pnpm run check:state-drift\n\nanswerer-schema-drift:\n  corepack pnpm run check:answerer-schema-drift\n\ncontract-schema-drift:\n  corepack pnpm run check:contract-schema-drift\n",
      "scripts/check-schema-drift.sh": "#!/usr/bin/env bash\n",
      "scripts/generate-state-checks.mjs": "#!/usr/bin/env node\n",
      "scripts/answerer-schema-export.mjs": "#!/usr/bin/env node\n",
      "scripts/contract-schema-export.mjs": "#!/usr/bin/env node\n",
    });

    await expect(runArchitectureChecks({ root })).resolves.toEqual([]);
  });

  it("confines Docker socket and API access to the local allocator", async () => {
    const dockerSocket = ["/var/run", "docker.sock"].join("/");
    const root = await createFixture({
      "package.json":
        '{"type":"module","scripts":{"check":"pnpm run check:schema-drift","check:schema-drift":"bash scripts/check-schema-drift.sh"}}\n',
      "scripts/check-schema-drift.sh": "#!/usr/bin/env bash\n",
      "compose.yml": `services:\n  orchestrator:\n    volumes:\n      - ${dockerSocket}:${dockerSocket}\n`,
      "services/orchestrator/src/engine/allocators/dockerClient.ts": `export const socketPath = "${dockerSocket}";\n`,
      "services/orchestrator/src/engine/not-allocator.ts": `export const socketPath = "${dockerSocket}";\n`,
    });

    const diagnostics = await runArchitectureChecks({ root });
    expect(diagnostics.map((item) => item.rule)).toContain("docker-api-allocator-only");
  });

  it("permits the Docker socket bind mount when scoped to the allocator service", async () => {
    const dockerSocket = ["/var/run", "docker.sock"].join("/");
    const root = await createFixture({
      "package.json":
        '{"type":"module","scripts":{"check":"pnpm run check:schema-drift","check:schema-drift":"bash scripts/check-schema-drift.sh"}}\n',
      "scripts/check-schema-drift.sh": "#!/usr/bin/env bash\n",
      "compose.yml": `services:\n  allocator:\n    volumes:\n      - ${dockerSocket}:${dockerSocket}\n`,
    });

    const diagnostics = await runArchitectureChecks({ root });
    expect(diagnostics.map((item) => item.rule)).not.toContain("docker-api-allocator-only");
    expect(diagnostics.map((item) => item.rule)).not.toContain("no-host-bind-mounts");
  });

  it("allows the Docker socket mount only on the allocator service", async () => {
    const dockerSocket = ["/var/run", "docker.sock"].join("/");
    const root = await createFixture({
      "package.json":
        '{"type":"module","scripts":{"check":"pnpm run check:schema-drift","check:schema-drift":"bash scripts/check-schema-drift.sh"}}\n',
      "scripts/check-schema-drift.sh": "#!/usr/bin/env bash\n",
      "compose.yml": `services:\n  orchestrator:\n    volumes:\n      - ${dockerSocket}:${dockerSocket}\n`,
    });

    const diagnostics = await runArchitectureChecks({ root });
    expect(diagnostics.map((item) => item.rule)).toEqual(
      expect.arrayContaining(["docker-api-allocator-only", "no-host-bind-mounts"]),
    );
  });
});

describe("structural architecture checks", () => {
  const workflowFile = "services/orchestrator/src/engine/workflow/sample.ts";

  it("flags a function over the cyclomatic-complexity cap and passes a simple one", () => {
    // One branch token over the cap. Each `if` adds 1 to the baseline of 1.
    const branches = Array.from(
      { length: COMPLEXITY_CAP },
      (_unused, index) => `  if (n === ${index}) return ${index};`,
    ).join("\n");
    const overText = `export function tangled(n: number): number {\n${branches}\n  return -1;\n}\n`;
    const over = checkCyclomaticComplexity([{ file: workflowFile, text: overText }]);
    expect(over.map((item) => item.rule)).toEqual(["cyclomatic-complexity-cap"]);

    const cleanText = "export function simple(n: number): number {\n  return n > 0 ? n : 0;\n}\n";
    expect(checkCyclomaticComplexity([{ file: workflowFile, text: cleanText }])).toEqual([]);
  });

  it("only measures complexity inside the critical directories", () => {
    const branches = Array.from(
      { length: COMPLEXITY_CAP },
      (_unused, index) => `  if (n === ${index}) return ${index};`,
    ).join("\n");
    const text = `export function tangled(n: number): number {\n${branches}\n  return -1;\n}\n`;
    expect(checkCyclomaticComplexity([{ file: "services/orchestrator/src/routes/sample.ts", text }])).toEqual([]);
  });

  it("flags a function over the max-params cap and passes one at the cap", () => {
    const params = Array.from({ length: MAX_PARAMS_CAP + 1 }, (_unused, index) => `arg${index}: number`).join(", ");
    const overText = `export function wide(${params}): number {\n  return 0;\n}\n`;
    const over = checkMaxParams([{ file: workflowFile, text: overText }]);
    expect(over.map((item) => item.rule)).toEqual(["max-params-cap"]);

    const atCapParams = Array.from({ length: MAX_PARAMS_CAP }, (_unused, index) => `arg${index}: number`).join(", ");
    const atCapText = `export function fits(${atCapParams}): number {\n  return 0;\n}\n`;
    expect(checkMaxParams([{ file: workflowFile, text: atCapText }])).toEqual([]);
  });

  it("flags deep cross-package imports and allows public-entry and intra-package imports", () => {
    const bareDeep = {
      file: "services/orchestrator/src/main.ts",
      text: 'import { x } from "@tanren/db/src/stateEnums.js";\n',
    };
    const relativeDeep = {
      file: "services/orchestrator/tests/sample.test.ts",
      text: 'import { x } from "../../../db/src/stateEnums.js";\n',
    };
    const flagged = checkCrossPackageDeepImports([bareDeep, relativeDeep]);
    expect(flagged).toHaveLength(2);
    expect(flagged.every((item) => item.rule === "cross-package-deep-import")).toBe(true);

    const publicEntry = {
      file: "services/orchestrator/src/main.ts",
      text: 'import { stateEnumLists } from "@tanren/db";\n',
    };
    const intraPackage = {
      file: "services/orchestrator/src/main.ts",
      text: 'import { y } from "./engine/state/index.js";\n',
    };
    expect(checkCrossPackageDeepImports([publicEntry, intraPackage])).toEqual([]);
  });
});
