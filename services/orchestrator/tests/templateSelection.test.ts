// Tanren-native templating (wave 3) — the Forge SELECTION unit tests.
//
// Proves the capability-query derivation + the scorer + the seed/from-scratch
// DECISION (templating-system.md §3), all as PURE functions over a FIXTURE
// validated template (no DB — the registry query is injected). Asserts:
//   (a) a matching validated template → selected (strong) + a seed reference;
//   (b) a degraded / unvalidated / stale-proof template → NEVER selected;
//   (c) no eligible candidate → "none" (would-create hook) — from-scratch;
//   (d) the scorer ranks capability overlap above channel/freshness tie-breakers;
//   (e) a fail-closed final freshness re-check rejects a stale top candidate;
//   (f) the seed scaffold authoring SHRINKS (instantiate, not author-from-scratch).
//
// FAKES ARE TEST FIXTURES ONLY: the registry query is an injected array, the clock
// is injected — the selection logic itself is the unit under test.

import { describe, expect, it, vi } from "vitest";
import {
  buildScaffoldDescription,
  buildSeedScaffoldAcceptanceCriteria,
  buildSeedScaffoldDescription,
  deriveCapabilityQuery,
  isProofFresh,
  isTemplateEligible,
  rankTemplates,
  selectTemplate,
  type SelectedTemplate,
  type TemplateRegistryQuery,
} from "../src/engine/forge/interview/index.js";
import type { Template, TemplateStatus } from "../src/engine/repositories/templates.js";
import type { CaptureLifecycle } from "../src/engine/forge/interview/types.js";
import type { TemplateValidationProof } from "../src/engine/templates/manifest.js";

const NOW = Date.parse("2026-06-09T00:00:00.000Z");

// A TS/pnpm/next lifecycle the project DECLARED (not a Tanren hardcode).
const TS_LIFECYCLE: CaptureLifecycle = {
  stack: "ts/pnpm/next",
  bootstrap: "pnpm install --frozen-lockfile",
  tier1: "pnpm lint && pnpm typecheck",
  tier2: "pnpm build && pnpm test",
  tier3: "pnpm ci",
  build: "pnpm build",
  deploy: "vercel deploy --prod",
};

function freshProof(overrides: Partial<TemplateValidationProof> = {}): TemplateValidationProof {
  return {
    positiveControlsPassed: true,
    negativeControls: { typecheck: "proven", lint: "proven", test: "proven", mutation: "proven" },
    auditorClean: true,
    validatedAt: "2026-06-01T00:00:00.000Z",
    validatedSha: "abc1234",
    ...overrides,
  };
}

// Build a fixture template row (the domain shape TemplateStore returns).
function template(opts: {
  id?: string;
  status?: TemplateStatus;
  channel?: "lts" | "nightly";
  runtime?: string;
  packageManager?: string;
  framework?: string;
  deployTarget?: string;
  proof?: TemplateValidationProof | null;
}): Template {
  const proof = opts.proof === undefined ? freshProof() : opts.proof;
  return {
    id: opts.id ?? "template_ts",
    orgId: "org_a",
    repoRef: "cat-cave/tanren-template-ts-next",
    status: opts.status ?? "validated",
    channel: opts.channel ?? "lts",
    manifest: {
      version: 1,
      stack: "ts-pnpm-next",
      channel: opts.channel ?? "lts",
      templateVersion: "1.0.0",
      provenance: { researchSources: ["https://nextjs.org"] },
      capabilities: {
        runtime: opts.runtime ?? "ts",
        packageManager: opts.packageManager ?? "pnpm",
        ...(opts.framework === undefined ? {} : { framework: opts.framework }),
        ...(opts.deployTarget === undefined ? {} : { deployTarget: opts.deployTarget }),
        gates: ["tier-1", "tier-2", "tier-3"],
        bdd: true,
        mutation: true,
        junit: true,
      },
      validationProof: proof,
    },
  };
}

const registry =
  (rows: ReadonlyArray<Template>): TemplateRegistryQuery =>
  async () =>
    rows;

