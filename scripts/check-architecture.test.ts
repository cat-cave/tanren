import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkNoProductionStubs } from "./check-architecture-stubs.mjs";
import { runArchitectureChecks } from "./check-architecture.mjs";
import {
  checkCrossPackageDeepImports,
  checkCyclomaticComplexity,
  checkE2eNoMockImports,
  checkMaxParams,
  checkNoMockOnlyTests,
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
        "CHECK (cost_basis IN ('ccusage','provider_response','credits','unknown','unattributed'))\nCHECK (billing_mode IN ('per_token','subscription','self_hosted','unattributed'))\n",
      "services/orchestrator/src/engine/eventStore.ts": "export const ok = true;\n",
    });

    await expect(runArchitectureChecks({ root })).resolves.toEqual([]);
  });

  it("accepts quoted-migration and Drizzle billing_mode/cost_basis CHECK forms with unattributed", async () => {
    const root = await createFixture({
      "package.json":
        '{"type":"module","scripts":{"check":"pnpm run check:schema-drift && pnpm run check:state-drift && pnpm run check:answerer-schema-drift && pnpm run check:contract-schema-drift","check:schema-drift":"bash scripts/check-schema-drift.sh","check:state-drift":"node scripts/generate-state-checks.mjs --check","check:answerer-schema-drift":"node scripts/answerer-schema-export.mjs --check","check:contract-schema-drift":"node scripts/contract-schema-export.mjs --check"}}\n',
      "scripts/check-schema-drift.sh": "#!/usr/bin/env bash\n",
      "scripts/generate-state-checks.mjs": "#!/usr/bin/env node\n",
      "scripts/answerer-schema-export.mjs": "#!/usr/bin/env node\n",
      "scripts/contract-schema-export.mjs": "#!/usr/bin/env node\n",
      ".github/workflows/ci.yml": "steps:\n  - uses: actions/checkout@v6\n  - uses: actions/setup-node@v6\n",
      // Real migration shape: table-qualified quoted identifiers.
      "db/migrations/0000_collapsed_baseline.sql":
        "CONSTRAINT \"cost_records_billing_mode_check\" CHECK (\"cost_records\".\"billing_mode\" IN ('per_token','subscription','self_hosted','unattributed')),\nCONSTRAINT \"cost_records_cost_basis_check\" CHECK (\"cost_records\".\"cost_basis\" IN ('ccusage','provider_response','credits','unknown','unattributed'))\n",
      // Real Drizzle schema shape: camelCase template expression.
      "db/src/schema.ts":
        "check('cost_records_billing_mode_check', sql`${table.billingMode} IN ('per_token','subscription','self_hosted','unattributed')`);\ncheck('cost_records_cost_basis_check', sql`${table.costBasis} IN ('ccusage','provider_response','credits','unknown','unattributed')`);\n",
      "services/orchestrator/src/engine/eventStore.ts": "export const ok = true;\n",
    });

    await expect(runArchitectureChecks({ root })).resolves.toEqual([]);
  });

  it("rejects a billing_mode CHECK missing unattributed", async () => {
    const root = await createFixture({
      "package.json":
        '{"type":"module","scripts":{"check":"pnpm run check:schema-drift && pnpm run check:state-drift && pnpm run check:answerer-schema-drift && pnpm run check:contract-schema-drift","check:schema-drift":"bash scripts/check-schema-drift.sh","check:state-drift":"node scripts/generate-state-checks.mjs --check","check:answerer-schema-drift":"node scripts/answerer-schema-export.mjs --check","check:contract-schema-drift":"node scripts/contract-schema-export.mjs --check"}}\n',
      "scripts/check-schema-drift.sh": "#!/usr/bin/env bash\n",
      "scripts/generate-state-checks.mjs": "#!/usr/bin/env node\n",
      "scripts/answerer-schema-export.mjs": "#!/usr/bin/env node\n",
      "scripts/contract-schema-export.mjs": "#!/usr/bin/env node\n",
      ".github/workflows/ci.yml": "steps:\n  - uses: actions/checkout@v6\n  - uses: actions/setup-node@v6\n",
      // Split the identifier so this intentional 3-mode list is not itself a live CHECK hit.
      "db/migrations/0001.sql": ["CHECK (billing_", "mode IN ('per_token','subscription','self_hosted'))\n"].join(""),
      "services/orchestrator/src/engine/eventStore.ts": "export const ok = true;\n",
    });

    const diagnostics = await runArchitectureChecks({ root });
    expect(diagnostics.map((item) => item.rule)).toContain("no-unknown-cost-source");
  });

  it("rejects a same-length billing_mode CHECK with a duplicate (omits unattributed)", async () => {
    const root = await createFixture({
      "package.json":
        '{"type":"module","scripts":{"check":"pnpm run check:schema-drift && pnpm run check:state-drift && pnpm run check:answerer-schema-drift && pnpm run check:contract-schema-drift","check:schema-drift":"bash scripts/check-schema-drift.sh","check:state-drift":"node scripts/generate-state-checks.mjs --check","check:answerer-schema-drift":"node scripts/answerer-schema-export.mjs --check","check:contract-schema-drift":"node scripts/contract-schema-export.mjs --check"}}\n',
      "scripts/check-schema-drift.sh": "#!/usr/bin/env bash\n",
      "scripts/generate-state-checks.mjs": "#!/usr/bin/env node\n",
      "scripts/answerer-schema-export.mjs": "#!/usr/bin/env node\n",
      "scripts/contract-schema-export.mjs": "#!/usr/bin/env node\n",
      ".github/workflows/ci.yml": "steps:\n  - uses: actions/checkout@v6\n  - uses: actions/setup-node@v6\n",
      // 4 values, but self_hosted twice — length-match alone would falsely pass.
      "db/migrations/0001.sql": [
        "CHECK (billing_",
        "mode IN ('per_token','subscription','self_hosted','self_hosted'))\n",
      ].join(""),
      "services/orchestrator/src/engine/eventStore.ts": "export const ok = true;\n",
    });

    const diagnostics = await runArchitectureChecks({ root });
    expect(diagnostics.map((item) => item.rule)).toContain("no-unknown-cost-source");
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

  it("flags a test block whose only assertion is a mock-call check", () => {
    const text = [
      'it("calls the collaborator", () => {',
      "  doThing();",
      "  expect(spy).toHaveBeenCalledWith(1);",
      "});",
      "",
    ].join("\n");
    const flagged = checkNoMockOnlyTests([{ file: "pkg/foo.test.ts", text }]);
    expect(flagged.map((item) => item.rule)).toEqual(["no-mock-only-tests"]);
  });

  it("passes a block that pairs a mock-call check with an outcome assertion", () => {
    const text = [
      'it("returns the computed value", () => {',
      "  const result = doThing();",
      "  expect(spy).toHaveBeenCalled();",
      "  expect(result).toBe(42);",
      "});",
      "",
    ].join("\n");
    expect(checkNoMockOnlyTests([{ file: "pkg/foo.test.ts", text }])).toEqual([]);
  });

  it("treats async arrow and function-expression blocks the same", () => {
    const arrow = 'it("a", async () => {\n  expect(spy).toHaveBeenCalled();\n});\n';
    const fn = 'it("b", function () {\n  expect(spy.mock.calls).toHaveLength(1);\n});\n';
    // The function-expression block pairs the mock check with toHaveLength (an
    // outcome matcher), so only the arrow block is flagged.
    const flagged = checkNoMockOnlyTests([{ file: "pkg/foo.test.ts", text: arrow + fn }]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.rule).toBe("no-mock-only-tests");
  });

  it("freezes module mocking: any vi.mock( is flagged", () => {
    const text = 'vi.mock("../service.js");\nit("x", () => {\n  expect(1).toBe(1);\n});\n';
    const flagged = checkNoMockOnlyTests([{ file: "pkg/foo.test.ts", text }]);
    expect(flagged.map((item) => item.rule)).toEqual(["no-mock-only-tests"]);
    expect(flagged[0]?.message).toContain("vi.mock");
  });

  it("ignores non-test files", () => {
    const text = "export function f() {\n  expect(spy).toHaveBeenCalled();\n}\n";
    expect(checkNoMockOnlyTests([{ file: "pkg/foo.ts", text }])).toEqual([]);
  });
});

