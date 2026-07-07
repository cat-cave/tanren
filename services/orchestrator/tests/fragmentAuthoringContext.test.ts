// F2 prompt-hardening: prior-fragments-lookup + product-context plumbing
// (fix/f2-prompt-hardening). Asserts:
//   - `FragmentAuthoringDeps.priorFragmentsLookup` is invoked ONCE per authoring
//     run (not per-fragment) and its result flows into each writer call.
//   - `FragmentAuthoringInput.productContext` flows unchanged into each writer call.
//   - A throwing `priorFragmentsLookup` degrades to an empty prior list rather
//     than failing the whole authoring run.
//
// The `then:` field on the behavior shape is BDD Given/When/Then vocabulary
// (mirroring the CaptureBehavior schema); the thenable-object lint does not apply.
/* eslint-disable unicorn/no-thenable */

import { describe, expect, it } from "vitest";
import {
  buildFragmentAuthoring,
  type FragmentAuthorer,
  type FragmentAuthorerInput,
  type FragmentAuthoringEvents,
  type FragmentPersistence,
  type FragmentSpec,
  type PriorFragment,
  type ProductContext,
} from "../src/engine/templates/index.js";
import type { CaptureLifecycle } from "../src/engine/forge/interview/index.js";
import { buildFakeFragmentAuthorer } from "./fixtures/fragmentAuthoring.js";

function lifecycle(): CaptureLifecycle {
  return {
    stack: "ts/pnpm",
    bootstrap: "pnpm install",
    tier1: "pnpm lint",
    tier2: "pnpm test",
    tier3: "pnpm test",
    build: "pnpm build",
    deploy: "fly deploy",
    upgrade: "",
    toolchain: [],
  };
}

function spec(kind: FragmentSpec["kind"], label: string): FragmentSpec {
  return { kind, label, id: `${kind}-${label}`, requiredContract: {} };
}

function noopEvents(): FragmentAuthoringEvents {
  return { async emit() {} };
}

function inMemoryPersistence(): FragmentPersistence {
  return {
    async createValidated(input) {
      return { fragmentId: `${input.orgId}:${input.spec.id}:1.0.0` };
    },
  };
}

/** A spy authorer that records every `FragmentAuthorerInput` it sees, then
 * delegates to the fake authorer so the run still validates + persists. */
function spyAuthorer(): { authorer: FragmentAuthorer; calls: FragmentAuthorerInput[] } {
  const calls: FragmentAuthorerInput[] = [];
  const real = buildFakeFragmentAuthorer();
  const authorer: FragmentAuthorer = async (input) => {
    calls.push(input);
    return real(input);
  };
  return { authorer, calls };
}

describe("buildFragmentAuthoring — priorFragmentsLookup + productContext plumbing", () => {
  it("calls priorFragmentsLookup ONCE per authoring run and threads the result into each writer call", async () => {
    const priorFragments: PriorFragment[] = [{ fragmentId: "org_a:addon-biome:1.0.0", kind: "addon", label: "biome" }];
    let lookupCalls = 0;
    const { authorer, calls } = spyAuthorer();
    const runner = buildFragmentAuthoring({
      authorer,
      persistence: inMemoryPersistence(),
      events: noopEvents(),
      priorFragmentsLookup: async (orgId) => {
        expect(orgId).toBe("org_a");
        lookupCalls += 1;
        return priorFragments;
      },
    });
    await runner({
      orgId: "org_a",
      actor: { userId: "u", orgId: "org_a", projectId: null, scopes: ["platform:admin"], source: "session" },
      missing: [spec("addon", "one"), spec("addon", "two")],
      lifecycle: lifecycle(),
    });
    // Lookup fired exactly once — the list is stable per authoring run.
    expect(lookupCalls).toBe(1);
    // Both writer calls saw the same priorFragments list threaded through.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.priorFragments).toEqual(priorFragments);
    expect(calls[1]?.priorFragments).toEqual(priorFragments);
  });

  it("omits priorFragments on the writer input when the lookup seam is not wired", async () => {
    const { authorer, calls } = spyAuthorer();
    const runner = buildFragmentAuthoring({
      authorer,
      persistence: inMemoryPersistence(),
      events: noopEvents(),
    });
    await runner({
      orgId: "org_a",
      actor: { userId: "u", orgId: "org_a", projectId: null, scopes: ["platform:admin"], source: "session" },
      missing: [spec("addon", "one")],
      lifecycle: lifecycle(),
    });
    expect(calls).toHaveLength(1);
    // The writer sees no priorFragments key (undefined ⇒ prompt omits the section).
    expect(calls[0]?.priorFragments).toBeUndefined();
  });

  it("omits priorFragments when the lookup returns an EMPTY list", async () => {
    const { authorer, calls } = spyAuthorer();
    const runner = buildFragmentAuthoring({
      authorer,
      persistence: inMemoryPersistence(),
      events: noopEvents(),
      priorFragmentsLookup: async () => [],
    });
    await runner({
      orgId: "org_a",
      actor: { userId: "u", orgId: "org_a", projectId: null, scopes: ["platform:admin"], source: "session" },
      missing: [spec("addon", "one")],
      lifecycle: lifecycle(),
    });
    expect(calls[0]?.priorFragments).toBeUndefined();
  });

  it("degrades to empty priorFragments when the lookup THROWS (non-fatal)", async () => {
    const { authorer, calls } = spyAuthorer();
    const runner = buildFragmentAuthoring({
      authorer,
      persistence: inMemoryPersistence(),
      events: noopEvents(),
      priorFragmentsLookup: async () => {
        throw new Error("db blip");
      },
    });
    // The run must succeed even when the lookup throws — prior fragments are a
    // hint-shaped enrichment, not load-bearing.
    const result = await runner({
      orgId: "org_a",
      actor: { userId: "u", orgId: "org_a", projectId: null, scopes: ["platform:admin"], source: "session" },
      missing: [spec("addon", "one")],
      lifecycle: lifecycle(),
    });
    expect(result.failedIds).toEqual([]);
    expect(calls[0]?.priorFragments).toBeUndefined();
  });

  it("passes productContext from the run input into every writer call unchanged", async () => {
    const productContext: ProductContext = {
      acceptanceCriteria: ["identity: link shortener with click counts"],
      personas: [{ name: "Owner", description: "creates links + reads stats", surface: "handheld" }],
      behaviors: [
        { persona: "Owner", title: "shorten a link", given: "session", when: "paste URL", then: "get short code" },
      ],
    };
    const { authorer, calls } = spyAuthorer();
    const runner = buildFragmentAuthoring({
      authorer,
      persistence: inMemoryPersistence(),
      events: noopEvents(),
    });
    await runner({
      orgId: "org_a",
      actor: { userId: "u", orgId: "org_a", projectId: null, scopes: ["platform:admin"], source: "session" },
      missing: [spec("addon", "one"), spec("db", "mongo")],
      lifecycle: lifecycle(),
      productContext,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.productContext).toEqual(productContext);
    expect(calls[1]?.productContext).toEqual(productContext);
  });

  it("omits productContext when the run input carries none", async () => {
    const { authorer, calls } = spyAuthorer();
    const runner = buildFragmentAuthoring({
      authorer,
      persistence: inMemoryPersistence(),
      events: noopEvents(),
    });
    await runner({
      orgId: "org_a",
      actor: { userId: "u", orgId: "org_a", projectId: null, scopes: ["platform:admin"], source: "session" },
      missing: [spec("addon", "one")],
      lifecycle: lifecycle(),
    });
    expect(calls[0]?.productContext).toBeUndefined();
  });
});