describe("deriveCapabilityQuery · capability filter from the lifecycle", () => {
  it("derives the EQUIVALENCE-EXPANDED runtime set from the first stack token + restricts to seedable statuses", () => {
    const { query } = deriveCapabilityQuery(TS_LIFECYCLE);
    // The runtime filter is the language→runtime EQUIVALENCE set, not the bare token
    // — so a `ts` project matches a `node`-runtime template (never wrongly excludes).
    expect(query.runtimeAny).toContain("ts");
    expect(query.runtimeAny).toContain("node");
    // The bare `runtime` is NOT bound (the equivalence-expanded `runtimeAny` supersedes it).
    expect(query.runtime).toBeUndefined();
    expect(query.statuses).toEqual(["validated", "official"]);
    // channel is NOT bound (it is a scorer PREFERENCE, not a filter).
    expect(query.channel).toBeUndefined();
  });

  it("works for a never-seen / non-code stack (no hardcode — unaliased token maps to itself)", () => {
    const novel: CaptureLifecycle = {
      stack: "novel/pandoc",
      bootstrap: "pip install -r requirements.txt",
      tier1: "aspell check",
      tier2: "consistency-check",
      tier3: "full-review",
      build: "pandoc book.md -o book.epub",
      deploy: "publish-epub",
    };
    // An unaliased token expands to JUST itself — no spurious runtimes leak in.
    expect(deriveCapabilityQuery(novel).query.runtimeAny).toEqual(["novel"]);
  });
});

describe("isProofFresh / isTemplateEligible · fail-closed eligibility", () => {
  it("a null proof is never fresh nor eligible", () => {
    expect(isProofFresh(null, NOW)).toBe(false);
    expect(isTemplateEligible(template({ proof: null }), NOW)).toBe(false);
  });

  it("a proof past the freshness horizon is stale", () => {
    expect(isProofFresh(freshProof({ validatedAt: "2026-01-01T00:00:00.000Z" }), NOW)).toBe(false);
  });

  it("a proof with failed positive controls or a dirty audit is not fresh", () => {
    expect(isProofFresh(freshProof({ positiveControlsPassed: false }), NOW)).toBe(false);
    expect(isProofFresh(freshProof({ auditorClean: false }), NOW)).toBe(false);
  });

  it("a draft / degraded status is never eligible even with a fresh proof", () => {
    expect(isTemplateEligible(template({ status: "draft" }), NOW)).toBe(false);
    expect(isTemplateEligible(template({ status: "degraded" }), NOW)).toBe(false);
    expect(isTemplateEligible(template({ status: "validated" }), NOW)).toBe(true);
    expect(isTemplateEligible(template({ status: "official" }), NOW)).toBe(true);
  });
});

describe("rankTemplates · scorer", () => {
  it("ranks higher capability overlap above channel/freshness tie-breakers", () => {
    const full = template({ id: "full", framework: "next", deployTarget: "vercel" });
    const runtimeOnly = template({ id: "runtime_only", packageManager: "npm", channel: "lts" });
    const ranked = rankTemplates([runtimeOnly, full], TS_LIFECYCLE, "lts", NOW);
    expect(ranked[0]?.template.id).toBe("full");
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
  });

  it("a ts/pnpm project MATCHES a node-runtime template (language↔runtime equivalence)", () => {
    // The real created template declares its EXECUTION runtime ("node"), not the
    // language ("ts"). A `ts/pnpm` project must still match it — the §3 "never wrongly
    // excludes" contract. Before the equivalence fix this scored 0 on runtime → partial.
    const nodeTemplate = template({ id: "node_tmpl", runtime: "node", packageManager: "pnpm" });
    const ranked = rankTemplates([nodeTemplate], TS_LIFECYCLE, "lts", NOW);
    expect(ranked[0]?.template.id).toBe("node_tmpl");
    // runtime + packageManager both matched ⇒ at/above the STRONG threshold.
    expect(ranked[0]?.reasons).toContain("runtime:node");
    expect(ranked[0]?.reasons).toContain("packageManager:pnpm");
  });

  it("drops ineligible (degraded/unvalidated/stale) candidates entirely", () => {
    const good = template({ id: "good" });
    const degraded = template({ id: "degraded", status: "degraded" });
    const unvalidated = template({ id: "unvalidated", proof: null });
    const stale = template({ id: "stale", proof: freshProof({ validatedAt: "2025-01-01T00:00:00.000Z" }) });
    const ranked = rankTemplates([degraded, unvalidated, stale, good], TS_LIFECYCLE, "lts", NOW);
    expect(ranked.map((r) => r.template.id)).toEqual(["good"]);
  });
});

