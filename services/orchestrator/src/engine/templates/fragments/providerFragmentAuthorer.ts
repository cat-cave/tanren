// Provider-backed fragment authorer (the real LLM seam) —
// docs/roadmap/templating-system.md F2.
//
// Adapts an `AnswererAdapter<FragmentAuthorerOutput>` into the `FragmentAuthorer`
// seam, mirroring the conversation/interview/discovery `wrapProvider*Answerer`
// pattern. Each `authorer(input)` call is ONE structured provider call returning
// `{ bodyTs }`. Production wires the allocating Forge answerer adapter (real LLM,
// real cost record, real per-run scoped credentials); tests use the
// `buildFakeFragmentAuthorer` deterministic fixture.
//
// WHY THE ANSWERER PATTERN (NOT THE WRITER PATTERN): a fragment body is a
// constrained-subset DECLARATIVE artifact (`apply(vfs, config)` calling a small
// typed set of `vfs.write/addPackageJsonDep/...` ops). It is INTERPRETED by
// `unifiedLibrary.ts:interpretOrgFragment` — never executed as raw TS in a
// workspace. The answerer (single-call, structured-output) is the right seam:
// it makes a real LLM call, returns parsed JSON, records cost/usage uniformly
// (the same path planner/checker/auditor/interview use). The writer pattern
// (workspace + diff capture + runner allocation) is OVERKILL — we don't need a
// workspace, a diff, or a runner; we need the LLM's structured body output.
//
// The fragment-authoring run still emits observable events through the
// `FragmentAuthoringEvents` seam (`fragment.authoring.{started,succeeded,failed}`),
// which `buildLiveRunFragmentAuthoring` wires into the durable event store —
// observable in the same run timeline as writer events.
//
// PROMPT HARDENING (fix/f2-prompt-hardening). The writer prompt combines FOUR
// improvements over the historical schema-only prompt:
//   1. A REAL shipped fragment source (per slot kind) — the writer sees the
//      constrained-subset body shape from an in-tree exemplar rather than a
//      6-line skeleton (fragmentAuthorerExemplars.ts).
//   2. Slot-kind-specific STANDING GUIDANCE (~15 lines per kind describing what
//      that kind is responsible for vs. what it must NOT touch).
//   3. PRIOR ORG FRAGMENTS context — if the author has previously validated
//      fragments in this org, the writer sees their ids/kinds/labels so it can
//      structurally align with what has worked before.
//   4. PRODUCT CONTEXT — the parent spec's acceptance criteria + personas +
//      behaviors so the writer can make domain-informed defaults (a db fragment
//      for "link shortener with click counts" models `links(id, url, clicks)`
//      roughly, not a generic `Item` table).

import { z } from "zod";
import { renderAnswererJsonSchema } from "../../answerers/schemas/index.js";
import type { AnswererAdapter } from "../../providers/types.js";
import { exemplarFor, truncateExemplar } from "./fragmentAuthorerExemplars.js";
import type {
  FragmentAuthorer,
  FragmentAuthorerInput,
  FragmentAuthorerOutput,
  ProductContext,
  PriorFragment,
} from "./fragmentAuthoringRun.js";
import type { FragmentKind } from "./types.js";

const STEP_SCHEMA_NAME = "tanren.fragment_authoring.v1";

// Defensive hard cap on the total prompt size (chars). The largest exemplar is
// ~8k chars; adding schema/rules/guidance/lifecycle/product/prior sections keeps
// us well under 25k even at the worst case (the `< 25000` test assertion pins
// this). If a future exemplar or expansion pushes over, the writer prompt tests
// fail loudly rather than silently sending a giant prompt.
export const FRAGMENT_AUTHORER_PROMPT_MAX_CHARS = 25_000;

// Cap on the prior-fragments list to prevent context bloat when an org has
// accumulated many validated fragments. The writer only needs the SHAPE of prior
// work, not an exhaustive catalog.
const PRIOR_FRAGMENTS_MAX = 20;

// Cap on the number of personas/behaviors we render in the product-context block.
// The writer needs enough to make domain-informed defaults, not a full user story map.
const PRODUCT_CONTEXT_ITEMS_MAX = 8;

