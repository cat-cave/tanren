import { describe, expect, it } from "vitest";
import { stateEnumLists } from "@tanren/db";
import { listStateEnums } from "../src/engine/state/index.js";

// The Zod source of truth in services/orchestrator/src/engine/state and the
// committed mirror in db/src/stateEnums.ts must always agree. The generator
// script regenerates the mirror; this test guards against accidental edits.

describe("state enum drift", () => {
  it("Zod source matches the committed db/src/stateEnums.ts mirror", () => {
    const declared = listStateEnums();
    const mirror = stateEnumLists as Record<string, ReadonlyArray<string>>;
    for (const { name, values } of declared) {
      expect(mirror[name], `missing mirror entry for ${name}`).toBeDefined();
      expect(mirror[name]).toEqual([...values]);
    }
    expect(Object.keys(mirror).sort()).toEqual(declared.map((entry) => entry.name).sort());
  });
});
