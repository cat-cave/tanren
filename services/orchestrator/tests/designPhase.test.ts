// Native design subsystem (WS-D3) — the DESIGN PHASE + design AGENT. Proves the moat
// behaviors of the phase (designPhase.ts) that runs the agent (designAgent.ts) to
// ELABORATE the thin captured intent into the designed HEAD `DesignContract`:
//   (a) EXHAUSTIVE BEHAVIOR COVERAGE — every project behavior maps to a designed
//       surface in the persisted contract's `behaviorRefs`; an agent that DROPS a
//       behavior throws LOUDLY (a silently-incomplete contract is rejected);
//   (b) STRICT PERSONA RESOLUTION — the agent designs against the real personas; a
//       coverage/dimension ref to an unknown persona id throws (no dangling ref);
//   (c) DOMAIN-GENERAL across ≥2 domains — the agent derives the dimension set from
//       the domain (saas-web tokens/components vs a novel's typography/voice/cover);
//       the phase persists WHATEVER dimensions the agent chose, never web-baking;
//   (d) LOUD ON MALFORMED — an agent answer that fails the strict schema throws;
//   (e) PERSISTS THE HEAD VERSION — the elaborated contract is the version the writer
//       (WS-D2) + oracle (WS-D4) read via `getLatest`.

import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { parseDesignContract } from "../src/engine/design/designContract.js";
import {
  buildDesignAgentPrompt,
  wrapProviderDesignAgent,
  type DesignAgent,
  type DesignAgentInput,
} from "../src/engine/design/designAgent.js";
import { runDesignPhase } from "../src/engine/design/designPhase.js";
import type { DesignAgentAnswer } from "../src/engine/answerers/schemas/designAgent.js";

const ORG = "org_wsd3";
const PROJECT = "project_wsd3";

const ACTOR: ActorContext = {
  userId: "u_test",
  orgId: ORG,
  projectId: PROJECT,
  scopes: ["platform:admin"],
  source: "local_dev",
};

// ---- A SQL-routing fake client over in-memory personas/behaviors --------------

interface PersonaSeed {
  id: string;
  name: string;
  description: string;
}
interface BehaviorSeed {
  id: string;
  personaId: string;
  title: string;
  given: string;
  when: string;
  thenOutcome: string;
}
interface FakeResult {
  rows: unknown[];
  rowCount: number;
}
function rows(value: unknown[]): FakeResult {
  return { rows: value, rowCount: value.length };
}

class FakeGraphClient {
  readonly inserted: { domain: string; contract: unknown; version: number }[] = [];
  private readonly personaById: Map<string, PersonaSeed>;
  constructor(private readonly seed: { personas: PersonaSeed[]; behaviors: BehaviorSeed[] }) {
    this.personaById = new Map(seed.personas.map((p) => [p.id, p]));
  }

  private personaRow(p: PersonaSeed): unknown {
    return {
      id: p.id,
      scope: "project",
      org_id: ORG,
      project_id: PROJECT,
      name: p.name,
      description: p.description,
      metadata: {},
      created_at: new Date(),
      updated_at: new Date(),
    };
  }
  private behaviorRow(b: BehaviorSeed): unknown {
    return {
      id: b.id,
      persona_id: b.personaId,
      title: b.title,
      given: b.given,
      when: b.when,
      // `then` is the persisted BDD column name (decodeBehaviorRow reads `raw.then`).
      // eslint-disable-next-line unicorn/no-thenable
      then: b.thenOutcome,
      description: "",
      metadata: {},
      created_at: new Date(),
      updated_at: new Date(),
    };
  }

  async query(text: string, params: unknown[] = []): Promise<FakeResult> {
    // listForProject: all project personas.
    if (text.includes("FROM personas") && text.includes("scope = 'org' OR project_id")) {
      return rows(this.seed.personas.map((p) => this.personaRow(p)));
    }
    // PersonaStore.get by id (BehaviorStore.listForPersona's guard).
    if (text.includes("FROM personas WHERE id")) {
      const p = this.personaById.get(String(params[0]));
      return p === undefined ? rows([]) : rows([this.personaRow(p)]);
    }
    // BehaviorStore.listForPersona: behaviors for the persona id.
    if (text.includes("FROM behaviors WHERE persona_id")) {
      const pid = String(params[0]);
      return rows(this.seed.behaviors.filter((b) => b.personaId === pid).map((b) => this.behaviorRow(b)));
    }
    // DesignContractStore.create INSERT.
    if (text.includes("INSERT INTO design_contracts")) {
      const version = this.inserted.length + 1;
      this.inserted.push({ domain: String(params[3]), contract: JSON.parse(String(params[4])), version });
      return rows([
        {
          id: `design_${version}`,
          org_id: params[1],
          project_id: params[2],
          version,
          domain: params[3],
          contract: JSON.parse(String(params[4])),
        },
      ]);
    }
    throw new Error(`unexpected query in fake client: ${text}`);
  }
}