// The strict structured-output schema the LLM must satisfy. `bodyTs` is the
// fragment's TypeScript source — a default-exported `Fragment` whose `apply()`
// body uses ONLY the constrained subset `unifiedLibrary.ts:interpretOrgFragment`
// parses. The smoke-composition validator rejects bodies that don't compose.
const FragmentAuthorerAnswer = z
  .object({
    bodyTs: z.string().min(20),
  })
  .strict();

// Slot-kind-specific standing guidance. ~15 lines per kind describing what the
// fragment is responsible for and what it must NOT touch (crossing that line
// causes conflicts with adjacent slots at compose time). The `base` kind never
// hits the F2 authoring path (it is the shipped skeleton), but we still emit
// guidance for completeness.
const SLOT_KIND_GUIDANCE: Readonly<Record<FragmentKind, readonly string[]>> = {
  base: [
    "The base fragment ships the project skeleton (justfile targets, .tanren/ci.yml,",
    "root layout). Runtime fragments never overwrite it; addons never touch it.",
  ],
  runtime: [
    "A RUNTIME fragment owns the LANGUAGE TOOLCHAIN:",
    "  - Language config file (`package.json` for node, `Gemfile` for ruby, etc).",
    "  - The test runner + its reporter (vitest with junit, RSpec, pytest, go test, …)",
    "    wired so the `.tanren/ci.yml` evidence block reads the report at the",
    "    contract-declared `reportPath`.",
    "  - Compiler/language config (`tsconfig.json`, `.python-version`, `Cargo.toml`, etc).",
    "  - `just tier-2` justfile hook that runs the test suite with the reporter.",
    "  - Runtime-lang dev-dependency declarations (typescript, vitest, rspec, …).",
    "MUST DECLARE: `contract.testRunner` + `contract.reportPath` (checked by",
    "processCiYml; a runtime fragment missing these is rejected at compose time).",
    "MUST NOT: declare product env vars owned by db/deploy/notify slots (see the",
    "OWNED ENV VARS section below), or ship an example table/model (that's the",
    "example fragment's job).",
  ],
  frontend: [
    "A FRONTEND fragment owns the CLIENT SURFACE:",
    "  - Routing config (React Router, Remix routes/, Next.js pages/, etc).",
    "  - Root layout / entry component (`app/root.tsx`, `src/main.tsx`, …).",
    "  - Framework-specific dev-server hook on `just dev` (vite, next dev, …).",
    "  - Framework build recipe on `just build` (when the frontend owns the build).",
    "  - Framework package deps (react, next, remix, svelte, …).",
    "  - AT LEAST ONE test asserting the root component / router mounts.",
    "MUST NOT: touch backend/server code (that's the backend fragment). Do not",
    "define API routes here — the frontend calls them, it does not own them.",
    "MUST DECLARE: `dependsOn: [runtime-<lang>-<pm>]` (the frontend cannot exist",
    "without the runtime that mounts its deps).",
  ],
  backend: [
    "A BACKEND fragment owns the SERVER SURFACE:",
    "  - Server framework wiring (express, fastify, hono, sinatra, django, …).",
    "  - Routing table + a health-check route.",
    "  - `just serve` justfile hook that starts the server.",
    "  - Framework package deps.",
    "  - AT LEAST ONE test hitting a route (structural).",
    "MUST NOT: touch client-side code (the frontend fragment owns that). Do not",
    "declare product env vars owned by the db/deploy/auth slots.",
    "MUST DECLARE: `dependsOn: [runtime-<lang>-<pm>]`.",
  ],
  db: [
    "A DB fragment owns the PERSISTENCE LAYER:",
    "  - ORM/query-builder config + schema file (prisma/schema.prisma, drizzle",
    "    schema, models.py, Elixir schemas, …).",
    "  - Migrations directory (empty gitkeep on first compose; the writer adds).",
    "  - Migration recipe on `just migrate` / reset recipe on `just db-reset`.",
    "  - The DATABASE URL env var (`DATABASE_URL`, `POSTGRES_URL`, `MONGO_URL`, …)",
    "    — the DB slot is the AUTHORITATIVE owner; no other slot declares it.",
    "  - AT LEAST ONE test proving the client instantiates.",
    "MUST DECLARE: `contract.dbMigrationsDir` (the composer's evidence block reads",
    "this to detect pending migrations).",
    "MUST NOT: set up the language test runner (that's the runtime fragment).",
  ],
  auth: [
    "An AUTH fragment owns the SESSION / IDENTITY LAYER:",
    "  - Auth provider config (Clerk, Auth0, Firebase Auth, NextAuth, Devise, …).",
    "  - Session/JWT setup + a protected-route helper.",
    "  - Provider dev-dependency declarations.",
    "  - AT LEAST ONE test asserting the auth helper is callable.",
    "MUST NOT: touch db schema (that's the db fragment's job — auth CONSUMES the",
    "db, it does not model the db). Do not declare the DATABASE_URL.",
  ],
  addon: [
    "An ADDON fragment is a CROSS-CUTTING CONCERN:",
    "  - Linter/formatter (biome, prettier, rubocop, ruff, …).",
    "  - Container recipe (Dockerfile + .dockerignore).",
    "  - CI helper (a fragment that fills a specific `just ci-*` niche).",
    "  - Observability wiring (logger config, tracer boot).",
    "Addons are IDEMPOTENT + NON-DISRUPTIVE — they do not overwrite files owned by",
    "runtime/frontend/backend/db slots. An addon that must set a runtime env var",
    "declares it under a NAMESPACED prefix (e.g. `BIOME_*`, `DOCKER_BUILDKIT`).",
    "MUST NOT: own any of the load-bearing product env vars.",
  ],
  example: [
    "An EXAMPLE fragment SEEDS a product-specific example (e.g. `example-todo.ts`,",
    "`example-link-shortener.ts`):",
    "  - Domain-typed source demonstrating the product's core behavior.",
    "  - Fixtures / seed data.",
    "  - A test that exercises the example end-to-end.",
    "  - Declarations for product-specific behaviors the interview surfaced.",
    "MUST NOT: overwrite runtime/frontend/backend/db config (the example COMPOSES",
    "with them). Product env vars declared here are for THIS example only.",
  ],
  deploy: [
    "A DEPLOY fragment owns the DELIVERY TARGET:",
    "  - Provider token env vars (`FLY_API_TOKEN`, `VERCEL_TOKEN`, …) — the deploy",
    "    slot is the AUTHORITATIVE owner; no other slot declares these.",
    "  - Deploy config file (`fly.toml`, `vercel.json`, `render.yaml`, …).",
    "  - Deploy recipe on `just deploy` (or the `deploy` justfile target).",
    "MUST NOT: touch runtime deps, add test-runner config, or modify the",
    "package.json scripts block. The deploy slot is the LAST phase at compose",
    "time — it may only ADD deploy-specific artifacts, not restructure the app.",
  ],
} as const;

