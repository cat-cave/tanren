import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDesignTokensDrift } from "./check-design-tokens-drift.mjs";

async function createFixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "tanren-design-tokens-drift-"));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), text);
  }
  return root;
}

const sampleTokens = ":root {\n  --accent: var(--ember-08);\n}\n";

describe("design tokens drift check", () => {
  it("passes when the dashboard copy matches the source of truth byte-for-byte", async () => {
    const root = await createFixture({
      "docs/design/tokens/colors_and_type.css": sampleTokens,
      "services/dashboard/src/design/tokens.css": sampleTokens,
    });

    await expect(checkDesignTokensDrift({ root })).resolves.toEqual([]);
  });

  it("flags drift when the dashboard copy diverges from the source", async () => {
    const root = await createFixture({
      "docs/design/tokens/colors_and_type.css": sampleTokens,
      "services/dashboard/src/design/tokens.css": sampleTokens.replace("--ember-08", "--ember-09"),
    });

    const diagnostics = await checkDesignTokensDrift({ root });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.copy).toBe("services/dashboard/src/design/tokens.css");
    expect(diagnostics[0]?.message).toMatch(/drift detected/u);
  });

  it("flags a missing dashboard copy", async () => {
    const root = await createFixture({
      "docs/design/tokens/colors_and_type.css": sampleTokens,
    });

    const diagnostics = await checkDesignTokensDrift({ root });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toMatch(/unable to read/u);
  });
});
