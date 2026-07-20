// rv-1 architecture pin — the persona/behavior revision spine is CONTENT-immutable.
// The DB migration 0090 trigger is the hard backstop; this grep pins the source
// invariant so a future edit that reintroduces a content mutation fails loudly in
// the DB-less unit phase (not only under the RLS smoke recipe). The ONLY UPDATE
// production issues on either revision table is a status-only transition; there is
// NO production DELETE. A behavior's content is frozen — a new content is a NEW
// revision row, never an overwrite.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walkTs(full));
      continue;
    }
    if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

describe("persona/behavior revisions are content-immutable in production source", () => {
  const files = walkTs(SRC).map((file) => ({ rel: relative(ROOT, file), text: readFileSync(file, "utf8") }));

  it("issues NO production DELETE on either revision table", () => {
    const offenders = files
      .filter(({ text }) => /DELETE\s+FROM\s+(?:")?(?:persona|behavior)_revisions/iu.test(text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("every production UPDATE on a revision table sets ONLY status", () => {
    const updatePattern = /UPDATE\s+(?:")?(persona|behavior)_revisions(?:")?\s+SET\s+([^]*?)WHERE/giu;
    const offenders: string[] = [];
    for (const { rel, text } of files) {
      for (const match of text.matchAll(updatePattern)) {
        const setClause = match[2] ?? "";
        // The only permitted assignment is `status = '...'`.
        const normalized = setClause.trim().replaceAll(/\s+/gu, " ");
        if (!/^status\s*=\s*'(active|superseded|needs_respec)'\s*$/iu.test(normalized)) {
          offenders.push(`${rel}: UPDATE ${match[1]}_revisions SET ${normalized}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
