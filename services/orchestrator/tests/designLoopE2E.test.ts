// PHASE-3 (road to apex v37) — the design-loop e2e READINESS eval harness (the design
// auditor's top recommendation): drive the WHOLE native design loop with CANNED model
// responses (no live LLM), asserting the loop CLOSES — authoring → injection → coverage
// + static-fidelity verification → re-drive — and that the no-org / no-contract paths
// no-op cleanly. The fixtures + the STORE-FAITHFUL `MemoryGraph` (one in-memory entity
// graph backing all three stores via their REAL SQL, so the design phase PERSISTS the
// contract the writer + oracle then read back via `getLatest`) live in
// `helpers/designLoopFixtures.ts`. The only fakes are the two LLM seams.
import { describe, expect, it } from "vitest";

import { type DesignOracleAnswer } from "../src/engine/answerers/schemas/index.js";
import { parseDesignContract } from "../src/engine/design/designContract.js";
import { type DesignAgentAnswer } from "../src/engine/design/designAgent.js";
import { runDesignPhase } from "../src/engine/design/designPhase.js";
import {
  designResolverActor,
  loadDesignContextBlock,
  renderDesignContractBlock,
  resolveDesignContext,
} from "../src/engine/design/designWriterContext.js";
import type { AnswererAdapter } from "../src/engine/providers/types.js";
import { DesignContractStore } from "../src/engine/repositories/designContracts.js";
import { runDesignOracleStage } from "../src/engine/workflow/designOracle/designOracle.js";
import {
  actor,
  actorRef,
  baselineSha,
  fakeDesignAgent,
  fakeOracleAdapter,
  MemoryGraph,
  neatlinkAgentAnswer,
  NEATLINK_BEHAVIORS,
  NEATLINK_PERSONAS,
  NEATLINK_SEED,
  ORG,
  PROJECT,
} from "./helpers/designLoopFixtures.js";

function newGraph(): MemoryGraph {
  return new MemoryGraph({ personas: NEATLINK_PERSONAS, behaviors: NEATLINK_BEHAVIORS });
}

// Run the AUTHORING phase against `graph` with the canned (or supplied) agent answer.
async function author(graph: MemoryGraph, answer = neatlinkAgentAnswer()) {
  return runDesignPhase({
    client: graph as never,
    orgId: ORG,
    projectId: PROJECT,
    agent: fakeDesignAgent(answer),
    actor,
    actorRef,
    seed: NEATLINK_SEED,
  });
}

// Run the VERIFICATION (oracle) stage against `graph` with the canned oracle verdict.
async function verify(graph: MemoryGraph, adapter: AnswererAdapter<DesignOracleAnswer>) {
  return runDesignOracleStage({
    client: graph as never,
    projectId: PROJECT,
    actor,
    actorRef,
    adapter,
    baselineSha,
    workspacePath: "/tmp/ws",
  });
}

