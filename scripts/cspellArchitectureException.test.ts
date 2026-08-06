import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runArchitectureChecks } from "./check-architecture.mjs";

const temporaryRoots: string[] = [];

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "tanren-cspell-architecture-"));
  temporaryRoots.push(root);
  const requiredDocs = [
    "AGENTS.md",
    "docs/playbooks/spec-template.md",
    "docs/playbooks/version-verification.md",
    "docs/playbooks/github-workflow.md",
    "docs/contracts/architecture-checks.md",
  ];
  for (const file of requiredDocs) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), "# fixture\n");
  }
  const vendoredWords = `${Array.from({ length: 501 }, (_, index) => `word${index}`).join("\n")}\n`;
  const oversizedSource = `${Array.from({ length: 501 }, (_, index) => `export const line${index} = ${index};`).join("\n")}\n`;
  await writeFile(join(root, "cspell-words.txt"), vendoredWords);
  await mkdir(join(root, "services/orchestrator/src"), { recursive: true });
  await writeFile(join(root, "services/orchestrator/src/too-long.ts"), oversizedSource);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("cspell architecture exception", () => {
  it("exempts vendored cspell data but keeps the source line cap strict", async () => {
    const root = await createFixture();
    const diagnostics = (await runArchitectureChecks({ root })).filter((item) => item.rule === "file-line-max-500");

    expect(diagnostics.map((item) => item.file)).toEqual(["services/orchestrator/src/too-long.ts"]);
  });
});
