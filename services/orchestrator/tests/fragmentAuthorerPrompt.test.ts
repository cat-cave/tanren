// F2 writer-prompt hardening (fix/f2-prompt-hardening). Pins the four
// enrichments the prompt builder adds over the historical schema-only prompt:
//   1. A REAL shipped fragment source (per slot kind) is embedded.
//   2. Slot-kind-specific standing guidance is present.
//   3. Prior org fragments render as a section iff non-empty.
//   4. Product context (acceptance / personas / behaviors) renders iff present.
// Plus: total prompt size stays under the defensive 25k-character cap.
//
// The `then:` field on the behavior shape is BDD Given/When/Then vocabulary
// (mirroring the CaptureBehavior schema); the thenable-object lint does not apply.
/* eslint-disable unicorn/no-thenable */

import { describe, expect, it } from "vitest";
import {
  buildFragmentAuthorerPrompt,
  FRAGMENT_AUTHORER_PROMPT_MAX_CHARS,
  FRAGMENT_EXEMPLARS,
  exemplarFor,
  type FragmentAuthorerInput,
  type FragmentSpec,
  type PriorFragment,
  type ProductContext,
} from "../src/engine/templates/index.js";
import { FragmentKind } from "../src/engine/templates/index.js";
import {
  RUNTIME_NODE_PNPM_OWNED_DEVDEPS,
  RUNTIME_NODE_PNPM_OWNED_FILES,
} from "../src/engine/templates/fragments/library/runtime-node-pnpm.js";
import type { CaptureLifecycle } from "../src/engine/forge/interview/index.js";

function lifecycle(): CaptureLifecycle {
  return {
    stack: "ts/pnpm",
    bootstrap: "pnpm install",
    tier1: "pnpm lint",
    tier2: "pnpm test",
    tier3: "pnpm build",
    build: "pnpm build",
    deploy: "fly deploy",
    upgrade: "",
    toolchain: [],
  };
}

function spec(kind: FragmentSpec["kind"], label: string): FragmentSpec {
  return { kind, label, id: `${kind}-${label}`, requiredContract: {} };
}

function baseInput(kind: FragmentSpec["kind"], label = "foo"): FragmentAuthorerInput {
  return { spec: spec(kind, label), lifecycle: lifecycle() };
}

describe("buildFragmentAuthorerPrompt — shipped exemplars (improvement #1)", () => {
  it("embeds the runtime-node-pnpm exemplar for a runtime slot", () => {
    const prompt = buildFragmentAuthorerPrompt(baseInput("runtime", "python"));
    expect(prompt).toContain("Shipped exemplar");
    expect(prompt).toContain("runtime-node-pnpm");
    // The exemplar body should carry the constrained-subset ops so the writer sees
    // the pattern (addPackageJsonDevDep + appendToJustfileTarget) inline.
    expect(prompt).toContain("addPackageJsonDevDep");
    expect(prompt).toContain("appendToJustfileTarget");
  });

  it("embeds the deploy-fly exemplar for a deploy slot", () => {
    const prompt = buildFragmentAuthorerPrompt(baseInput("deploy", "vercel"));
    expect(prompt).toContain("deploy-fly");
    expect(prompt).toContain("FLY_API_TOKEN");
    expect(prompt).toContain("fly.toml");
  });

  it("embeds the frontend-remix exemplar for a frontend slot", () => {
    const prompt = buildFragmentAuthorerPrompt(baseInput("frontend", "next"));
    expect(prompt).toContain("frontend-remix");
    expect(prompt).toContain("@remix-run/react");
    expect(prompt).toContain("app/root.tsx");
  });

  it("embeds the db-postgres-prisma exemplar for a db slot", () => {
    const prompt = buildFragmentAuthorerPrompt(baseInput("db", "mongo"));
    expect(prompt).toContain("db-postgres-prisma");
    expect(prompt).toContain("DATABASE_URL");
    expect(prompt).toContain("prisma/schema.prisma");
  });

  it("embeds the addon-docker exemplar for an addon slot", () => {
    const prompt = buildFragmentAuthorerPrompt(baseInput("addon", "biome"));
    expect(prompt).toContain("addon-docker");
    expect(prompt).toContain("Dockerfile");
  });

  it("embeds a backend-shaped exemplar for a backend slot (NOT the runtime fallback — Codex #7)", () => {
    const prompt = buildFragmentAuthorerPrompt(baseInput("backend", "hono"));
    expect(prompt).toContain("backend-fastify");
    expect(prompt).toContain("src/server.ts");
    // The backend exemplar does not teach the writer to INSTALL the test runner
    // (that's the runtime fragment's job). The exemplar's tests may IMPORT from
    // vitest — but must not addPackageJsonDevDep("vitest"). Asserted on the
    // exemplar SOURCE, not the full prompt (which mentions vitest in the
    // recognizer guidance).
    expect(exemplarFor("backend").source).not.toContain(`addPackageJsonDevDep("vitest"`);
  });

  it("embeds an auth-shaped exemplar for an auth slot (NOT the runtime fallback — Codex #7)", () => {
    const prompt = buildFragmentAuthorerPrompt(baseInput("auth", "clerk"));
    expect(prompt).toContain("auth-authjs");
    expect(prompt).toContain("AUTH_SECRET");
    // The auth exemplar body does not declare DATABASE_URL — asserted on the
    // exemplar SOURCE, not the full prompt (which mentions DATABASE_URL in the
    // owned-env-vars guidance).
    expect(exemplarFor("auth").source).not.toContain("DATABASE_URL");
    expect(exemplarFor("auth").source).not.toContain("prisma");
  });

  it("embeds an example-shaped exemplar for an example slot (NOT the runtime fallback — Codex #7)", () => {
    const prompt = buildFragmentAuthorerPrompt(baseInput("example", "linkshort"));
    expect(prompt).toContain("example-todo");
    expect(prompt).toContain("src/example/todo.ts");
  });

  it("exposes an exemplar for every FragmentKind (no missing coverage)", () => {
    for (const kind of FragmentKind.options) {
      expect(exemplarFor(kind).fragmentId.length).toBeGreaterThan(0);
      expect(exemplarFor(kind).source).toContain("Fragment");
    }
    // Same via the exported map.
    expect(Object.keys(FRAGMENT_EXEMPLARS).length).toBeGreaterThanOrEqual(FragmentKind.options.length);
  });
});

