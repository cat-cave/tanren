// apex-v34 — the template-creation RESEARCH path emits + threads the project
// TOOLCHAIN (environment-management.md §3 Layer 1).
//
// ROOT CAUSE these tests pin: the just-in-time template-creation meta-flow builds a
// "template-build" Tanren project whose `CaptureLifecycle` carried a `stack` label +
// pnpm command strings but an EMPTY `toolchain` ({}). So no `mise.toml` was
// materialized, the workspace-prep mise-install step skipped, and `just bootstrap`
// failed (`pnpm: not found`, exit 127) because the runner ships NO project toolchain.
//
// THE FIX (mirrors the interview architecture step, forge/interview/prompt.ts):
//   1. the research OUTPUT SCHEMA carries `toolchain` (a mise tool→version map);
//   2. the research PROMPT instructs the model to emit it at CURRENT/LTS versions;
//   3. the orchestration mapping threads it onto `ResearchedLifecycle.toolchain`;
//   4. spec-authoring projects it onto the template-build `CaptureLifecycle.toolchain`
//      → the scaffold materializes a `mise.toml` → `mise install` provisions the stack.
//
// Tanren names NO stack here: the MODEL researches the tools+versions; these tests
// only assert the field is carried + threaded (with a representative ts/pnpm output).

import { describe, expect, it } from "vitest";
import { renderMiseToml } from "../src/engine/forge/scaffold/skeleton.js";
import {
  authorTemplateBuildCapture,
  type TemplateCreationRequest,
  type TemplateResearch,
  wrapProviderResearcher,
} from "../src/engine/templates/index.js";
import { buildResearchPrompt } from "../src/engine/templates/creation/liveResearch.js";
import { ResearchOutput } from "../src/engine/templates/creation/researchSchema.js";
import type { AnswererAdapter } from "../src/engine/providers/types.js";

const request: TemplateCreationRequest = {
  stack: "ts-pnpm",
  runtime: "node",
  packageManager: "pnpm",
  deployTarget: "vercel",
};

// A representative ts/pnpm research output — note the populated `toolchain`, the
// thing whose absence was the apex-v34 bug.
const tsPnpmOutput: ResearchOutput = {
  researchSources: ["https://example.test/ts-best-practice"],
  lifecycle: {
    bootstrap: "pnpm install --frozen-lockfile",
    tier1: "pnpm lint && pnpm typecheck",
    tier2: "pnpm test",
    tier3: "pnpm test:e2e",
    build: "pnpm build",
    deploy: "pnpm deploy",
    toolchain: { node: "24", pnpm: "11" },
  },
  tooling: { typecheck: true, lint: true, test: true, mutation: false, junit: true, bdd: false },
  summary: "modern TS/pnpm",
};

function fakeResearchAdapter(output: ResearchOutput): AnswererAdapter<ResearchOutput> {
  return {
    kind: "answerer",
    cli: "fake",
    authRef: "test/research",
    async runAnswerer() {
      return ResearchOutput.parse(output);
    },
  };
}

describe("research OUTPUT SCHEMA carries the toolchain", () => {
  it("accepts a researched toolchain (mise tool→version) on the lifecycle", () => {
    const parsed = ResearchOutput.parse(tsPnpmOutput);
    expect(parsed.lifecycle.toolchain).toEqual({ node: "24", pnpm: "11" });
  });

  it("rejects a mise-unsafe tool name (would break the deterministic `[tools]` projection)", () => {
    expect(() =>
      ResearchOutput.parse({
        ...tsPnpmOutput,
        lifecycle: { ...tsPnpmOutput.lifecycle, toolchain: { "bad name": "1" } },
      }),
    ).toThrow(/mise tool name/u);
  });

  it("allows a stack with NO mise tool to omit toolchain (a pure-shell/system stack)", () => {
    const { toolchain: _drop, ...noToolchain } = tsPnpmOutput.lifecycle;
    const parsed = ResearchOutput.parse({ ...tsPnpmOutput, lifecycle: noToolchain });
    expect(parsed.lifecycle.toolchain).toBeUndefined();
  });
});

describe("research PROMPT instructs the model to emit the toolchain at current/latest", () => {
  it("asks for `toolchain` + mise + the anti-stale-version rule (mirrors the interview step)", () => {
    const prompt = buildResearchPrompt(request).toLowerCase();
    expect(prompt).toContain("toolchain");
    expect(prompt).toContain("mise");
    expect(prompt).toContain("current/lts");
    expect(prompt).toContain("never years-old");
  });
});

describe("the researched toolchain threads onto the lifecycle + template-build capture", () => {
  it("`wrapProviderResearcher` carries a non-empty toolchain through to the lifecycle", async () => {
    const researcher = wrapProviderResearcher(fakeResearchAdapter(tsPnpmOutput));
    const research = await researcher.research(request);
    expect(research.lifecycle.toolchain).toEqual({ node: "24", pnpm: "11" });
  });

  it("an omitted toolchain stays undefined through the mapping (no mise.toml for a no-tool stack)", async () => {
    const { toolchain: _drop, ...noToolchain } = tsPnpmOutput.lifecycle;
    const researcher = wrapProviderResearcher(fakeResearchAdapter({ ...tsPnpmOutput, lifecycle: noToolchain }));
    const research = await researcher.research(request);
    expect(research.lifecycle.toolchain).toBeUndefined();
  });

  it("a ts/pnpm research → a non-empty CaptureLifecycle.toolchain → a materialized mise.toml", () => {
    const research: TemplateResearch = {
      researchSources: tsPnpmOutput.researchSources,
      lifecycle: { ...tsPnpmOutput.lifecycle, toolchain: { node: "24", pnpm: "11" } },
      tooling: tsPnpmOutput.tooling,
      summary: tsPnpmOutput.summary,
    };
    const capture = authorTemplateBuildCapture(request, research);
    // The invariant: the template-build project ends up with a non-empty toolchain.
    expect(capture.lifecycle.toolchain).toEqual({ node: "24", pnpm: "11" });
    // ...so the scaffold renders a `mise.toml` `[tools]` table → `mise install` provisions
    // node+pnpm at workspace-prep, so `just bootstrap` (pnpm install) finds pnpm.
    const mise = renderMiseToml(capture.lifecycle.toolchain);
    expect(mise).toContain("[tools]");
    expect(mise).toContain("node");
    expect(mise).toContain("pnpm");
  });

  it("a no-mise-tool research → an EMPTY toolchain on the capture (Tanren invents no versions)", () => {
    const research: TemplateResearch = {
      researchSources: tsPnpmOutput.researchSources,
      lifecycle: {
        bootstrap: "make deps",
        tier1: "make lint",
        tier2: "make test",
        tier3: "make check",
        build: "make build",
        deploy: "make deploy",
        // no toolchain
      },
      tooling: { typecheck: false, lint: true, test: true, mutation: false, junit: false, bdd: false },
      summary: "pure-shell",
    };
    const capture = authorTemplateBuildCapture(request, research);
    expect(capture.lifecycle.toolchain).toEqual({});
  });
});
