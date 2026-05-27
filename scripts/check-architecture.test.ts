import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runArchitectureChecks } from "./check-architecture.mjs";

async function createFixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "tanren-architecture-"));
  const requiredDocs = {
    "AGENTS.md": "# Agents\n",
    "docs/playbooks/spec-template.md": "# Spec Template\n",
    "docs/playbooks/version-verification.md": "# Version Verification\n",
    "docs/playbooks/github-workflow.md": "# GitHub Workflow\n",
    "docs/contracts/architecture-checks.md": "# Architecture Checks\n"
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
        "{\"type\":\"module\",\"scripts\":{\"check\":\"pnpm run check:schema-drift && pnpm run check:state-drift\",\"check:schema-drift\":\"bash scripts/check-schema-drift.sh\",\"check:state-drift\":\"node scripts/generate-state-checks.mjs --check\"}}\n",
      "scripts/check-schema-drift.sh": "#!/usr/bin/env bash\n",
      "scripts/generate-state-checks.mjs": "#!/usr/bin/env node\n",
      ".github/workflows/ci.yml": "steps:\n  - uses: actions/checkout@v6\n  - uses: actions/setup-node@v6\n",
      "db/migrations/0001.sql":
        "CHECK (cost_source IN ('provider_direct','ccusage','codexbar','opportunity_computed'))\n",
      "services/orchestrator/src/engine/eventStore.ts": "export const ok = true;\n"
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
        "export const both = ['runWriter', 'runAnswerer'];"
      ].join("\n")
    });

    const diagnostics = await runArchitectureChecks({ root });
    expect(diagnostics.map((item) => item.rule)).toEqual(
      expect.arrayContaining([
        "github-actions-current-major",
        "no-host-process-spawn",
        "no-unknown-cost-source",
        "single-event-writer",
        "writer-answerer-separation"
      ])
    );
  });

  it("requires schema drift checking to stay wired into the root check", async () => {
    const root = await createFixture({
      "package.json": "{\"type\":\"module\",\"scripts\":{\"check\":\"pnpm run typecheck\"}}\n",
      "scripts/check-schema-drift.sh": "#!/usr/bin/env bash\n"
    });

    const diagnostics = await runArchitectureChecks({ root });
    expect(diagnostics.map((item) => item.rule)).toContain("schema-drift-check-wired");
  });

  it("accepts root check delegation through just ci when the just recipe includes schema drift", async () => {
    const root = await createFixture({
      "package.json":
        "{\"type\":\"module\",\"scripts\":{\"check\":\"just ci\",\"check:schema-drift\":\"bash scripts/check-schema-drift.sh\",\"check:state-drift\":\"node scripts/generate-state-checks.mjs --check\"}}\n",
      "justfile":
        "ci: schema-drift state-drift\n\nschema-drift:\n  corepack pnpm run check:schema-drift\n\nstate-drift:\n  corepack pnpm run check:state-drift\n",
      "scripts/check-schema-drift.sh": "#!/usr/bin/env bash\n",
      "scripts/generate-state-checks.mjs": "#!/usr/bin/env node\n"
    });

    await expect(runArchitectureChecks({ root })).resolves.toEqual([]);
  });

  it("confines Docker socket and API access to the local allocator", async () => {
    const dockerSocket = ["/var/run", "docker.sock"].join("/");
    const root = await createFixture({
      "package.json":
        "{\"type\":\"module\",\"scripts\":{\"check\":\"pnpm run check:schema-drift\",\"check:schema-drift\":\"bash scripts/check-schema-drift.sh\"}}\n",
      "scripts/check-schema-drift.sh": "#!/usr/bin/env bash\n",
      "compose.yml": `services:\n  orchestrator:\n    volumes:\n      - ${dockerSocket}:${dockerSocket}\n`,
      "services/orchestrator/src/engine/allocators/dockerClient.ts": `export const socketPath = "${dockerSocket}";\n`,
      "services/orchestrator/src/engine/not-allocator.ts": `export const socketPath = "${dockerSocket}";\n`
    });

    const diagnostics = await runArchitectureChecks({ root });
    expect(diagnostics.map((item) => item.rule)).toContain("docker-api-allocator-only");
  });

  it("allows the Docker socket mount only on the orchestrator service", async () => {
    const dockerSocket = ["/var/run", "docker.sock"].join("/");
    const root = await createFixture({
      "package.json":
        "{\"type\":\"module\",\"scripts\":{\"check\":\"pnpm run check:schema-drift\",\"check:schema-drift\":\"bash scripts/check-schema-drift.sh\"}}\n",
      "scripts/check-schema-drift.sh": "#!/usr/bin/env bash\n",
      "compose.yml": `services:\n  runner:\n    volumes:\n      - ${dockerSocket}:${dockerSocket}\n`
    });

    const diagnostics = await runArchitectureChecks({ root });
    expect(diagnostics.map((item) => item.rule)).toEqual(
      expect.arrayContaining(["docker-api-allocator-only", "no-host-bind-mounts"])
    );
  });
});
