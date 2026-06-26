// THE CURATED-TEMPLATE REGISTRY — UNIT TESTS (PR-C).
//
// Pins the matrix-hit registry's load-bearing contracts:
//   1. `canonicalizeStack` is the comparison normalizer — equivalent stack labels
//      collapse to the same key, dissimilar ones don't.
//   2. `lookupCurated` round-trips: a hit returns the entry; cosmetic differences in
//      the request label (case, whitespace, punctuation) still hit; a true miss
//      returns undefined.
//   3. `listCurated` is stable + deterministic across calls (the snapshot test
//      reads it; observability surfaces enumerate it).
//   4. Every curated entry composes through the production composer without
//      throwing — the registry NEVER carries an entry the composer would reject
//      (a dogfood-style structural assertion at the registry layer, so a broken
//      curated entry fails THIS test rather than only at the wiring point).

import { describe, expect, it } from "vitest";
import {
  canonicalizeStack,
  composeTemplate,
  CURATED_TEMPLATES,
  type CuratedTemplate,
  listCurated,
  loadFragmentLibrary,
  lookupCurated,
} from "../src/engine/templates/index.js";

describe("canonicalizeStack — comparison normalizer", () => {
  it("lowercases + collapses punctuation/whitespace to single spaces", () => {
    expect(canonicalizeStack("TS / PNPM + React-Router")).toBe("ts pnpm react router");
  });

  it("preserves periods (so `fly.io` stays one token, not `fly io`)", () => {
    expect(canonicalizeStack("Deploys to Fly.io")).toBe("deploys to fly.io");
  });

  it("collapses leading + trailing punctuation and trims", () => {
    expect(canonicalizeStack("   + + ts/pnpm + + ")).toBe("ts pnpm");
  });

  it("two cosmetic variations of the same stack canonicalize to the same key", () => {
    const a = canonicalizeStack("TS/PNPM + React Router + Prisma + PostgreSQL on Fly.io");
    const b = canonicalizeStack("  ts / pnpm , react router , prisma , postgresql on fly.io  ");
    expect(a).toBe(b);
  });

  it("two genuinely different stacks canonicalize to different keys", () => {
    expect(canonicalizeStack("ts/pnpm + React")).not.toBe(canonicalizeStack("ruby/bundler + Rails"));
  });

  it("an empty / all-punctuation input collapses to the empty string (a miss signal)", () => {
    expect(canonicalizeStack("")).toBe("");
    expect(canonicalizeStack("  + + + ")).toBe("");
  });
});

describe("lookupCurated — matrix-hit lookup", () => {
  it("a registered stack label hits its entry exactly", () => {
    const hit = lookupCurated("ts/pnpm + React Router + Prisma + PostgreSQL on Fly.io");
    expect(hit).toBeDefined();
    expect(hit?.id).toBe("ts-node-pnpm-react-router-prisma-postgres-fly");
    expect(hit?.config.runtime).toBe("node-pnpm");
    expect(hit?.config.frontend).toBe("react-router");
    expect(hit?.config.db).toBe("postgres-prisma");
    expect(hit?.config.deploy).toBe("fly");
  });

  it("the same stack with cosmetic differences ALSO hits (canonicalization)", () => {
    const upper = lookupCurated("TS/PNPM + REACT ROUTER + PRISMA + POSTGRESQL ON FLY.IO");
    const spaced = lookupCurated("  ts / pnpm , react router , prisma , postgresql on fly.io  ");
    const punct = lookupCurated("ts -- pnpm -- react-router -- prisma -- postgresql -- on -- fly.io");
    expect(upper?.id).toBe("ts-node-pnpm-react-router-prisma-postgres-fly");
    expect(spaced?.id).toBe("ts-node-pnpm-react-router-prisma-postgres-fly");
    expect(punct?.id).toBe("ts-node-pnpm-react-router-prisma-postgres-fly");
  });

  it("the ruby/bundler entry hits its curated id", () => {
    const hit = lookupCurated("ruby/bundler + Rails on Fly.io");
    expect(hit?.id).toBe("ruby-bundler-fly");
    expect(hit?.config.runtime).toBe("ruby-bundler");
    expect(hit?.config.deploy).toBe("fly");
  });

  it("a never-seen stack returns undefined (the agent-template-build fallback case)", () => {
    expect(lookupCurated("python/uv + FastAPI on Fly.io")).toBeUndefined();
    expect(lookupCurated("rust/cargo + axum on Render")).toBeUndefined();
    expect(lookupCurated("novel/pandoc")).toBeUndefined();
  });

  it("an empty/all-punctuation input returns undefined (never a phantom hit)", () => {
    expect(lookupCurated("")).toBeUndefined();
    expect(lookupCurated("   ")).toBeUndefined();
    expect(lookupCurated("   +++ +++   ")).toBeUndefined();
  });
});

describe("listCurated — stable enumeration", () => {
  it("returns every curated entry in stable id order across calls", () => {
    const first = listCurated();
    const second = listCurated();
    const ids = first.map((e) => e.id);
    const sortedIds = [...ids].sort();
    expect(ids).toEqual(sortedIds);
    // Stable across calls (object-identity-equivalent — same entries, same order).
    expect(second.map((e) => e.id)).toEqual(ids);
  });

  it("matches the raw CURATED_TEMPLATES source set (no entries dropped)", () => {
    const live = new Set(listCurated().map((e) => e.id));
    const source = new Set(CURATED_TEMPLATES.map((e) => e.id));
    expect(live).toEqual(source);
  });
});

describe("CURATED_TEMPLATES — every entry composes without throwing", () => {
  // The registry is the LIVE catalog the operator hits; an entry that fails to
  // compose is a broken matrix point. Run the production composer over every entry
  // and assert no throw. Catches a fragment removal that left a curated entry
  // dangling, an enum drift, etc. — without waiting for an apex run.
  for (const entry of CURATED_TEMPLATES) {
    it(`composes "${entry.id}" successfully`, async () => {
      const library = loadFragmentLibrary();
      const vfs = await composeTemplate(entry.config, library);
      // The composer's `assertBaseInvariantsHeld` already re-checked the base
      // invariants; assert the VFS is non-empty as a smoke check on top.
      const flat = vfs.toFlatMap();
      expect(Object.keys(flat).length).toBeGreaterThan(0);
      // The composer NEVER strips the base-protected files (the load-bearing
      // constraint); confirm at least one base file is present on every entry.
      expect(flat["justfile"]).toBeDefined();
      expect(flat[".tanren/ci.yml"]).toBeDefined();
    });
  }
});

describe("CURATED_TEMPLATES — uniqueness invariant", () => {
  it("every entry has a UNIQUE canonical stack key (the loader rejects duplicates)", () => {
    const seen = new Map<string, CuratedTemplate>();
    for (const entry of CURATED_TEMPLATES) {
      const key = canonicalizeStack(entry.stack);
      expect(key, `entry "${entry.id}" canonicalizes to the empty string`).not.toBe("");
      expect(seen.has(key), `duplicate canonical key "${key}" between "${entry.id}" and "${seen.get(key)?.id}"`).toBe(
        false,
      );
      seen.set(key, entry);
    }
  });

  it("every entry has a UNIQUE id (audit/observability key collision is a bug)", () => {
    const ids = CURATED_TEMPLATES.map((e) => e.id);
    expect(ids.length).toBe(new Set(ids).size);
  });
});