describe("no-production-stubs (P8a §8a stub-ban lint)", () => {
  const srcFile = "services/orchestrator/src/engine/sample.ts";

  it("flags a planted stub construction in production src", () => {
    const text = [
      'import { FakeAllocator } from "./contracts/allocator.js";',
      "export const allocator = new FakeAllocator();",
      "",
    ].join("\n");
    const flagged = checkNoProductionStubs([{ file: srcFile, text }]);
    expect(flagged.map((item) => item.rule)).toEqual(["no-production-stubs"]);
    expect(flagged[0]?.line).toBe(2);
  });

  it("flags a stub used as a default-assignment fallback", () => {
    const text = "const resolver = input.resolveConflict ?? noopConflictResolver;\n";
    const flagged = checkNoProductionStubs([{ file: srcFile, text }]);
    expect(flagged.map((item) => item.rule)).toEqual(["no-production-stubs"]);
  });

  it("flags a deterministic-answerer construction (the absent-Forge-wiring smell)", () => {
    const text = "const answerer = createDeterministicOptionsAnswerer();\n";
    const flagged = checkNoProductionStubs([{ file: srcFile, text }]);
    expect(flagged.map((item) => item.rule)).toEqual(["no-production-stubs"]);
  });

  it("passes when the same construction lives under tests/", () => {
    const text = "export const allocator = new FakeAllocator();\n";
    const testFile = "services/orchestrator/tests/fixtures/allocator.ts";
    expect(checkNoProductionStubs([{ file: testFile, text }])).toEqual([]);
    const dotTest = "services/orchestrator/src/engine/sample.test.ts";
    expect(checkNoProductionStubs([{ file: dotTest, text }])).toEqual([]);
  });

  it("does not flag a bare class definition (a definition is not a construction)", () => {
    const text = "export class FakeAllocator implements Allocator {\n  async allocate() {}\n}\n";
    expect(checkNoProductionStubs([{ file: srcFile, text }])).toEqual([]);
  });

  it("ignores a taxonomy word that appears only in prose / JSDoc", () => {
    const text = [
      "// The LLM-backed engine that replaces the templated v0 narration.",
      "/** Builds the real, templated-free generator. */",
      "export const x = buildReal();",
      "",
    ].join("\n");
    expect(checkNoProductionStubs([{ file: srcFile, text }])).toEqual([]);
  });

  it("honors an allowlisted construction ONLY when the // arch-allow: annotation is present", () => {
    const file = "services/orchestrator/src/engine/notifications/registry.ts";
    const withAnnotation = [
      "// arch-allow: StubChannel — unconfigured channel records 'stubbed', never silently drops.",
      "return new StubChannel(kind);",
      "",
    ].join("\n");
    expect(checkNoProductionStubs([{ file, text: withAnnotation }])).toEqual([]);

    const withoutAnnotation = "return new StubChannel(kind);\n";
    const flagged = checkNoProductionStubs([{ file, text: withoutAnnotation }]);
    expect(flagged.map((item) => item.rule)).toEqual(["no-production-stubs"]);
    expect(flagged[0]?.message).toContain("missing the required");
  });

  it("scopes a pending allowlist entry to its own file (not file-agnostic)", () => {
    // The audit pass runner is pending-allowlisted in routes/audits/index.ts only;
    // a `noop*` stub elsewhere is still flagged even with an arch-allow annotation
    // (an allowlist entry is file + identifier scoped).
    const elsewhere = "services/orchestrator/src/engine/other.ts";
    const text = "// arch-allow: pending\nconst r = input.resolve ?? noopConflictResolver;\n";
    const flagged = checkNoProductionStubs([{ file: elsewhere, text }]);
    expect(flagged.map((item) => item.rule)).toEqual(["no-production-stubs"]);
  });

  it("classifies stems by CamelCase/prefix/suffix and ignores non-stem lookalikes", () => {
    // Stub prefix, noop prefix (lowercase), Fake prefix, Mock suffix, Stub suffix.
    const hits = [
      "const a = new StubChannel(k);",
      "const b = input.x ?? noopConflictResolver;",
      "const c = new FakeAllocator();",
      "const d = new HttpMock();",
      "const e = new ApiStub();",
    ].join("\n");
    expect(checkNoProductionStubs([{ file: srcFile, text: `${hits}\n` }])).toHaveLength(5);

    // None contain a delimited stub stem word: "stubbornness", "mockingbird",
    // "smoke", "stubborn" all split to non-stem words.
    const misses = [
      "const a = new Stubbornness();",
      "const b = new MockingbirdLib();",
      "const c = new SmokeTest();",
      "const d = stubbornValue;",
    ].join("\n");
    expect(checkNoProductionStubs([{ file: srcFile, text: `${misses}\n` }])).toEqual([]);
  });

  it("does not extend the allowlisted file's exemption to a different stub identifier", () => {
    const file = "services/orchestrator/src/engine/notifications/registry.ts";
    // The annotation is present and StubChannel is allowlisted here, but a
    // FakeAllocator is not — it must still be flagged.
    const text = [
      "// arch-allow: StubChannel — honest not-wired audit record.",
      "const ch = new StubChannel(kind);",
      "const a = new FakeAllocator();",
      "",
    ].join("\n");
    const flagged = checkNoProductionStubs([{ file, text }]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.line).toBe(3);
  });
});

