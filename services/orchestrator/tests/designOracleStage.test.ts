// Native design subsystem (WS-D4) — the design-oracle STAGE: reads the head
// DesignContract, RESOLVES its persona/behavior refs against the entity graph,
// invokes the answerer, and returns normalized findings. Proven with a fake
// QueryClient (routes the stores' SQL to rows) + a fake answerer adapter — no DB
// needed. Asserts the moat behaviors:
//   - behavior-coverage + persona-scoped fidelity findings flow through (normalized
//     to the frozen Finding currency, the SAME triage input as auditor/demo);
//   - resolution is STRICT — an unresolvable persona/behavior ref throws LOUDLY
//     (malformed graph state, never a silent skip);
//   - an ABSENT contract is an explicit empty state (never a defaulted contract);
//   - domain-general — the same stage drives a web AND a non-web contract.
//
// "then" in the faked behavior rows is the BDD Given/When/Then column vocabulary,
// not a thenable — the awaitable-object lint does not apply to these fixtures.
/* eslint-disable unicorn/no-thenable */
import { describe, expect, it, vi } from "vitest";

import type { ActorContext } from "../src/engine/../auth/schemas.js";
import { parseDesignContract, type DesignContractV1 } from "../src/engine/design/designContract.js";
import { type DesignOracleAnswer, DESIGN_ORACLE_ANSWER_SCHEMA_ID } from "../src/engine/answerers/schemas/index.js";
import type { AnswererAdapter } from "../src/engine/providers/types.js";
import { runDesignOracleStage } from "../src/engine/workflow/designOracle/designOracle.js";

const baselineSha = "b".repeat(40);
const ORG = "org_oracle";
const actor: ActorContext = {
  userId: "user_1",
  orgId: ORG,
  projectId: null,
  scopes: [],
  source: "session",
};
const actorRef = { kind: "operator" as const };

interface PersonaSeed {
  id: string;
  name: string;
  description: string;
}
interface BehaviorSeed {
  id: string;
  personaId: string;
  title: string;
}