export function buildFragmentAuthorerPrompt(input: FragmentAuthorerInput): string {
  const { spec, lifecycle, previousAttempt, priorFragments, productContext } = input;
  const contractJson = JSON.stringify(spec.requiredContract);
  const lines: string[] = [
    `You are authoring ONE Tanren template-fragment in TypeScript.`,
    ``,
    `## The fragment slot`,
    `kind:   ${spec.kind}`,
    `label:  ${spec.label}`,
    `id:     ${spec.id}`,
    `contract (the fragment body MUST declare this VERBATIM): ${contractJson}`,
    `  NOTE: the composer PERSISTS this contract as the source of truth. Declaring a`,
    `  different \`contract: {...}\` in the body is IGNORED at persistence time`,
    `  (Round-III M3). Copy the value above verbatim so the fragment TS source`,
    `  parses and the persisted contract matches what the composer expects.`,
    ``,
    `## The project lifecycle (context for what stack the fragment serves)`,
    `stack:     ${lifecycle.stack}`,
    `bootstrap: ${lifecycle.bootstrap}`,
    `build:     ${lifecycle.build}`,
    `deploy:    ${lifecycle.deploy}`,
  ];

  // Product context — the parent spec's acceptance criteria + personas + behaviors
  // when the derive path carries them. Absent (all fields undefined/empty) ⇒ the
  // section is OMITTED cleanly so tests / non-derive callers don't pay for empty
  // headings.
  const productSection = renderProductContext(productContext);
  if (productSection.length > 0) {
    lines.push(``, ...productSection);
  }

  lines.push(
    ``,
    `## Slot-kind guidance (for ${spec.kind} fragments)`,
    ...SLOT_KIND_GUIDANCE[spec.kind],
    ``,
    `## What you must produce`,
    `Return JSON \`{ "bodyTs": "<string>" }\` where bodyTs is the TypeScript source`,
    `for a module that DEFAULT-EXPORTS a \`Fragment\` value. The module must:`,
    ``,
    `  1. Declare \`export const fragment: Fragment = { id, version, kind, contract, async apply(vfs, config) { ... } };\``,
    `     followed by \`export default fragment;\``,
    `  2. The \`apply\` block may ONLY call the constrained-subset vfs operations:`,
    `     - vfs.write("path", "content")             — create a brand-new file`,
    `     - vfs.overwrite("path", "content")          — replace an existing file (rare)`,
    `     - vfs.addPackageJsonDep("name", "version")  — register a runtime dep`,
    `     - vfs.addPackageJsonDevDep("name", "version") — register a dev dep`,
    `     - vfs.addEnvVar("KEY", "example-value")     — declare an env var`,
    `     - vfs.appendToJustfileTarget("target", ["line1", "line2"]) — fill a justfile hook`,
    `  3. NO other code in apply() — no conditionals, no loops, no fs/exec/http,`,
    `     no string concatenation in arguments. Each call must be one statement on`,
    `     its own line with literal string / array arguments. The parser is strict;`,
    `     bodies that step outside this subset are rejected at registration.`,
    `  4. Use ONLY string literals (double-quoted) and array literals as call`,
    `     arguments. Template literals (backticks) are also accepted for multi-line`,
    `     content. Do not interpolate.`,
    `  5. If your contract declares \`testRunner\` + \`reportPath\` (runtime fragments),`,
    `     wire the test runner via package.json deps + a vfs.write of the runner`,
    `     config + a vfs.appendToJustfileTarget("tier-2", [...]) call.`,
    `  6. DO NOT declare env vars whose ownership belongs to a downstream`,
    `     db/deploy/notification fragment. The composer applies fragments in phase`,
    `     order (runtime → frontend → backend → db → auth → addons → examples →`,
    `     deploy), and the db-*/deploy-*/notify-* fragments are the AUTHORITATIVE`,
    `     source for their owned URL/token shapes. Examples of OWNED env vars:`,
    `       - \`DATABASE_URL\`      — owned by db-* fragments (db-postgres-prisma etc)`,
    `       - \`REDIS_URL\`          — owned by db-redis / cache addons`,
    `       - \`FLY_API_TOKEN\`      — owned by deploy-fly`,
    `       - \`VERCEL_TOKEN\`       — owned by deploy-vercel`,
    `       - \`SLACK_BOT_TOKEN\`    — owned by notify-slack`,
    `     Only declare env vars for your fragment's OWN concerns (e.g.`,
    `     \`NEXT_PUBLIC_*\` framework vars, feature flags, or vars that no other`,
    `     fragment can plausibly own). A DIFFERENT-example conflict on the SAME`,
    `     key no longer halts compose (later-wins reconciles + warns), but the`,
    `     duplicate is still a workspace hazard — do not declare owned keys.`,
    ``,
    `## Test-file recognizer (LOAD-BEARING — the smoke composition rejects fragments`,
    `## that ship no meaningful functional test). Recognized test-file forms:`,
    ``,
    `  - TypeScript/JavaScript: \`tests/<name>.test.ts\` or \`tests/<name>.test.tsx\``,
    `    with at least one \`expect(...).toBe(<value>)\` / \`.toEqual({...})\` /`,
    `    \`.toContain(...)\` / etc. — truthy-only matchers like \`.toBe(true)\` do NOT count.`,
    `  - Ruby (RSpec): \`spec/<name>_spec.rb\` with at least one \`expect(...).to <matcher>\`.`,
    `  - Go: \`<any>/<name>_test.go\` at ANY depth (Go idiom co-locates tests with source).`,
    `    The file MUST contain \`func Test<Xxx>(t *testing.T)\` AND at least one of:`,
    `    \`t.Errorf(...)\` / \`t.Error(...)\` / \`t.Fatal(...)\` / \`t.Fatalf(...)\`, OR`,
    `    a bare \`if got != want { t.Errorf(...) }\` pattern, OR testify`,
    `    \`assert.Equal(t, ...)\` / \`assert.True(t, ...)\` / \`require.NoError(...)\` etc.`,
    `    A file that only calls \`t.Log(...)\` is REJECTED.`,
    `  - Python: \`test_<name>.py\` OR \`<name>_test.py\` at any depth (under \`tests/\`,`,
    `    \`test/\`, or co-located). The file MUST contain \`def test_<name>\` AND at`,
    `    least one of: a bare \`assert <expr>\` statement (pytest), OR a`,
    `    \`self.assertEqual(...)\` / \`self.assertTrue(...)\` / \`self.assertIn(...)\` /`,
    `    \`self.assertRaises(...)\` call (unittest).`,
    `  - Rust: \`tests/<name>.rs\` at the crate root (Rust integration tests). The`,
    `    file MUST contain a \`#[test]\` attribute AND at least one \`assert_eq!(...)\``,
    `    / \`assert!(...)\` / \`assert_ne!(...)\` / \`assert_matches!(...)\` macro.`,
    `  - Cucumber: \`features/<name>.feature\` with at least one \`Scenario:\` block.`,
    ``,
    `Author your runtime fragment to emit AT LEAST ONE test file in one of the`,
    `forms above with a meaningful assertion. Skeleton file-presence tests (a test`,
    `that only \`expect(fs.existsSync("foo")).toBeTruthy()\`s or a Go test that only`,
    `\`t.Log\`s) do NOT satisfy the recognizer and the smoke composition will reject`,
    `the fragment.`,
    ``,
  );

  // Real shipped exemplar for this slot kind (fragmentAuthorerExemplars.ts). The
  // writer sees a complete, in-tree, constrained-subset fragment shape rather than
  // a synthetic 6-line skeleton. The exemplar is a REFERENCE — the writer authors
  // for the CURRENT slot, not a paste of the exemplar.
  const exemplar = exemplarFor(spec.kind);
  lines.push(
    `## Shipped exemplar — a REAL in-tree fragment for a "${spec.kind}" slot (${exemplar.fragmentId})`,
    ``,
    `This is a SHIPPED, validated fragment. Follow this STRUCTURAL pattern (the`,
    `default export, the constrained-subset apply body, the extracted config`,
    `constants, the justfile-hook filling), but author the body for YOUR slot`,
    `(kind=${spec.kind}, label=${spec.label}) — do NOT paste this verbatim.`,
    ``,
    "```typescript",
    truncateExemplar(exemplar.source),
    "```",
    ``,
    `## Minimal skeleton (a fallback shape when you need to see the required top-level export):`,
    "```typescript",
    `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";`,
    `export const fragment: Fragment = {`,
    `  id: "${spec.id}",`,
    `  version: "1.0.0",`,
    `  kind: "${spec.kind}",`,
    `  contract: ${contractJson},`,
    `  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {`,
    `    vfs.write("path/to/file", "content");`,
    `  },`,
    `};`,
    `export default fragment;`,
    "```",
  );

  // Prior successful fragments in this org — the writer sees the SHAPE of what
  // has worked previously. Absent / empty ⇒ the section is OMITTED cleanly.
  const priorSection = renderPriorFragments(priorFragments);
  if (priorSection.length > 0) {
    lines.push(``, ...priorSection);
  }

  if (previousAttempt !== undefined) {
    lines.push(
      ``,
      `## Previous attempt — rejected`,
      `Your previous body was rejected by the validator. Here is what you produced and why it failed:`,
      ``,
      `### Previous bodyTs (truncated to 4000 chars)`,
      "```typescript",
      previousAttempt.bodyTs.slice(0, 4000),
      "```",
      ``,
      `### Rejection reason`,
      previousAttempt.rejection,
      ``,
      `Address the rejection directly in your next attempt. Do not repeat the same body.`,
    );
  }

  const rendered = lines.join("\n");
  if (rendered.length > FRAGMENT_AUTHORER_PROMPT_MAX_CHARS) {
    // Defensive: truncate the exemplar section further and re-render. In practice
    // this branch never fires under the current inputs (the largest exemplar is
    // ~8k chars and the full prompt lands ~15k), but we prefer a shorter prompt
    // over a runaway one on a future expansion.
    return rendered.slice(0, FRAGMENT_AUTHORER_PROMPT_MAX_CHARS) + "\n// … (prompt truncated at cap)\n";
  }
  return rendered;
}

