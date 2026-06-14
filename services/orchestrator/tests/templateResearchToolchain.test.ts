// apex-v34 — the template-creation RESEARCH path emits + threads the project
// TOOLCHAIN (environment-management.md §3 Layer 1).
//
// ROOT CAUSE these tests pin: the just-in-time template-creation meta-flow builds a
// "template-build" Tanren project whose `CaptureLifecycle` carried a `stack` label +
// pnpm command strings but an EMPTY `toolchain` ([]). So no `mise.toml` was
// materialized, the workspace-prep mise-install step skipped, and `just bootstrap`
// failed (`pnpm: not found`, exit 127) because the runner ships NO project toolchain.
//
// apex-v34 part 2: the toolchain is modeled as an ARRAY of {name, version}, NOT a
// keyed record. A `z.record(z.string().regex(...), …)` rendered to JSON Schema with
// `propertyNames` (from the key regex) + an open record, which OpenAI strict
// structured outputs REJECT (HTTP 400 `'propertyNames' is not permitted`) — failing
// the research answerer (`tanren.template_research.v1`) and the interview architecture
// answerer. The array of fixed-shape objects renders strict-valid (see the schema test
// below).
//
// THE FIX (mirrors the interview architecture step, forge/interview/prompt.ts):
//   1. the research OUTPUT SCHEMA carries `toolchain` (a list of {name, version});
//   2. the research PROMPT instructs the model to emit it at CURRENT/LTS versions;
//   3. the orchestration mapping threads it onto `ResearchedLifecycle.toolchain`;
//   4. spec-authoring projects it onto the template-build `CaptureLifecycle.toolchain`
//      → the scaffold materializes a `mise.toml` → `mise install` provisions the stack.
//
// Tanren names NO stack here: the MODEL researches the tools+versions; these tests
// only assert the field is carried + threaded (with a representative ts/pnpm output).

