import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkSingleEventWriter } from "./check-architecture-event-writer.mjs";

async function createProjectFiles(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "tanren-event-writer-"));
  const projectFiles: { file: string; text: string }[] = [];
  for (const [file, text] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), text);
    projectFiles.push({ file, text });
  }
  return projectFiles;
}

// Split so this test source never itself contains a continuous SQL insert literal
// (the AST rule would flag this file under scripts/** otherwise).
const insertIntoEvents = ["INSERT", "INTO", "events"].join(" ");

describe("single-event-writer (Oxc AST)", () => {
  it("detects executable event writes (multiline SQL + aliased Drizzle insert)", async () => {
    // Positive control: real executable forms the AST must reject outside eventStore.
    // Multiline template SQL and a non-`db` receiver both used to be easy for the
    // source-text scanner to miss or mis-target; the AST pins both.
    const projectFiles = await createProjectFiles({
      "services/orchestrator/src/bad-event-write.ts": [
        "export async function sneak(client: { query: (s: string) => Promise<unknown> }, tx: { insert: (t: unknown) => unknown }, events: unknown) {",
        `  await client.query(\`${insertIntoEvents} (run_id, event_type, payload)`,
        "    VALUES ($1, $2, $3::jsonb)`);",
        "  await tx",
        "    .insert(",
        "      events",
        "    );",
        "}",
      ].join("\n"),
    });
    const diagnostics = checkSingleEventWriter(projectFiles);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((item) => item.line)).toEqual([2, 4]);
    expect(diagnostics.every((item) => item.rule === "single-event-writer")).toBe(true);
    expect(diagnostics.every((item) => item.message === "events may only be written through eventStore")).toBe(true);
  });

  it("ignores event-write lookalikes in comments/strings/templates (regex false positives)", async () => {
    // Negative control: the old `/db\.insert\s*\(\s*events\s*\)/` source-text
    // scanner would flag every one of these; the AST only accepts CallExpression
    // `.insert(events)` sites, so prose lookalikes stay silent.
    const drizzleMention = ["db", ".insert(", "events)"].join("");
    const projectFiles = await createProjectFiles({
      "services/orchestrator/src/docs-only.ts": [
        `// never call ${drizzleMention} outside eventStore`,
        `const prose = "${drizzleMention} is forbidden here";`,
        `const template = \`see ${drizzleMention} in the architecture contract\`;`,
        "const pattern = /db\\.insert\\(\\s*events\\s*\\)/;",
        "export const ok = true;",
      ].join("\n"),
    });
    expect(checkSingleEventWriter(projectFiles)).toEqual([]);
  });

  it("fails closed on unparseable code; ignores non-code prose", async () => {
    const projectFiles = await createProjectFiles({
      "services/orchestrator/src/broken-events.ts": "export const = ;\n",
      "docs/events-notes.md": "```ts\ndb.insert(events);\n```\n",
    });
    const diagnostics = checkSingleEventWriter(projectFiles);
    expect(diagnostics.map((d) => d.file)).toEqual(["services/orchestrator/src/broken-events.ts"]);
    expect(diagnostics[0]?.message).toContain("failed closed");
  });

  it("allows the canonical eventStore writer and skips migrations", async () => {
    // Fixture bodies are built so the *subject* files contain real writes while
    // this test source keeps INSERT/INTO/events discontinuous (see insertIntoEvents).
    const projectFiles = await createProjectFiles({
      "services/orchestrator/src/engine/eventStore.ts": [
        "export async function append(db: { insert: (t: unknown) => unknown }, events: unknown) {",
        "  await db.insert(events);",
        "}",
        "",
      ].join("\n"),
      "db/migrations/0001.sql": `${insertIntoEvents} (id) VALUES (1);\n`,
    });
    expect(checkSingleEventWriter(projectFiles)).toEqual([]);
  });
});