describe("selectTemplate · the decision (templating-system.md §3)", () => {
  it("a matching validated template → strong match → seed reference", async () => {
    const decision = await selectTemplate({
      lifecycle: TS_LIFECYCLE,
      registryQuery: registry([template({ id: "ts", framework: "next", deployTarget: "vercel" })]),
      actor: { kind: "operator" },
      now: NOW,
    });
    expect(decision.kind).toBe("strong");
    expect(decision.selected?.templateRef).toBe("ts");
    expect(decision.selected?.repoRef).toBe("cat-cave/tanren-template-ts-next");
    expect(decision.selected?.validationProof.validatedSha).toBe("abc1234");
  });

  it("a node-runtime template → STRONG match for a ts/pnpm project (equivalence, not exclusion)", async () => {
    const decision = await selectTemplate({
      lifecycle: TS_LIFECYCLE,
      registryQuery: registry([template({ id: "node_next", runtime: "node", packageManager: "pnpm" })]),
      actor: { kind: "operator" },
      now: NOW,
    });
    expect(decision.kind).toBe("strong");
    expect(decision.selected?.templateRef).toBe("node_next");
  });

  it("a runtime-only overlap (no pkg-mgr match) → partial match", async () => {
    const decision = await selectTemplate({
      lifecycle: TS_LIFECYCLE,
      // packageManager "npm" ≠ the lifecycle's "pnpm" → below the strong threshold.
      registryQuery: registry([template({ id: "ts_npm", packageManager: "npm" })]),
      actor: { kind: "operator" },
      now: NOW,
    });
    expect(decision.kind).toBe("partial");
    expect(decision.selected?.templateRef).toBe("ts_npm");
  });

  it("a degraded / unvalidated template is NOT selected → none (would-create)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const decision = await selectTemplate({
      lifecycle: TS_LIFECYCLE,
      registryQuery: registry([
        template({ id: "degraded", status: "degraded" }),
        template({ id: "draft", proof: null }),
      ]),
      actor: { kind: "operator" },
      now: NOW,
    });
    expect(decision.kind).toBe("none");
    expect(decision.selected).toBeUndefined();
    expect(decision.reasons).toContain("would-create");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("an EMPTY registry → none → from-scratch (the expected live default)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const decision = await selectTemplate({
      lifecycle: TS_LIFECYCLE,
      registryQuery: registry([]),
      actor: { kind: "operator" },
      now: NOW,
    });
    expect(decision.kind).toBe("none");
    warn.mockRestore();
  });

  it("a registry-query failure fails CLOSED to a blocked/from-scratch outcome", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const decision = await selectTemplate({
      lifecycle: TS_LIFECYCLE,
      registryQuery: async () => {
        throw new Error("db down");
      },
      actor: { kind: "operator" },
      now: NOW,
    });
    expect(decision.kind).toBe("blocked");
    expect(decision.selected).toBeUndefined();
    warn.mockRestore();
  });

  it("respects the channel preference (nightly canary opt-in)", async () => {
    const lts = template({ id: "lts", channel: "lts" });
    const nightly = template({ id: "nightly", channel: "nightly" });
    const decision = await selectTemplate({
      lifecycle: TS_LIFECYCLE,
      registryQuery: registry([lts, nightly]),
      actor: { kind: "operator" },
      channelPreference: "nightly",
      now: NOW,
    });
    expect(decision.selected?.templateRef).toBe("nightly");
  });
});

describe("seed scaffold authoring · the spec SHRINKS (vs from-scratch)", () => {
  const selected: SelectedTemplate = {
    templateRef: "template_ts",
    repoRef: "cat-cave/tanren-template-ts-next",
    validationProof: freshProof(),
  };

  it("the seed description instructs INSTANTIATE, not author-from-scratch", () => {
    const seed = buildSeedScaffoldDescription(TS_LIFECYCLE, selected, []);
    const scratch = buildScaffoldDescription(TS_LIFECYCLE);
    expect(seed).toContain("SEED FROM TEMPLATE");
    expect(seed).toContain("INSTANTIATE");
    expect(seed).toContain(selected.repoRef);
    // The from-scratch path tells the writer to scaffold real project code; the seed
    // path does NOT — it is shorter / instantiation-only.
    expect(scratch).toContain("Scaffold the actual PROJECT CODE");
    expect(seed).not.toContain("Scaffold the actual PROJECT CODE");
  });

  it("a partial match appends the adaptation criteria", () => {
    const adaptations = ["the project's `just deploy` ships to the chosen target"];
    const criteria = buildSeedScaffoldAcceptanceCriteria(selected, adaptations);
    expect(criteria.some((c) => c.includes("ships to the chosen target"))).toBe(true);
    // The base instantiation criteria are always present.
    expect(criteria.some((c) => c.includes("adapted onto the seed"))).toBe(true);
  });
});