describe("buildFragmentAuthorerPrompt — slot-kind guidance (improvement #2)", () => {
  it("emits a slot-kind guidance section for every kind", () => {
    for (const kind of FragmentKind.options) {
      const prompt = buildFragmentAuthorerPrompt(baseInput(kind, "foo"));
      expect(prompt).toContain(`## Slot-kind guidance (for ${kind} fragments)`);
    }
  });

  it("guidance is tailored per kind — a runtime prompt talks toolchain, a deploy prompt talks provider tokens", () => {
    const runtimePrompt = buildFragmentAuthorerPrompt(baseInput("runtime", "python"));
    expect(runtimePrompt).toContain("LANGUAGE TOOLCHAIN");
    expect(runtimePrompt).toContain("testRunner");

    const deployPrompt = buildFragmentAuthorerPrompt(baseInput("deploy", "vercel"));
    expect(deployPrompt).toContain("DELIVERY TARGET");
    expect(deployPrompt).toContain("Provider token env vars");

    const dbPrompt = buildFragmentAuthorerPrompt(baseInput("db", "mongo"));
    expect(dbPrompt).toContain("PERSISTENCE LAYER");
    expect(dbPrompt).toContain("dbMigrationsDir");

    const frontendPrompt = buildFragmentAuthorerPrompt(baseInput("frontend", "next"));
    expect(frontendPrompt).toContain("CLIENT SURFACE");

    const backendPrompt = buildFragmentAuthorerPrompt(baseInput("backend", "hono"));
    expect(backendPrompt).toContain("SERVER SURFACE");

    const authPrompt = buildFragmentAuthorerPrompt(baseInput("auth", "clerk"));
    expect(authPrompt).toContain("SESSION / IDENTITY LAYER");

    const addonPrompt = buildFragmentAuthorerPrompt(baseInput("addon", "biome"));
    expect(addonPrompt).toContain("CROSS-CUTTING CONCERN");

    const examplePrompt = buildFragmentAuthorerPrompt(baseInput("example", "todo"));
    expect(examplePrompt).toContain("SEEDS a product-specific example");
  });
});