describe("design loop e2e — the loop CLOSES (canned model responses, stateful graph)", () => {
  it("authors → injects → verifies (coverage + fidelity) → re-drives, through ONE persistence seam", async () => {
    const graph = newGraph();

    // ---- 1) AUTHORING: the design PHASE persists a versioned contract -------
    const phase = await author(graph);
    // Exhaustive coverage of the FULL behavior set (a dropped behavior would throw).
    expect(phase.behaviorsCovered).toBe(3);
    expect(phase.domain).toBe("saas-web");
    expect([...phase.record.contract.behaviorRefs].sort()).toEqual([
      "behavior_invite",
      "behavior_shorten",
      "behavior_stats",
    ]);
    // It really landed in the store as HEAD version 1 (read back through getLatest).
    const head = await DesignContractStore.getLatest(graph as never, PROJECT, "from_scratch", actorRef);
    expect(head?.version).toBe(1);
    expect(head?.contract.behaviorRefs.length).toBe(3);

    // ---- 2) INJECTION: the writer block carries identity/intent/dimensions +
    //         resolved personas + behavior acceptance-criteria ----------------
    const resolved = await resolveDesignContext(graph as never, head!, designResolverActor(ORG, PROJECT));
    const block = renderDesignContractBlock(resolved);
    expect(block).toContain("Design domain: saas-web");
    expect(block).toContain("a crisp, fast, trustworthy link console");
    expect(block).toContain("shorten + track links with zero ceremony");
    // Resolved personas (by NAME, not opaque id — the no-"assume admin" moat).
    expect(block).toContain("Member — shortens + shares links");
    expect(block).toContain("Admin — manages the team workspace");
    // Behavior acceptance-criteria (given/when/then), attributed to the persona name.
    expect(block).toContain("[Member] Shorten a link — given a long URL");
    expect(block).toContain("then the teammate joins the workspace");
    // Every declared dimension (domain-derived, persona-scoped).
    expect(block).toContain("Design tokens (tokens)");
    expect(block).toContain("Admin surface (admin-surface)");
    expect(block).toContain("Persona view: Admin");
    // The high-level loader yields the SAME block off the same head contract.
    const loaded = await loadDesignContextBlock({
      client: graph as never,
      orgScope: { kind: "org", orgId: ORG },
      projectId: PROJECT,
    });
    expect(loaded).toBe(block);

    // ---- 3) VERIFICATION: the oracle reads the SAME head contract, resolves
    //         its refs, and emits a coverage gap + a fidelity finding ---------
    const { adapter, prompts } = fakeOracleAdapter({
      verificationMode: "static-surface-inspection",
      findings: [
        {
          id: "coverage-stats",
          severity: "P1",
          title: "Click-stats surface missing",
          body: "behavior_stats (persona_member) has no stats table in the built output.",
          fixHint: "Add a click-stats table to the link detail.",
        },
        {
          id: "fidelity-tokens",
          severity: "P2",
          title: "Token palette drifts from the contract",
          body: "The components use four accent colors; the contract caps at two (persona_member).",
          fixHint: null,
        },
      ],
      summary: "Inspected the routes + components against the neatlink contract; checked all three behaviors.",
    });
    const oracle = await verify(graph, adapter);
    expect(oracle.hasContract).toBe(true);
    expect(oracle.contractVersion).toBe(1);
    expect(oracle.verificationMode).toBe("static-surface-inspection");
    // Findings normalized to the frozen Finding currency (fixHint:null → absent key).
    const coverage = oracle.findings.find((f) => f.id === "coverage-stats");
    const fidelity = oracle.findings.find((f) => f.id === "fidelity-tokens");
    expect(coverage?.severity).toBe("P1");
    expect(coverage?.fixHint).toBe("Add a click-stats table to the link detail.");
    expect(fidelity?.severity).toBe("P2");
    expect(fidelity && "fixHint" in fidelity).toBe(false);
    // The oracle resolved the contract's refs into its prompt (the moat checklist).
    expect(prompts[0]).toContain("The design domain is: saas-web");
    expect(prompts[0]).toContain("[behavior_invite] (persona persona_admin) Invite a teammate");

    // ---- 4) RE-DRIVE CURRENCY: every finding is a frozen `Finding` (P0–P3 +
    //         stable id) — the SAME shape auditor/demo emit into triage --------
    for (const f of oracle.findings) {
      expect(["P0", "P1", "P2", "P3"]).toContain(f.severity);
      expect(typeof f.id).toBe("string");
      expect(f.id.length).toBeGreaterThan(0);
    }
  });

  it("re-elaboration gap (#619): a behavior added AFTER derive surfaces a loud P2 finding", async () => {
    const graph = newGraph();
    await author(graph);
    // A NEW behavior arrives downstream — never covered by the once-at-derive contract.
    graph.addBehavior({
      id: "behavior_qr",
      personaId: "persona_member",
      title: "Generate a QR code",
      given: "a short link",
      when: "the member taps QR",
      thenOutcome: "a scannable QR code appears",
    });
    const { adapter } = fakeOracleAdapter({
      verificationMode: "static-surface-inspection",
      findings: [],
      summary: "Verified the designed behaviors; checked for behaviors added after design.",
    });
    const oracle = await verify(graph, adapter);
    const gap = oracle.findings.find((f) => f.id === "design-re-elaboration:project_neatlink:behavior_qr");
    expect(gap).toBeDefined();
    expect(gap?.severity).toBe("P2");
    expect(gap?.title).toContain("added after design");
    // The DESIGNED behaviors are NOT double-flagged as re-elaboration gaps.
    expect(oracle.findings.some((f) => f.id.includes("behavior_shorten"))).toBe(false);
    expect(oracle.findings.some((f) => f.id.includes("behavior_invite"))).toBe(false);
  });

  it("no-contract path no-ops cleanly (oracle never invoked; loader yields undefined) — not silently wrong", async () => {
    // No design phase ran — design_contracts is empty.
    const graph = newGraph();
    let oracleCalls = 0;
    const adapter: AnswererAdapter<DesignOracleAnswer> = {
      kind: "answerer",
      cli: "fake",
      authRef: "fake",
      async runAnswerer(o) {
        oracleCalls += 1;
        return o.outputSchema.parse({ verificationMode: "x", findings: [], summary: "x" });
      },
    };
    const oracle = await verify(graph, adapter);
    expect(oracle.hasContract).toBe(false);
    expect(oracle.findings).toEqual([]);
    expect(oracleCalls).toBe(0);
    // The writer-side loader also yields undefined (the writer simply gets no block).
    const block = await loadDesignContextBlock({
      client: graph as never,
      orgScope: { kind: "org", orgId: ORG },
      projectId: PROJECT,
    });
    expect(block).toBeUndefined();
  });

  it("no-org path: an unscopedPlatform run yields no writer block (never reads off the wrong scope)", async () => {
    const graph = newGraph();
    await author(graph);
    // Even WITH a persisted contract, an unscoped run resolves no entity graph → no block.
    const block = await loadDesignContextBlock({
      client: graph as never,
      orgScope: { kind: "unscopedPlatform" },
      projectId: PROJECT,
    });
    expect(block).toBeUndefined();
  });

  it("authoring is loud, not silent: a dropped behavior throws (the exhaustive-coverage moat)", async () => {
    const graph = newGraph();
    const base = neatlinkAgentAnswer();
    const dropped: DesignAgentAnswer = {
      ...base,
      coverage: base.coverage.filter((c) => c.behaviorId !== "behavior_invite"),
    };
    await expect(author(graph, dropped)).rejects.toThrow(/does not cover/u);
    // Nothing persisted — the loud throw fired BEFORE any contract version landed.
    const head = await DesignContractStore.getLatest(graph as never, PROJECT, "from_scratch", actorRef);
    expect(head).toBeUndefined();
  });

  it("the persisted contract round-trips through the schema (a valid, re-parseable HEAD)", async () => {
    const graph = newGraph();
    await author(graph);
    const head = await DesignContractStore.getLatest(graph as never, PROJECT, "from_scratch", actorRef);
    expect(head).toBeDefined();
    expect(() => parseDesignContract(head!.contract)).not.toThrow();
  });
});