// A fake design agent that returns a scripted answer (or a function of the input).
function fakeAgent(answer: DesignAgentAnswer | ((input: DesignAgentInput) => DesignAgentAnswer)): DesignAgent {
  return {
    async elaborate(input: DesignAgentInput): Promise<DesignAgentAnswer> {
      return typeof answer === "function" ? answer(input) : answer;
    },
  };
}

// ---- Fixtures: two domains ----------------------------------------------------

const saasGraph = {
  personas: [
    { id: "persona_operator", name: "Operator", description: "watches live runs" },
    { id: "persona_admin", name: "Admin", description: "manages org config" },
  ],
  behaviors: [
    {
      id: "b_view",
      personaId: "persona_operator",
      title: "view runs",
      given: "a run",
      when: "open dash",
      thenOutcome: "see status",
    },
    {
      id: "b_config",
      personaId: "persona_admin",
      title: "edit config",
      given: "admin",
      when: "save",
      thenOutcome: "config persists",
    },
  ],
};

// An exhaustive, well-formed saas-web answer covering both behaviors.
const saasAnswer: DesignAgentAnswer = {
  domain: "saas-web",
  identity: "a calm, dense, trustworthy ops console",
  intent: "an information-dense control surface an operator trusts at a glance",
  principles: ["two accent colors max"],
  constraints: ["WCAG AA"],
  dimensions: [
    {
      key: "tokens",
      label: "Design tokens",
      intent: "restrained palette + dense type scale",
      guidance: "",
      personaIds: [],
    },
    {
      key: "components",
      label: "Components",
      intent: "legible primitives",
      guidance: "tables over cards",
      personaIds: ["persona_admin"],
    },
  ],
  coverage: [
    { behaviorId: "b_view", personaId: "persona_operator", dimensionKey: "components", surface: "a live runs table" },
    { behaviorId: "b_config", personaId: "persona_admin", dimensionKey: "tokens", surface: "a config form panel" },
  ],
};

const novelGraph = {
  personas: [{ id: "persona_reader", name: "Reader", description: "reads the translated novel" }],
  behaviors: [
    {
      id: "b_read",
      personaId: "persona_reader",
      title: "read a chapter",
      given: "a chapter",
      when: "scroll",
      thenOutcome: "prose flows",
    },
  ],
};
const novelAnswer: DesignAgentAnswer = {
  domain: "novel-translation",
  identity: "an austere literary classic",
  intent: "a faithful, voice-consistent rendering of the source work",
  principles: ["keep the translator's voice consistent"],
  constraints: ["preserve the source register"],
  dimensions: [
    {
      key: "typography",
      label: "Typography",
      intent: "a serif body for sustained reading",
      guidance: "",
      personaIds: [],
    },
    { key: "voice", label: "Voice", intent: "a consistent literary register", guidance: "", personaIds: [] },
    { key: "cover", label: "Cover", intent: "a restrained classic cover", guidance: "", personaIds: [] },
  ],
  coverage: [
    {
      behaviorId: "b_read",
      personaId: "persona_reader",
      dimensionKey: "typography",
      surface: "a single-column serif reading view",
    },
  ],
};

const SEED = {
  domain: "web",
  identity: "an ops tool",
  intent: "help operators",
  principles: [],
  constraints: [],
};

// ---- Tests --------------------------------------------------------------------

