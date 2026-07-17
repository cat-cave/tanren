import { describe, expect, it } from "vitest";
import { migrateProjectConfig } from "../src/engine/config/index.js";
import { checkFullProjectConfigPatch } from "../src/engine/workflow/projectConfigWriteGuards.js";

const ORG_ID = "org_acme";
const FOREIGN_ORG_ID = "org_other";
const currentConfig = migrateProjectConfig({ version: 1 });

function llmEntry(authRef: string) {
  return { cli: "codex", model: "default", authRef };
}

describe("project LLM auth-ref ownership guard", () => {
  it.each([
    [
      "a routing chain authRef",
      { version: 1, routing: { write: { chain: [llmEntry(`credential/codex/org/${FOREIGN_ORG_ID}/default`)] } } },
      ["routing.write.chain[0].authRef"],
    ],
    [
      "the default LLM authRef",
      { version: 1, credentials: { defaultLlm: llmEntry(`credential/codex/org/${FOREIGN_ORG_ID}/default`) } },
      ["credentials.defaultLlm.authRef"],
    ],
  ])("rejects foreign-org %s at the config-write chokepoint", (_label, config, fields) => {
    const result = checkFullProjectConfigPatch(config, currentConfig, ORG_ID);

    expect(result).toMatchObject({
      ok: false,
      response: { error: "invalid_project_config", fields },
    });
  });

  it("accepts and retains same-org routing and default LLM authRefs", () => {
    const authRef = `credential/codex/org/${ORG_ID}/default`;
    const result = checkFullProjectConfigPatch(
      {
        version: 1,
        routing: { write: { chain: [llmEntry(authRef)] } },
        credentials: { defaultLlm: llmEntry(authRef) },
      },
      currentConfig,
      ORG_ID,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected the same-org LLM refs to be accepted");
    }
    expect(result.config.routing.write.chain[0]?.authRef).toBe(authRef);
    expect(result.config.credentials?.defaultLlm?.authRef).toBe(authRef);
  });
});