// DRIFT GUARD (apex v81 audit). The RUNTIME-OWNED collision guidance is DERIVED from
// runtime-node-pnpm.ts's exported single-source-of-truth sets. If a future runtime
// change adds an owned file or devDep and the guidance goes stale, the F2 writer
// would author a colliding fragment that stalls at the compose gate (the v81 halt
// class). This test fails loudly on any drift.
describe("buildFragmentAuthorerPrompt — runtime-owned collision guard (drift-proof)", () => {
  // The non-runtime, non-base kinds are the ones that can COLLIDE with the runtime
  // (they compose alongside it). Every one must carry the full owned-files/deps list.
  const COLLISION_PRONE_KINDS = FragmentKind.options.filter((k) => k !== "runtime" && k !== "base");

  it("names EVERY runtime-owned FILE in the guidance for each collision-prone kind", () => {
    expect(RUNTIME_NODE_PNPM_OWNED_FILES.length).toBeGreaterThan(0);
    for (const kind of COLLISION_PRONE_KINDS) {
      const prompt = buildFragmentAuthorerPrompt(baseInput(kind, "foo"));
      expect(prompt).toContain("RUNTIME-OWNED files + devDeps");
      for (const file of RUNTIME_NODE_PNPM_OWNED_FILES) {
        expect(prompt, `${kind} prompt must name runtime-owned file ${file}`).toContain(file);
      }
    }
  });

  it("names EVERY runtime-owned DEVDEP (with its version) in the guidance for each collision-prone kind", () => {
    expect(Object.keys(RUNTIME_NODE_PNPM_OWNED_DEVDEPS).length).toBeGreaterThan(0);
    for (const kind of COLLISION_PRONE_KINDS) {
      const prompt = buildFragmentAuthorerPrompt(baseInput(kind, "foo"));
      for (const [dep, version] of Object.entries(RUNTIME_NODE_PNPM_OWNED_DEVDEPS)) {
        expect(prompt, `${kind} prompt must name runtime-owned devDep ${dep}`).toContain(dep);
        expect(prompt, `${kind} prompt must pin ${dep}@${version}`).toContain(`${dep}@${version}`);
      }
    }
  });

  it("does NOT emit the runtime-owned collision section for the runtime slot itself (it IS the owner)", () => {
    const runtimePrompt = buildFragmentAuthorerPrompt(baseInput("runtime", "python"));
    expect(runtimePrompt).not.toContain("RUNTIME-OWNED files + devDeps");
  });

  it("steers the writer to the extends-overlay pattern instead of overwriting tsconfig.json", () => {
    const frontendPrompt = buildFragmentAuthorerPrompt(baseInput("frontend", "next"));
    expect(frontendPrompt).toContain("tsconfig.<label>.json");
    expect(frontendPrompt).toContain(`"extends": "./tsconfig.json"`);
  });

  it("tells the writer a package.json script cannot be added by a fragment (no addPackageJsonScript op)", () => {
    const dbPrompt = buildFragmentAuthorerPrompt(baseInput("db", "mongo"));
    expect(dbPrompt).toContain("no addPackageJsonScript");
    // The stale "(or package.json scripts)" phrasing must be gone.
    expect(dbPrompt).not.toContain("or package.json scripts");
  });
});

describe("buildFragmentAuthorerPrompt — prior org fragments (improvement #3)", () => {
  it("omits the prior-fragments section when the list is undefined", () => {
    const prompt = buildFragmentAuthorerPrompt(baseInput("runtime", "python"));
    expect(prompt).not.toContain("Prior successful fragments in this org");
  });

  it("omits the prior-fragments section when the list is empty", () => {
    const prompt = buildFragmentAuthorerPrompt({ ...baseInput("runtime", "python"), priorFragments: [] });
    expect(prompt).not.toContain("Prior successful fragments in this org");
  });

  it("renders each prior fragment id + kind + label when the list is non-empty", () => {
    const priorFragments: PriorFragment[] = [
      { fragmentId: "org_a:runtime-python:1.0.0", kind: "runtime", label: "python" },
      { fragmentId: "org_a:db-mongo:1.0.0", kind: "db", label: "mongo" },
    ];
    const prompt = buildFragmentAuthorerPrompt({ ...baseInput("addon", "biome"), priorFragments });
    expect(prompt).toContain("Prior successful fragments in this org");
    expect(prompt).toContain("id=org_a:runtime-python:1.0.0, kind=runtime, label=python");
    expect(prompt).toContain("id=org_a:db-mongo:1.0.0, kind=db, label=mongo");
  });

  it("truncates a very long prior-fragments list to keep the prompt bounded", () => {
    const priorFragments: PriorFragment[] = Array.from({ length: 100 }, (_, i) => ({
      fragmentId: `org_a:addon-x${i}:1.0.0`,
      kind: "addon",
      label: `x${i}`,
    }));
    const prompt = buildFragmentAuthorerPrompt({ ...baseInput("runtime", "python"), priorFragments });
    expect(prompt).toContain("Prior successful fragments in this org");
    expect(prompt).toContain("more, truncated for prompt size");
  });
});