describe("WS-D3 design phase — elaboration", () => {
  it("(a)+(b)+(e) persists an exhaustive, persona-resolved saas-web contract as the HEAD version", async () => {
    const client = new FakeGraphClient(saasGraph);
    const result = await runDesignPhase({
      client: client as never,
      orgId: ORG,
      projectId: PROJECT,
      agent: fakeAgent(saasAnswer),
      actor: ACTOR,
      actorRef: { kind: "operator" },
      seed: SEED,
    });
    expect(result.domain).toBe("saas-web");
    expect(result.behaviorsCovered).toBe(2);
    // Every behavior bound; personas resolved from coverage + the scoped dimension.
    expect([...result.record.contract.behaviorRefs].sort()).toEqual(["b_config", "b_view"]);
    expect([...result.record.contract.personaRefs].sort()).toEqual(["persona_admin", "persona_operator"]);
    // The persona-scoped dimension survived onto the persisted contract.
    const components = result.record.contract.dimensions.find((d) => d.key === "components");
    expect(components?.personaRefs).toEqual(["persona_admin"]);
    // It is a valid, re-parseable contract (the HEAD version).
    expect(() => parseDesignContract(result.record.contract)).not.toThrow();
  });

  it("(c) is DOMAIN-GENERAL — persists the agent's NON-web dimensions for a novel domain", async () => {
    const client = new FakeGraphClient(novelGraph);
    const result = await runDesignPhase({
      client: client as never,
      orgId: ORG,
      projectId: PROJECT,
      agent: fakeAgent(novelAnswer),
      actor: ACTOR,
      actorRef: { kind: "operator" },
      seed: SEED,
    });
    expect(result.domain).toBe("novel-translation");
    expect(result.record.contract.dimensions.map((d) => d.key).sort()).toEqual(["cover", "typography", "voice"]);
    expect(result.record.contract.behaviorRefs).toEqual(["b_read"]);
  });

  it("(a) throws LOUDLY when the agent DROPS a behavior (non-exhaustive coverage)", async () => {
    const client = new FakeGraphClient(saasGraph);
    // Drop the admin behavior from coverage.
    const dropped: DesignAgentAnswer = {
      ...saasAnswer,
      coverage: saasAnswer.coverage.filter((c) => c.behaviorId !== "b_config"),
    };
    await expect(
      runDesignPhase({
        client: client as never,
        orgId: ORG,
        projectId: PROJECT,
        agent: fakeAgent(dropped),
        actor: ACTOR,
        actorRef: { kind: "operator" },
        seed: SEED,
      }),
    ).rejects.toThrow(/does not cover/u);
    expect(client.inserted).toHaveLength(0);
  });

  it("(b) throws LOUDLY when coverage references an UNKNOWN persona id (no dangling ref)", async () => {
    const client = new FakeGraphClient(saasGraph);
    const bogus: DesignAgentAnswer = {
      ...saasAnswer,
      coverage: [
        { behaviorId: "b_view", personaId: "persona_ghost", dimensionKey: "components", surface: "x" },
        { behaviorId: "b_config", personaId: "persona_admin", dimensionKey: "tokens", surface: "y" },
      ],
    };
    await expect(
      runDesignPhase({
        client: client as never,
        orgId: ORG,
        projectId: PROJECT,
        agent: fakeAgent(bogus),
        actor: ACTOR,
        actorRef: { kind: "operator" },
        seed: SEED,
      }),
    ).rejects.toThrow(/unknown persona id/u);
  });

  it("throws when coverage references an unknown dimension key", async () => {
    const client = new FakeGraphClient(saasGraph);
    const bogus: DesignAgentAnswer = {
      ...saasAnswer,
      coverage: [
        { behaviorId: "b_view", personaId: "persona_operator", dimensionKey: "ghost", surface: "x" },
        { behaviorId: "b_config", personaId: "persona_admin", dimensionKey: "tokens", surface: "y" },
      ],
    };
    await expect(
      runDesignPhase({
        client: client as never,
        orgId: ORG,
        projectId: PROJECT,
        agent: fakeAgent(bogus),
        actor: ACTOR,
        actorRef: { kind: "operator" },
        seed: SEED,
      }),
    ).rejects.toThrow(/unknown dimension key/u);
  });
});

describe("WS-D3 design agent — wrapper + prompt", () => {
  it("(d) the provider wrapper throws LOUDLY on a malformed answer (strict parse)", async () => {
    const adapter = {
      // The malformed answer is missing every required field but `domain`.
      runAnswerer: async (opts: { outputSchema: { parse: (v: unknown) => DesignAgentAnswer } }) =>
        opts.outputSchema.parse({ domain: "saas-web" }),
    };
    const agent = wrapProviderDesignAgent(adapter as never);
    await expect(agent.elaborate({ seed: SEED, personas: [], behaviors: [] })).rejects.toThrow(/Invalid input/u);
  });

  it("the prompt carries the behavior checklist + the resolved personas (the moat)", () => {
    const prompt = buildDesignAgentPrompt({
      seed: SEED,
      personas: saasGraph.personas.map((p) => ({ id: p.id, name: p.name, description: p.description })),
      behaviors: saasGraph.behaviors.map((b) => ({
        id: b.id,
        personaId: b.personaId,
        title: b.title,
        given: b.given,
        when: b.when,
        thenOutcome: b.thenOutcome,
      })),
    });
    // The exhaustive checklist mandate + both behavior ids + the persona ids.
    expect(prompt).toMatch(/EVERY behavior MUST be covered/u);
    expect(prompt).toContain("b_view");
    expect(prompt).toContain("b_config");
    expect(prompt).toContain("persona_operator");
    // Domain-appropriate mandate (no web assumption).
    expect(prompt).toMatch(/NOT assuming a web UI/u);
  });
});
