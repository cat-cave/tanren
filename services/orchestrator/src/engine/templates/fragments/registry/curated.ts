// CURATED MATRIX-HIT TEMPLATES (PR-C). The actual list `lookupCurated` indexes by
// canonical stack key (registry/index.ts:canonicalizeStack).
//
// HOW TO ADD AN ENTRY:
//   1. Confirm every fragment id the `TemplateConfig` references exists in
//      `library/index.ts` (`composeTemplate` THROWS on a missing registration).
//   2. Pick a STABLE, OPAQUE id (the audit / observability key); the convention is
//      `<runtime>-<frontend?>-<db?>-<deploy>`.
//   3. Pick a HUMAN stack label — the canonical form (lowercase + collapse-punct)
//      MUST be unique across the list (the index loader throws on a duplicate).
//   4. Run `pnpm vitest run services/orchestrator/tests/templateFragmentRegistry.test.ts`
//      to assert the lookup + dogfood compose accept the new entry.
//   5. Bump `tests/templateFragmentDogfood.test.ts`'s `CURATED_CONFIGS` if the entry
//      also benefits from snapshot review (the dogfood + the registry can carry
//      DIFFERENT lists — the dogfood is the snapshot review unit; the registry is
//      the LIVE lookup the operator hits).
//
// THE BASE/ NON-NEGOTIABLES RIDE EVERY ENTRY (the user's load-bearing constraint:
// "templates do not let users sidestep the things Tanren is opinionated on"). The
// `BASE_PROTECTED_FILES` re-check + `processCiYml` evidence-block fill + the mutation
// + functional-demo skeleton tests run on EVERY compose; an entry that tries to skip
// them throws at compose time. There is no opt-out knob.

import type { CuratedTemplate } from "./index.js";

/**
 * The TypeScript / pnpm + React Router + Prisma + PostgreSQL + Fly.io entry — the
 * apex live-validation default. Every selected fragment is registered in the
 * production `loadFragmentLibrary()` (see `library/index.ts`); the composer assembles
 * a complete, green-CI repo deterministically.
 */
const TS_NODE_REACT_PRISMA_FLY: CuratedTemplate = {
  id: "ts-node-pnpm-react-router-prisma-postgres-fly",
  stack: "ts/pnpm + React Router + Prisma + PostgreSQL on Fly.io",
  config: {
    slug: "ts-node-pnpm-react-router-prisma-postgres-fly",
    runtime: "node-pnpm",
    frontend: "react-router",
    db: "postgres-prisma",
    deploy: "fly",
    addons: [],
    examples: [],
  },
};

/**
 * The Ruby / Bundler + Fly.io entry. The runtime-ruby-bundler fragment ships the
 * RSpec + Cucumber + Stryker-shim structural surface base/ asserts; a first-class
 * Rails frontend fragment is a future authoring run away — the current curated entry
 * composes the proven ruby-bundler runtime + Fly deploy + no frontend yet. The
 * composer still produces a valid, base-invariant-passing template (a Ruby library /
 * API skeleton with the full Tanren contract surface).
 */
const RUBY_BUNDLER_FLY: CuratedTemplate = {
  id: "ruby-bundler-fly",
  stack: "ruby/bundler + Rails on Fly.io",
  config: {
    slug: "ruby-bundler-fly",
    runtime: "ruby-bundler",
    deploy: "fly",
    addons: [],
    examples: [],
  },
};

/**
 * The TypeScript / pnpm + Remix + Prisma + PostgreSQL + Fly.io entry — apex's most
 * commonly captured "ts/pnpm + Remix + Postgres + Fly" lifecycle. Wires the
 * frontend-remix fragment with the postgres-prisma DB fragment.
 */
const TS_NODE_REMIX_PRISMA_FLY: CuratedTemplate = {
  id: "ts-node-pnpm-remix-prisma-postgres-fly",
  stack: "ts/pnpm + Remix + Prisma + PostgreSQL on Fly.io",
  config: {
    slug: "ts-node-pnpm-remix-prisma-postgres-fly",
    runtime: "node-pnpm",
    frontend: "remix",
    db: "postgres-prisma",
    deploy: "fly",
    addons: [],
    examples: [],
  },
};

/**
 * The curated matrix-hit catalog. Add entries above + register them here.
 *
 * Each entry MUST:
 *   - reference only fragment ids registered in `library/index.ts`;
 *   - declare a `TemplateConfig` that parses through the zod schema (the strict shape);
 *   - canonicalize to a UNIQUE stack key (the registry loader throws on a collision).
 */
export const CURATED_TEMPLATES: readonly CuratedTemplate[] = [
  TS_NODE_REACT_PRISMA_FLY,
  TS_NODE_REMIX_PRISMA_FLY,
  RUBY_BUNDLER_FLY,
];

// KNOWN FUTURE WORK — entries this PR does not yet ship, documented here so the next
// PR-author has the canonical names + the gap they're filling. NOT exported as a
// registry entry (a placeholder would silently hit on a stack match without a real
// fragment behind it — fail-loud is better). Documented in comments so this list
// does not need an exported `KNOWN_FUTURE_WORK` constant nobody reads at runtime:
//
//   - `ruby-rails-postgres-fly` — a first-class Rails frontend + Postgres DB pairing.
//     Needs new `frontend-rails` + `db-postgres-ar` (ActiveRecord ORM) fragments +
//     an addon for the Rails-tier just hook fills (db:migrate, asset compile, etc).
//   - `ts-node-pnpm-next-postgres-fly` — Next.js instead of React Router. Needs a new
//     `frontend-next` fragment + a tsconfig/path overlay.
//   - `python-uv-fastapi-postgres-fly` — a Python runtime entirely (no fragment yet);
//     the runtime-id enum in `types.ts` does not yet declare a `python-uv` variant.
