// ds-3 (F2D) — the PRODUCTION wiring seams: the provider-backed writer (real
// structured LLM call shape), the EventStore-backed event assembly, and the
// contract→surfaces requirement derivation. These prove the writer + event paths
// are REAL (a live AnswererAdapter / EventStore slots straight in) — the tests
// inject fakes through the SAME seams production wires.

import { describe, expect, it } from "vitest";
import type { AnswererAdapter } from "../src/engine/providers/types.js";
import type { EventStore } from "../src/engine/eventStore.js";
import { migrateDesignContractV1ToV2, parseDesignContractV2 } from "../src/engine/design/system/designContractV2.js";
import { normalizeDesignContract } from "../src/engine/design/designContract.js";
import { parseDesignFragmentSpec } from "../src/engine/design/system/designArtifactSchemas.js";
import {
  buildDesignFragmentAuthorerPrompt,
  createDesignFragmentAuthoringEvents,
  requiredDesignFragmentsFromSurfaces,
  wrapProviderDesignFragmentAuthorer,
  type DesignFragmentDraftV1,
} from "../src/engine/design/system/authoring/index.js";

const spec = parseDesignFragmentSpec({
  kind: "surface/dashboard",
  label: "Dashboard",
  phase: "patterns-and-templates",
  version: "1.0.0",
  conformanceSuiteId: "surface/dashboard.conformance.v1",
});

const promptContext = {
  contract: migrateDesignContractV1ToV2(
    normalizeDesignContract({ version: 1, domain: "saas-web", identity: "calm console", intent: "never surprises" }),
  ),
  webDesignBlock: "Available shadcn/Radix catalog components:\n- Button (button; src/button.tsx)",
};

const draftObject: DesignFragmentDraftV1 = {
  kind: "surface/dashboard",
  label: "Dashboard",
  phase: "patterns-and-templates",
  version: "1.0.0",
  targetCapabilities: ["shadcn"],
  requires: [],
  provides: [],
  dependsOn: [],
  conflicts: [],
  replaces: [],
  personaRefs: [],
  behaviorRefs: [],
  conformanceSuiteId: "surface/dashboard.conformance.v1",
  operations: [
    {
      operation: "addComponent",
      path: "components/dashboard.tsx",
      fileKind: "component-source",
      mediaType: "text/plain",
      content: "export const D = () => null;",
      executable: false,
    },
  ],
};

describe("ds-3 F2D — production wiring seams", () => {
  it("the prompt carries the design intent, the slot, and the web substrate", () => {
    const prompt = buildDesignFragmentAuthorerPrompt(
      { request: { missing: [spec], context: {} }, spec },
      promptContext,
    );
    // Carries the contract intent, the slot kind, the web substrate block, and the op guidance.
    expect(prompt).toContain("never surprises");
    expect(prompt).toContain("surface/dashboard");
    expect(prompt).toContain("shadcn/Radix catalog");
    expect(prompt).toContain("addComponent");
    expect(prompt.length).toBeLessThan(25_000);
  });

  it("wrapProviderDesignFragmentAuthorer drives a structured answerer call and parses the result", async () => {
    let seenPrompt = "";
    let seenSchemaName = "";
    const adapter: AnswererAdapter<DesignFragmentDraftV1> = {
      kind: "answerer",
      cli: "fake",
      authRef: "test",
      runAnswerer: async ({ prompt, outputSchema }) => {
        seenPrompt = prompt;
        seenSchemaName = outputSchema.name;
        // Exercises the real parse seam (parseDesignFragmentDraft).
        return outputSchema.parse(draftObject);
      },
    };
    const authorer = wrapProviderDesignFragmentAuthorer(adapter, promptContext);
    const draft = await authorer.author({ request: { missing: [spec], context: {} }, spec });
    expect(draft.kind).toBe("surface/dashboard");
    expect(draft.operations).toHaveLength(1);
    expect(seenSchemaName).toBe("tanren.design_fragment_authoring.v1");
    expect(seenPrompt).toContain("surface/dashboard");
  });

  it("createDesignFragmentAuthoringEvents appends the frozen event to the EventStore", async () => {
    const appended: { eventType: string; orgId: string; payload: unknown }[] = [];
    const eventStore: EventStore = {
      append: async (input) =>
        void appended.push({ eventType: input.eventType, orgId: input.orgId, payload: input.payload }),
    };
    const events = createDesignFragmentAuthoringEvents(eventStore);
    const event = events.factory.build({
      request: { missing: [spec], context: { orgId: "org1", createdBy: "tester" } },
      lifecycle: { point: "started", unitId: "surface/dashboard@Dashboard", spec },
    });
    await events.sink.emit(event);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.eventType).toBe("designFragment.authoring.started");
    expect(appended[0]?.orgId).toBe("org1");
  });

  it("requiredDesignFragmentsFromSurfaces derives a spec per desired surface", () => {
    const contract = parseDesignContractV2({
      version: 2,
      domain: "saas-web",
      identity: "console",
      intent: "clarity",
      desiredSurfaces: [
        { key: "dashboard", label: "Dashboard", intent: "at-a-glance state", personaRefs: ["p1"], behaviorRefs: [] },
        { key: "settings", label: "Settings", intent: "configure", personaRefs: [], behaviorRefs: [] },
      ],
    });
    const required = requiredDesignFragmentsFromSurfaces(contract);
    expect(required.map((s) => s.kind)).toEqual(["surface/dashboard", "surface/settings"]);
    expect(required[0]?.personaRefs).toEqual(["p1"]);
  });
});