function renderProductContext(context: ProductContext | undefined): readonly string[] {
  if (context === undefined) return [];
  const acceptance = context.acceptanceCriteria ?? [];
  const personas = context.personas ?? [];
  const behaviors = context.behaviors ?? [];
  if (acceptance.length === 0 && personas.length === 0 && behaviors.length === 0) return [];
  const out: string[] = [
    `## Product context (what the fragment is FOR)`,
    `Use this to make DOMAIN-INFORMED defaults — a db fragment for a "link shortener`,
    `with click counts" should model \`links(id, url, clicks)\` roughly, not a generic`,
    `\`Item\` table. An example fragment should seed one of the behaviors below.`,
  ];
  if (acceptance.length > 0) {
    out.push(`Acceptance criteria:`);
    for (const line of acceptance.slice(0, PRODUCT_CONTEXT_ITEMS_MAX)) {
      out.push(`  - ${truncateLine(line, 320)}`);
    }
  }
  if (personas.length > 0) {
    out.push(`Personas:`);
    for (const p of personas.slice(0, PRODUCT_CONTEXT_ITEMS_MAX)) {
      const summary = p.description === "" ? "(no description)" : truncateLine(p.description, 200);
      const surface = p.surface !== undefined && p.surface !== "" ? ` [${p.surface}]` : "";
      out.push(`  - ${p.name}${surface}: ${summary}`);
    }
  }
  if (behaviors.length > 0) {
    out.push(`Behaviors:`);
    for (const b of behaviors.slice(0, PRODUCT_CONTEXT_ITEMS_MAX)) {
      const parts = [b.given, b.when, b.then].filter((s) => s !== undefined && s !== "").join(" · ");
      out.push(`  - [${b.persona}] ${b.title}${parts === "" ? "" : ` — ${truncateLine(parts, 240)}`}`);
    }
  }
  return out;
}