describe("buildFragmentAuthorerPrompt — product context (improvement #4)", () => {
  it("omits the product-context section when the context is undefined", () => {
    const prompt = buildFragmentAuthorerPrompt(baseInput("db", "mongo"));
    expect(prompt).not.toContain("## Product context");
  });

  it("omits the product-context section when every field is empty", () => {
    const empty: ProductContext = { acceptanceCriteria: [], personas: [], behaviors: [] };
    const prompt = buildFragmentAuthorerPrompt({ ...baseInput("db", "mongo"), productContext: empty });
    expect(prompt).not.toContain("## Product context");
  });

  it("renders acceptance criteria + personas + behaviors when supplied", () => {
    const productContext: ProductContext = {
      acceptanceCriteria: [
        "identity: personal link shortener with click counts",
        "principle: minimalist admin surface",
      ],
      personas: [{ name: "Owner", description: "creates links + reads click stats", surface: "handheld" }],
      behaviors: [
        {
          persona: "Owner",
          title: "shorten a link",
          given: "an active session",
          when: "they paste a URL and tap Shorten",
          then: "a short code is generated and returned",
        },
      ],
    };
    const prompt = buildFragmentAuthorerPrompt({ ...baseInput("db", "mongo"), productContext });
    expect(prompt).toContain("## Product context");
    expect(prompt).toContain("identity: personal link shortener with click counts");
    expect(prompt).toContain("principle: minimalist admin surface");
    expect(prompt).toContain("Owner [handheld]: creates links + reads click stats");
    // The behavior line collapses given/when/then into a single readable string.
    expect(prompt).toContain("[Owner] shorten a link");
    expect(prompt).toContain("an active session");
    expect(prompt).toContain("they paste a URL");
  });
});

describe("buildFragmentAuthorerPrompt — size ceiling (defensive)", () => {
  it("stays under the FRAGMENT_AUTHORER_PROMPT_MAX_CHARS cap even under maximal inputs", () => {
    const productContext: ProductContext = {
      acceptanceCriteria: Array.from({ length: 40 }, (_, i) => `criterion-${i} — ${"lorem ipsum ".repeat(15)}`),
      personas: Array.from({ length: 20 }, (_, i) => ({
        name: `Persona${i}`,
        description: `role-${i} — ${"lorem ipsum ".repeat(12)}`,
        surface: "handheld",
      })),
      behaviors: Array.from({ length: 30 }, (_, i) => ({
        persona: `Persona${i % 20}`,
        title: `behavior ${i}`,
        given: "a session",
        when: "they act",
        then: "the outcome",
      })),
    };
    const priorFragments: PriorFragment[] = Array.from({ length: 50 }, (_, i) => ({
      fragmentId: `org_a:kind-label${i}:1.0.0`,
      kind: "addon",
      label: `label${i}`,
    }));
    const prompt = buildFragmentAuthorerPrompt({
      spec: spec("runtime", "python"),
      lifecycle: lifecycle(),
      priorFragments,
      productContext,
      previousAttempt: { bodyTs: "x".repeat(5000), rejection: "reject reason" },
    });
    expect(prompt.length).toBeLessThanOrEqual(FRAGMENT_AUTHORER_PROMPT_MAX_CHARS);
    expect(prompt.length).toBeLessThan(25_000);
  });
});

describe("buildFragmentAuthorerPrompt — previous-attempt block (unchanged behaviour)", () => {
  it("renders the previous-attempt block when present", () => {
    const prompt = buildFragmentAuthorerPrompt({
      ...baseInput("runtime", "python"),
      previousAttempt: { bodyTs: "not valid ts", rejection: "body parse rejected: missing default export" },
    });
    expect(prompt).toContain("## Previous attempt — rejected");
    expect(prompt).toContain("body parse rejected: missing default export");
  });

  it("omits the previous-attempt block on the first attempt", () => {
    const prompt = buildFragmentAuthorerPrompt(baseInput("runtime", "python"));
    expect(prompt).not.toContain("## Previous attempt — rejected");
  });
});
