import { describe, expect, it } from "vitest";

import { SOURCE_URL, VENDORED_PATH, buildVendoredDocument, existingFetchedAt } from "./refresh-model-prices.mjs";

describe("refresh-model-prices — pure transform", () => {
  const rawUpstream = JSON.stringify({
    sample_spec: { input_cost_per_token: 0 },
    "gpt-4o": { litellm_provider: "openai", input_cost_per_token: 2.5e-6 },
  });

  it("targets the LiteLLM source URL and the vendored path under the costs/pricing dir", () => {
    expect(SOURCE_URL).toContain("BerriAI/litellm");
    expect(SOURCE_URL).toContain("model_prices_and_context_window.json");
    expect(VENDORED_PATH).toBe("services/orchestrator/src/engine/costs/pricing/model_prices.json");
  });

  it("prepends the self-describing manifest header (source URL + fetch date + refresh command)", () => {
    const out = buildVendoredDocument(rawUpstream, "2026-06-04T00:00:00Z");
    const parsed = JSON.parse(out);
    const manifest = parsed["_tanren_source"];
    expect(manifest.source_url).toBe(SOURCE_URL);
    expect(manifest.fetched_at).toBe("2026-06-04T00:00:00Z");
    expect(manifest.refresh_command).toBe("just refresh-model-prices");
    // Manifest rides FIRST so provenance is visible at the top of the file.
    expect(Object.keys(parsed)[0]).toBe("_tanren_source");
  });

  it("preserves the upstream model entries verbatim", () => {
    const parsed = JSON.parse(buildVendoredDocument(rawUpstream, "2026-06-04T00:00:00Z"));
    expect(parsed["gpt-4o"]).toEqual({ litellm_provider: "openai", input_cost_per_token: 2.5e-6 });
    expect(parsed.sample_spec).toEqual({ input_cost_per_token: 0 });
  });

  it("emits a trailing newline and 2-space pretty-printing", () => {
    const out = buildVendoredDocument(rawUpstream, "2026-06-04T00:00:00Z");
    expect(out.endsWith("}\n")).toBe(true);
    expect(out).toContain('\n  "');
  });

  it("rejects a non-object upstream payload (LOUD, never a silent empty snapshot)", () => {
    expect(() => buildVendoredDocument(JSON.stringify([1, 2, 3]), "2026-06-04T00:00:00Z")).toThrow("not an object map");
    expect(() => buildVendoredDocument("null", "2026-06-04T00:00:00Z")).toThrow("not an object map");
  });

  it("existingFetchedAt extracts the prior fetch date so --check ignores the date field", () => {
    const snapshot = buildVendoredDocument(rawUpstream, "2026-06-04T00:00:00Z");
    expect(existingFetchedAt(snapshot)).toBe("2026-06-04T00:00:00Z");
    expect(existingFetchedAt(null)).toBeNull();
    expect(existingFetchedAt("not json")).toBeNull();
  });
});