describe("e2e no-mock arch check", () => {
  const harnessFile = "tests/e2e/cases/tierProofs.e2e.ts";

  it("flags an e2e file importing a test fixture / mock / stub", () => {
    const text = [
      'import { fakeWriter } from "../../../services/orchestrator/tests/fixtures/fakeWriter.js";',
      'import { stubAnswerer } from "./helpers/answererStub.js";',
      'import { createInterviewAnswerer } from "../lib/deterministicAnswerer.js";',
    ].join("\n");
    const flagged = checkE2eNoMockImports([{ file: harnessFile, text }]);
    expect(flagged.map((item) => item.rule)).toEqual([
      "e2e-no-mock-imports",
      "e2e-no-mock-imports",
      "e2e-no-mock-imports",
    ]);
    expect(flagged[0]?.message).toContain("fixture/mock/stub");
  });

  it("flags an e2e file reaching into a non-public internal seam", () => {
    const text = [
      'import { runWriter } from "@tanren/orchestrator/src/engine/workflow/writerRun.js";',
      'import { mountFeatureRoutes } from "../../../services/orchestrator/src/routes/forge/index.js";',
    ].join("\n");
    const flagged = checkE2eNoMockImports([{ file: harnessFile, text }]);
    expect(flagged.map((item) => item.rule)).toEqual(["e2e-no-mock-imports", "e2e-no-mock-imports"]);
    expect(flagged[1]?.message).toContain("internal seam");
  });

  it("allows the e2e suite's own lib, node builtins, the @tanren/db public entry, and third-party clients", () => {
    const text = [
      'import { describe, expect, it } from "vitest";',
      'import { readFile } from "node:fs/promises";',
      'import { createDbPool } from "@tanren/db";',
      'import { runCase } from "../lib/harness.js";',
      'import { e2eManifest } from "../lib/manifest.js";',
    ].join("\n");
    expect(checkE2eNoMockImports([{ file: harnessFile, text }])).toEqual([]);
  });

  it("ignores files outside tests/e2e/**", () => {
    const text = 'import { fakeWriter } from "../tests/fixtures/fakeWriter.js";';
    expect(checkE2eNoMockImports([{ file: "services/orchestrator/tests/run.test.ts", text }])).toEqual([]);
  });
});