function renderPriorFragments(prior: readonly PriorFragment[] | undefined): readonly string[] {
  if (prior === undefined || prior.length === 0) return [];
  const out: string[] = [
    `## Prior successful fragments in this org`,
    `These fragments were validated + authored by this same pipeline. If your slot`,
    `matches one of these kinds, follow the structural pattern that worked:`,
  ];
  for (const p of prior.slice(0, PRIOR_FRAGMENTS_MAX)) {
    out.push(`  - id=${p.fragmentId}, kind=${p.kind}, label=${p.label}`);
  }
  if (prior.length > PRIOR_FRAGMENTS_MAX) {
    out.push(`  - … (${prior.length - PRIOR_FRAGMENTS_MAX} more, truncated for prompt size)`);
  }
  return out;
}

function truncateLine(line: string, max: number): string {
  if (line.length <= max) return line;
  return line.slice(0, max - 3) + "...";
}

export function wrapProviderFragmentAuthorer(adapter: AnswererAdapter<FragmentAuthorerOutput>): FragmentAuthorer {
  const jsonSchema = renderAnswererJsonSchema(FragmentAuthorerAnswer);
  return async (input: FragmentAuthorerInput): Promise<FragmentAuthorerOutput> => {
    return adapter.runAnswerer({
      prompt: buildFragmentAuthorerPrompt(input),
      outputSchema: {
        name: STEP_SCHEMA_NAME,
        jsonSchema,
        parse: (value): FragmentAuthorerOutput => {
          const parsed = FragmentAuthorerAnswer.parse(value);
          return { bodyTs: parsed.bodyTs };
        },
      },
    });
  };
}