import { describe, expect, it } from "vitest";
import { renderAnswererJsonSchema } from "../src/engine/answerers/schemas/index.js";
import { InterviewRoundOutput } from "../src/engine/forge/interview/types.js";
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
    toolchain: [
      { name: "node", version: "24" },
      { name: "pnpm", version: "11" },
    ],
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
  it("accepts a researched toolchain (list of {name, version}) on the lifecycle", () => {
    const parsed = ResearchOutput.parse(tsPnpmOutput);
    expect(parsed.lifecycle.toolchain).toEqual([
      { name: "node", version: "24" },
      { name: "pnpm", version: "11" },
    ]);
  });

  it("rejects a mise-unsafe tool name (would break the deterministic `[tools]` projection)", () => {
    expect(() =>
      ResearchOutput.parse({
        ...tsPnpmOutput,
        lifecycle: { ...tsPnpmOutput.lifecycle, toolchain: [{ name: "bad name", version: "1" }] },
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

// apex v34: the research path generated `pnpm install --frozen-lockfile` for `bootstrap`,
// which fails the cold checkout of the from-scratch template-build repo (no lockfile yet ⇒
// ERR_PNPM_NO_LOCKFILE), stranding the scaffold + halting the run. The interview prompt
// already carried this guidance (#496); the research prompt was the missing mirror. The
// research prompt MUST steer a fresh-repo-safe non-frozen bootstrap that generates +
// commits the lockfile.
// FRESH-TEMPLATES-START-AT-LATEST (environment-management.md §4.5/§7) — a model has a
// TRAINING CUTOFF, so without explicit steering a fresh template freezes the cutoff's
// versions into every project seeded from it (apex finding: a live run pinned node 24 +
// pnpm 10 when pnpm 11 was current). The research prompt MUST steer latest-by-default for
// BOTH the toolchain AND deps, while honoring the non-opinionated doctrine (a deliberate
// legacy pin is allowed when the brief requires it).
describe("research PROMPT steers LATEST versions (anti-training-cutoff freeze)", () => {
  it("instructs choosing the LATEST stable and NOT pinning to the training cutoff", () => {
    const prompt = buildResearchPrompt(request);
    const lower = prompt.toLowerCase();
    expect(lower).toContain("latest stable");
    expect(lower).toContain("training cutoff");
    // The non-opinionated escape hatch: a deliberate legacy/specific pin is allowed.
    expect(lower).toMatch(/legacy|specific|explicitly require/u);
  });

  it("the latest-version steering covers BOTH the toolchain AND the dependencies", () => {
    const lower = buildResearchPrompt(request).toLowerCase();
    // The guidance names both the toolchain (language/runtime/package-manager) and deps.
    expect(lower).toContain("toolchain");
    expect(lower).toContain("dependenc");
  });
});

// PART 3 — the AUTHORED `upgrade` verb must bump BOTH the toolchain (the mise pins) AND
// the deps. A deps-only `pnpm update --latest` leaves the node/pnpm pins in `mise.toml`
// stale. The prompt steers the model to author a verb covering both (Tanren names no
// command — it lives in the project's justfile).
describe("research PROMPT instructs the `upgrade` verb to cover the TOOLCHAIN, not just deps", () => {
  it("asks for an `upgrade` verb that bumps the toolchain pins AND the deps to latest", () => {
    const lower = buildResearchPrompt(request).toLowerCase();
    expect(lower).toContain("upgrade");
    // It must name BOTH the toolchain pins and the deps as the verb's scope.
    expect(lower).toMatch(/toolchain.*(and|both).*depend|both the toolchain/u);
    // A deps-only command is explicitly called out as WRONG.
    expect(lower).toContain("deps-only");
  });
});

// The research OUTPUT SCHEMA carries the `upgrade` verb so the model can actually emit it
// (it was previously read by the mapping but absent from the strict schema → not emittable).
describe("research OUTPUT SCHEMA carries the `upgrade` verb", () => {
  it("accepts a researched `upgrade` command on the lifecycle", () => {
    const parsed = ResearchOutput.parse({
      ...tsPnpmOutput,
      lifecycle: { ...tsPnpmOutput.lifecycle, upgrade: "mise upgrade --bump && mise install && pnpm update --latest" },
    });
    expect(parsed.lifecycle.upgrade).toBe("mise upgrade --bump && mise install && pnpm update --latest");
  });

  it("threads the researched `upgrade` verb onto the lifecycle (and stays absent when omitted)", async () => {
    const withUpgrade = wrapProviderResearcher(
      fakeResearchAdapter({
        ...tsPnpmOutput,
        lifecycle: {
          ...tsPnpmOutput.lifecycle,
          upgrade: "mise upgrade --bump && mise install && pnpm update --latest",
        },
      }),
    );
    const research = await withUpgrade.research(request);
    expect(research.lifecycle.upgrade).toBe("mise upgrade --bump && mise install && pnpm update --latest");

    const withoutUpgrade = wrapProviderResearcher(fakeResearchAdapter(tsPnpmOutput));
    expect((await withoutUpgrade.research(request)).lifecycle.upgrade).toBeUndefined();
  });
});

describe("research PROMPT instructs a fresh-repo-safe (non-frozen) bootstrap", () => {
  it("does NOT recommend a frozen/locked install for `bootstrap` (would brick the cold template repo)", () => {
    const prompt = buildResearchPrompt(request);
    // No frozen/locked install is RECOMMENDED as the bootstrap example.
    expect(prompt).not.toMatch(/'pnpm install --frozen-lockfile'/u);
    const lower = prompt.toLowerCase();
    // It steers a FRESH-REPO-SAFE bootstrap that writes the lockfile on a from-scratch repo,
    // and explicitly forbids a frozen/locked install on the first scaffold.
    expect(lower).toMatch(/fresh-repo-safe|fresh repo|clean checkout|cold checkout/u);
    expect(lower).toMatch(/writes the lockfile|generate the lockfile|generates the lockfile/u);
    expect(lower).toContain("do not use a frozen");
    expect(lower).toContain("--frozen-lockfile");
    // The generated lockfile is committed in the scaffold so later/CI installs reproduce.
    expect(lower).toMatch(/committed in the scaffold|commit/u);
  });

  it("instructs the test-report convention (a test tier writes a machine-readable report)", () => {
    const lower = buildResearchPrompt(request).toLowerCase();
    expect(lower).toContain("machine-readable report");
    expect(lower).toContain("test-report convention");
  });
});

describe("the researched toolchain threads onto the lifecycle + template-build capture", () => {
  it("`wrapProviderResearcher` carries a non-empty toolchain through to the lifecycle", async () => {
    const researcher = wrapProviderResearcher(fakeResearchAdapter(tsPnpmOutput));
    const research = await researcher.research(request);
    expect(research.lifecycle.toolchain).toEqual([
      { name: "node", version: "24" },
      { name: "pnpm", version: "11" },
    ]);
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
      lifecycle: {
        ...tsPnpmOutput.lifecycle,
        toolchain: [
          { name: "node", version: "24" },
          { name: "pnpm", version: "11" },
        ],
      },
      tooling: tsPnpmOutput.tooling,
      summary: tsPnpmOutput.summary,
    };
    const capture = authorTemplateBuildCapture(request, research);
    // The invariant: the template-build project ends up with a non-empty toolchain.
    expect(capture.lifecycle.toolchain).toEqual([
      { name: "node", version: "24" },
      { name: "pnpm", version: "11" },
    ]);
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
    expect(capture.lifecycle.toolchain).toEqual([]);
  });
});

// apex-v34 — the lifecycle is part of the research answerer's structured-output
// schema. A keyed-record `toolchain` rendered `propertyNames` (from its key regex),
// which OpenAI strict structured outputs REJECT (HTTP 400). The array-of-objects
// shape must render a strict-valid schema with NO `propertyNames` anywhere.
// Walk every node of a rendered JSON schema, collecting the paths where a
// `propertyNames` key appears (the strict-mode-forbidden record artifact).
function findPropertyNames(node: unknown, path: string): string[] {
  const hits: string[] = [];
  if (Array.isArray(node)) {
    node.forEach((item, i) => hits.push(...findPropertyNames(item, `${path}[${i}]`)));
    return hits;
  }
  if (typeof node !== "object" || node === null) return hits;
  const obj = node as Record<string, unknown>;
  if ("propertyNames" in obj) hits.push(path);
  for (const [key, value] of Object.entries(obj)) {
    hits.push(...findPropertyNames(value, `${path}.${key}`));
  }
  return hits;
}

// Locate the rendered toolchain node (an array whose items are {name, version}).
// The rendered lifecycle may be inlined or live under $defs/$ref — scan the whole
// schema for the FIRST `toolchain` property node, the array we reshaped.
function findToolchain(schema: Record<string, unknown>): Record<string, unknown> {
  const found: Record<string, unknown>[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const obj = node as Record<string, unknown>;
    const props = obj["properties"];
    if (props !== undefined && typeof props === "object" && props !== null) {
      const tc = (props as Record<string, unknown>)["toolchain"];
      if (tc !== undefined && typeof tc === "object" && tc !== null) {
        found.push(tc as Record<string, unknown>);
      }
    }
    for (const value of Object.values(obj)) visit(value);
  };
  visit(schema);
  const node = found[0];
  if (node === undefined) throw new Error("no `toolchain` property node found in the rendered schema");
  return node;
}

// A schema node whose `type` admits "array" (a bare `"array"` or a `["array","null"]`
// nullable widening the strict renderer applies to an optional field).
function typeIncludesArray(node: Record<string, unknown> | undefined): boolean {
  if (node === undefined) return false;
  const t = node["type"];
  return t === "array" || (Array.isArray(t) && t.includes("array"));
}

describe("the research answerer JSON schema is OpenAI-strict-valid (no propertyNames)", () => {
  it("renders NO `propertyNames` anywhere in the research output schema", () => {
    const schema = renderAnswererJsonSchema(ResearchOutput);
    const hits = findPropertyNames(schema, "$");
    expect(hits).toEqual([]);
  });

  it("renders NO `propertyNames` in the INTERVIEW round output schema (the other lifecycle answerer)", () => {
    // The interview architecture answerer ALSO emits a `CaptureLifecycle.toolchain` —
    // it must be strict-valid too. (The root-cause HTTP 400 broke both answerers.)
    const schema = renderAnswererJsonSchema(InterviewRoundOutput);
    expect(findPropertyNames(schema, "$")).toEqual([]);
  });

  it("renders the toolchain as an ARRAY of {name, version} objects (not an open record)", () => {
    const schema = renderAnswererJsonSchema(ResearchOutput);
    const toolchain = findToolchain(schema);
    // The reshaped toolchain. `toolchain` is strict-optional, so the renderer makes it
    // nullable — a scalar/array `type` widens to a `["array","null"]` type array (the
    // compact form), or an `anyOf:[<array>, {type:null}]` wrap. Resolve the array node.
    const arrayNode = typeIncludesArray(toolchain)
      ? toolchain
      : ((toolchain["anyOf"] as Record<string, unknown>[] | undefined)?.find((b) => typeIncludesArray(b)) ?? undefined);
    expect(arrayNode).toBeDefined();
    expect(typeIncludesArray(arrayNode)).toBe(true);
    // Its items are a fixed-shape object with `name` + `version` — strict mode requires
    // additionalProperties:false (enforced by renderAnswererJsonSchema). Crucially the
    // `name` mise-tool regex renders as a `pattern` on the STRING FIELD (permitted),
    // NOT a `propertyNames` on a record (which OpenAI strict mode rejects).
    const items = arrayNode?.["items"] as Record<string, unknown> | undefined;
    expect(items?.["type"]).toBe("object");
    expect(items?.["additionalProperties"]).toBe(false);
    const itemProps = items?.["properties"] as Record<string, unknown> | undefined;
    expect(Object.keys(itemProps ?? {}).sort()).toEqual(["name", "version"]);
    const nameField = itemProps?.["name"] as Record<string, unknown> | undefined;
    expect(typeof nameField?.["pattern"]).toBe("string");
  });
});
