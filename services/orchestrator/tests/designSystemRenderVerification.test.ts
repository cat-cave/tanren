// cspell:ignore badimg
// ds-4 sub-node #3 — proves the PRODUCTION render-verification pass ACTUALLY runs the
// sub-node #1 harness + sub-node #2 oracle over a REAL ds-2 catalog (React SSR + axe) and
// aggregates a fail-closed run-level outcome. No stubbed captures, no fabricated verdicts.

import { describe, expect, it } from "vitest";
import {
  contentDigestOf,
  type CasArtifactBytes,
  type CasArtifactRef,
  type CasByteStore,
  type Digest,
} from "../src/engine/contracts/cas.js";
import { resolveDtcgTokens } from "../src/engine/design/system/dtcgResolver.js";
import { WebDesignTargetAdapter } from "../src/engine/design/system/webAdapter.js";
import { verifyComposedDesignSystemRender } from "../src/engine/design/render/designSystemRenderVerification.js";

class InMemoryContentStore implements CasByteStore {
  readonly rows = new Map<Digest, CasArtifactBytes>();
  async put(input: { orgId: string; bytes: Uint8Array; mediaType: string }): Promise<CasArtifactRef> {
    const digest = contentDigestOf(input.bytes);
    this.rows.set(digest, { digest, bytes: input.bytes, mediaType: input.mediaType });
    return { digest, byteSize: input.bytes.byteLength, mediaType: input.mediaType };
  }
  async get(_orgId: string, digest: Digest): Promise<CasArtifactBytes> {
    const row = this.rows.get(digest);
    if (row === undefined) throw new Error(`missing CAS row ${digest}`);
    return row;
  }
  async has(_orgId: string, digest: Digest): Promise<boolean> {
    return this.rows.has(digest);
  }
}

const ORG_ID = "org_ds4_verify";
const EVENTS = { append: async () => {} };

function realCatalogAdapter(): WebDesignTargetAdapter {
  return new WebDesignTargetAdapter({
    designSystemId: "system_web",
    releaseId: "release_web_1",
    tokens: resolveDtcgTokens({
      color: {
        background: { $type: "color", $value: "#ffffff" },
        border: { $type: "color", $value: "#d0d5dd" },
        foreground: { $type: "color", $value: "#101828" },
        muted: { $type: "color", $value: "#f2f4f7" },
        primary: { $type: "color", $value: "#155eef" },
      },
      radius: { md: { $type: "dimension", $value: "0.375rem" } },
      space: { md: { $type: "dimension", $value: "0.5rem" } },
    }),
  });
}

async function realBuildAndScenarios() {
  const adapter = realCatalogAdapter();
  const build = adapter.buildArtifact({
    artifactId: "artifact_web_1",
    contractDigest: `sha256:${"a".repeat(64)}`,
    plainReleaseDigest: `sha256:${"b".repeat(64)}`,
    polishedReleaseDigest: `sha256:${"c".repeat(64)}`,
    fragmentLineage: [],
  });
  const profile = { target: "web-react", capabilities: [] };
  const vfs = await adapter.materialize([], await adapter.bootstrapPlainSystem(profile));
  const scenarios = await adapter.renderScenarioMatrix(vfs, profile);
  return { build, scenarios };
}

describe("verifyComposedDesignSystemRender — the production render+judge pass", () => {
  it("REAL ds-2 catalog + an ENFORCED posture → passed (the harness+oracle actually run; radix excluded)", async () => {
    const { build, scenarios } = await realBuildAndScenarios();
    const verification = await verifyComposedDesignSystemRender({
      orgId: ORG_ID,
      projectId: "project_ds4_verify",
      eventStore: EVENTS,
      cas: new InMemoryContentStore(),
      build,
      scenarios,
      accessibilityPosture: { standard: "wcag-2.2-aa", notes: "" },
      designContractVersion: "3",
    });
    // The Button rendered browser-free and cleared AA; the radix components could not bundle
    // browser-free and were excluded (the render-worker sub-node's job), never a spurious block.
    expect(verification.outcome).toBe("passed");
    expect(verification.passedCount).toBeGreaterThan(0);
    expect(verification.failedCount).toBe(0);
    expect(verification.excludedCount).toBeGreaterThan(0);
    expect(verification.accessibilityStandard).toBe("wcag-2.2-aa");
  }, 30_000);

  it("posture 'none' → not_applicable WITHOUT rendering (advisory design never blocks)", async () => {
    const { build, scenarios } = await realBuildAndScenarios();
    const cas = new InMemoryContentStore();
    const verification = await verifyComposedDesignSystemRender({
      orgId: ORG_ID,
      projectId: "project_ds4_verify",
      eventStore: EVENTS,
      cas,
      build,
      scenarios,
      accessibilityPosture: { standard: "none", notes: "" },
      designContractVersion: "3",
    });
    expect(verification.outcome).toBe("not_applicable");
    expect(verification.checkpoints).toHaveLength(0);
    // Short-circuited: nothing was rendered/stored.
    expect(cas.rows.size).toBe(0);
  });

  it("a component with a REAL a11y defect (img with no alt) + an enforced posture → failed_visual", async () => {
    // A synthetic build whose sole catalog component has a real axe violation, driven through
    // the REAL harness+oracle — proving the producer's failure path is a real verdict.
    const source = [
      'import * as React from "react";',
      'export const Badimg = () => React.createElement("img", { src: "logo.png" });',
      "",
    ].join("\n");
    const build = {
      catalog: { components: [{ key: "badimg", sourcePath: "components/ui/badimg.tsx" }] },
      files: [{ path: "components/ui/badimg.tsx", bytes: new TextEncoder().encode(source) }],
    };
    const scenarios = [
      {
        scenarioKey: "badimg:light:desktop:en-US",
        component: "badimg",
        theme: "light",
        viewport: "desktop",
        locale: "en-US",
      },
    ];
    const verification = await verifyComposedDesignSystemRender({
      orgId: ORG_ID,
      projectId: "project_ds4_verify",
      eventStore: EVENTS,
      cas: new InMemoryContentStore(),
      build,
      scenarios,
      accessibilityPosture: { standard: "wcag-2.2-aa", notes: "" },
      designContractVersion: "3",
    });
    expect(verification.outcome).toBe("failed_visual");
    expect(verification.failingScenarioKey).toBe("badimg:light:desktop:en-US");
    expect(verification.failingRuleIds).toContain("image-alt");
  }, 30_000);

  it("an UNMAPPABLE posture (declared but unknown) → inconclusive_infrastructure (fail closed, never a pass)", async () => {
    const { build, scenarios } = await realBuildAndScenarios();
    const verification = await verifyComposedDesignSystemRender({
      orgId: ORG_ID,
      projectId: "project_ds4_verify",
      eventStore: EVENTS,
      cas: new InMemoryContentStore(),
      build,
      scenarios,
      accessibilityPosture: { standard: "apple-hig", notes: "" },
      designContractVersion: "3",
    });
    // Every rendered scenario is inconclusive (unknown bar); nothing verifiable → fail closed.
    expect(verification.outcome).toBe("inconclusive_infrastructure");
  }, 30_000);
});