// A fake QueryClient routing the three stores' SELECTs to seeded rows. The store
// SQL is matched loosely by the table name in the text; missing ids yield no row
// (so the store returns undefined → the stage throws, exercising loud-on-malformed).
function fakeClient(opts: {
  contract?: DesignContractV1;
  contractVersion?: number;
  personas?: PersonaSeed[];
  behaviors?: BehaviorSeed[];
}) {
  const personas = new Map((opts.personas ?? []).map((p) => [p.id, p]));
  const behaviors = new Map((opts.behaviors ?? []).map((b) => [b.id, b]));
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    async query(text: string, params?: unknown[]) {
      if (text.includes("FROM design_contracts")) {
        if (opts.contract === undefined) return { rows: [] };
        return {
          rows: [
            {
              id: "design_1",
              org_id: ORG,
              project_id: "project_1",
              version: opts.contractVersion ?? 1,
              domain: opts.contract.domain,
              contract: opts.contract,
            },
          ],
        };
      }
      if (text.includes("FROM personas")) {
        const id = (params?.[0] as string) ?? "";
        const p = personas.get(id);
        if (p === undefined) return { rows: [] };
        return {
          rows: [
            {
              id: p.id,
              scope: "org",
              org_id: ORG,
              project_id: null,
              name: p.name,
              description: p.description,
              metadata: {},
              created_at: now,
              updated_at: now,
            },
          ],
        };
      }
      if (text.includes("FROM behaviors")) {
        const id = (params?.[0] as string) ?? "";
        const b = behaviors.get(id);
        if (b === undefined) return { rows: [] };
        return {
          rows: [
            {
              id: b.id,
              persona_id: b.personaId,
              title: b.title,
              given: "g",
              when: "w",
              then: "t",
              description: null,
              metadata: {},
              created_at: now,
              updated_at: now,
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

// A fake answerer that records the prompt it received and returns a fixed verdict.
function fakeAdapter(verdict: DesignOracleAnswer): {
  adapter: AnswererAdapter<DesignOracleAnswer>;
  prompts: string[];
} {
  const prompts: string[] = [];
  const adapter: AnswererAdapter<DesignOracleAnswer> = {
    kind: "answerer",
    cli: "fake",
    authRef: "fake",
    async runAnswerer(o) {
      prompts.push(o.prompt);
      // The schema the stage selected must be the design-oracle schema.
      expect(o.outputSchema.name).toBe(DESIGN_ORACLE_ANSWER_SCHEMA_ID);
      return o.outputSchema.parse(verdict);
    },
  };
  return { adapter, prompts };
}

function webContract(): DesignContractV1 {
  return parseDesignContract({
    version: 1,
    domain: "saas-web",
    identity: "calm ops console",
    intent: "effortless under load",
    principles: ["no AI-slop"],
    constraints: [],
    personaRefs: ["persona_admin"],
    behaviorRefs: ["behavior_invite"],
    dimensions: [{ key: "tokens", label: "Tokens", intent: "restrained", guidance: "", personaRefs: [] }],
  });
}

describe("runDesignOracleStage", () => {
  it("resolves refs, drives the oracle, and returns normalized fidelity findings (the triage currency)", async () => {
    const { adapter, prompts } = fakeAdapter({
      verificationMode: "static-surface-inspection",
      findings: [
        {
          id: "coverage-invite",
          severity: "P1",
          title: "Invite flow has no designed surface",
          body: "behavior_invite (persona persona_admin) has no members/invite surface in the built output.",
          fixHint: null,
        },
      ],
      summary: "Inspected the routes + components against the contract; checked behavior_invite for persona_admin.",
    });
    const client = fakeClient({
      contract: webContract(),
      contractVersion: 3,
      personas: [{ id: "persona_admin", name: "Admin", description: "runs the org" }],
      behaviors: [{ id: "behavior_invite", personaId: "persona_admin", title: "Invite a teammate" }],
    });

    const result = await runDesignOracleStage({
      client,
      projectId: "project_1",
      actor,
      actorRef,
      adapter,
      baselineSha,
      timeoutMs: 1000,
      workspacePath: "/tmp/ws",
    });

    expect(result.hasContract).toBe(true);
    expect(result.contractVersion).toBe(3);
    expect(result.verificationMode).toBe("static-surface-inspection");
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0];
    expect(finding?.severity).toBe("P1");
    expect(finding?.id).toBe("coverage-invite");
    // normalizeFinding collapses fixHint:null to an ABSENT key (frozen Finding shape).
    expect(finding && "fixHint" in finding).toBe(false);
    // The resolved behavior + persona made it into the prompt (the moat checklist).
    expect(prompts[0]).toContain("[behavior_invite] (persona persona_admin) Invite a teammate");
    expect(prompts[0]).toContain("[persona_admin] Admin: runs the org");
  });

  it("returns an EXPLICIT empty state when the project has no contract (never a defaulted contract)", async () => {
    const { adapter } = fakeAdapter({ verificationMode: "x", findings: [], summary: "x" });
    const runAnswerer = vi.spyOn(adapter, "runAnswerer");
    const result = await runDesignOracleStage({
      client: fakeClient({}),
      projectId: "project_1",
      actor,
      actorRef,
      adapter,
      baselineSha,
      timeoutMs: 1000,
      workspacePath: "/tmp/ws",
    });
    expect(result.hasContract).toBe(false);
    expect(result.findings).toEqual([]);
    // No contract ⇒ the oracle is never invoked (no fabricated verification).
    expect(runAnswerer).not.toHaveBeenCalled();
  });

  it("throws LOUDLY when a contract behaviorRef does not resolve (malformed graph state, never a silent skip)", async () => {
    const { adapter } = fakeAdapter({ verificationMode: "x", findings: [], summary: "x" });
    const client = fakeClient({
      contract: webContract(),
      personas: [{ id: "persona_admin", name: "Admin", description: "runs the org" }],
      // behavior_invite is deliberately NOT seeded — the ref cannot resolve.
      behaviors: [],
    });
    await expect(
      runDesignOracleStage({
        client,
        projectId: "project_1",
        actor,
        actorRef,
        adapter,
        baselineSha,
        timeoutMs: 1000,
        workspacePath: "/tmp/ws",
      }),
    ).rejects.toThrow(/behaviorRef 'behavior_invite' does not resolve/u);
  });

  it("throws LOUDLY when a contract personaRef does not resolve", async () => {
    const { adapter } = fakeAdapter({ verificationMode: "x", findings: [], summary: "x" });
    const client = fakeClient({
      contract: webContract(),
      // persona_admin is deliberately NOT seeded — the ref cannot resolve.
      personas: [],
      behaviors: [{ id: "behavior_invite", personaId: "persona_admin", title: "Invite a teammate" }],
    });
    await expect(
      runDesignOracleStage({
        client,
        projectId: "project_1",
        actor,
        actorRef,
        adapter,
        baselineSha,
        timeoutMs: 1000,
        workspacePath: "/tmp/ws",
      }),
    ).rejects.toThrow(/personaRef 'persona_admin' does not resolve/u);
  });

  // DOMAIN-GENERAL: the SAME stage drives a non-web (novel-translation) contract.
  it("is domain-general — drives a non-web contract end-to-end", async () => {
    const novelContract = parseDesignContract({
      version: 1,
      domain: "novel-translation",
      identity: "austere literary classic",
      intent: "preserve the source register",
      principles: [],
      constraints: [],
      personaRefs: ["persona_reader"],
      behaviorRefs: ["behavior_chapter"],
      dimensions: [{ key: "typography", label: "Typography", intent: "classic serif", guidance: "", personaRefs: [] }],
    });
    const { adapter, prompts } = fakeAdapter({
      verificationMode: "prose-typography",
      findings: [],
      summary: "Read the chapter prose + the typographic styles against the contract.",
    });
    const client = fakeClient({
      contract: novelContract,
      personas: [{ id: "persona_reader", name: "Reader", description: "reads the translation" }],
      behaviors: [{ id: "behavior_chapter", personaId: "persona_reader", title: "Read a chapter" }],
    });
    const result = await runDesignOracleStage({
      client,
      projectId: "project_1",
      actor,
      actorRef,
      adapter,
      baselineSha,
      timeoutMs: 1000,
      workspacePath: "/tmp/ws",
    });
    expect(result.hasContract).toBe(true);
    expect(result.verificationMode).toBe("prose-typography");
    expect(result.findings).toEqual([]);
    expect(prompts[0]).toContain("The design domain is: novel-translation");
    expect(prompts[0]).toContain("[behavior_chapter] (persona persona_reader) Read a chapter");
  });

  it("fails LOUDLY when the answerer returns a malformed verdict (omitted findings)", async () => {
    const adapter: AnswererAdapter<DesignOracleAnswer> = {
      kind: "answerer",
      cli: "fake",
      authRef: "fake",
      async runAnswerer(o) {
        // Omit `findings` — the strict schema must reject this (loud).
        return o.outputSchema.parse({ verificationMode: "x", summary: "x" });
      },
    };
    const client = fakeClient({
      contract: webContract(),
      personas: [{ id: "persona_admin", name: "Admin", description: "runs the org" }],
      behaviors: [{ id: "behavior_invite", personaId: "persona_admin", title: "Invite a teammate" }],
    });
    await expect(
      runDesignOracleStage({
        client,
        projectId: "project_1",
        actor,
        actorRef,
        adapter,
        baselineSha,
        timeoutMs: 1000,
        workspacePath: "/tmp/ws",
      }),
    ).rejects.toThrow(/findings/u);
  });
});
