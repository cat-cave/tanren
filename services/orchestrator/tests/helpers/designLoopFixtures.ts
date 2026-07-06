// PHASE-3 (road to apex v37) — fixtures + a STORE-FAITHFUL in-memory entity graph for
// the design-loop e2e readiness harness (`designLoopE2E.test.ts`). One `MemoryGraph`
// backs all three stores (personas, behaviors, design_contracts) via their REAL SQL, so
// the design PHASE's `DesignContractStore.create` PERSISTS into the very store the
// writer-context + oracle then read via `getLatest` — the contract flows through the
// persistence seam, not three disconnected fakes. The only fakes are the LLM seams.
//
// "then" in the seeded behavior rows is the BDD Given/When/Then column vocabulary, not a
// thenable — the awaitable-object lint does not apply to these fixtures.
/* eslint-disable unicorn/no-thenable */
import { expect } from "vitest";

import type { ActorContext } from "../../src/auth/schemas.js";
import { type DesignOracleAnswer, DESIGN_ORACLE_ANSWER_SCHEMA_ID } from "../../src/engine/answerers/schemas/index.js";
import type { DesignAgent, DesignAgentAnswer, DesignAgentInput } from "../../src/engine/design/designAgent.js";
import type { AnswererAdapter } from "../../src/engine/providers/types.js";

export const ORG = "org_neatlink";
export const PROJECT = "project_neatlink";
export const baselineSha = "a".repeat(40);

export const actor: ActorContext = {
  userId: "u_e2e",
  orgId: ORG,
  projectId: PROJECT,
  scopes: ["platform:admin"],
  source: "local_dev",
};
export const actorRef = { kind: "operator" as const };

export interface PersonaSeed {
  id: string;
  name: string;
  description: string;
}
export interface BehaviorSeed {
  id: string;
  personaId: string;
  title: string;
  given: string;
  when: string;
  thenOutcome: string;
}
interface StoredContractRow {
  id: string;
  org_id: string;
  project_id: string;
  version: number;
  // Post-Codex-RA1: mode is a first-class column the unique index is keyed on
  // (see db/src/schemaDesign.ts + migration 0025_design_contracts_mode.sql).
  mode: string;
  domain: string;
  contract: unknown;
}

type QueryResult = { rows: ReadonlyArray<Record<string, unknown>>; rowCount: number };
function wrap(rows: ReadonlyArray<Record<string, unknown>>): QueryResult {
  return { rows, rowCount: rows.length };
}
const NOW = new Date("2026-01-01T00:00:00Z");

/**
 * A stateful in-memory entity graph driven through the stores' REAL SQL. Personas +
 * behaviors are pre-seeded (the interview's captured entity set); design_contracts is
 * EMPTY at start and grows as the design phase persists a version — so the writer +
 * oracle read back exactly what the phase wrote.
 */
export class MemoryGraph {
  private readonly personas: PersonaSeed[];
  private readonly behaviors: BehaviorSeed[];
  private readonly contracts: StoredContractRow[] = [];

  constructor(seed: { personas: PersonaSeed[]; behaviors: BehaviorSeed[] }) {
    this.personas = [...seed.personas];
    this.behaviors = [...seed.behaviors];
  }

  /** Add a behavior AFTER the design phase (drives the re-elaboration gap, #619). */
  addBehavior(b: BehaviorSeed): void {
    this.behaviors.push(b);
  }

  private personaRow(p: PersonaSeed): Record<string, unknown> {
    return {
      id: p.id,
      scope: "org",
      org_id: ORG,
      project_id: null,
      name: p.name,
      description: p.description,
      metadata: {},
      created_at: NOW,
      updated_at: NOW,
    };
  }
  private behaviorRow(b: BehaviorSeed): Record<string, unknown> {
    return {
      id: b.id,
      persona_id: b.personaId,
      title: b.title,
      given: b.given,
      when: b.when,
      then: b.thenOutcome,
      description: null,
      metadata: {},
      created_at: NOW,
      updated_at: NOW,
    };
  }

  async query(text: string, params: ReadonlyArray<unknown> = []): Promise<QueryResult> {
    // ---- design_contracts ----
    if (text.includes("INSERT INTO design_contracts")) {
      // Mirror DesignContractStore.create (post-Codex-RA1): mode is $4, domain
      // is $5, contract is $6. Version is now (project, mode)-scoped max+1.
      const projectId = String(params[2]);
      const mode = String(params[3]);
      const priorForPair = this.contracts.filter((c) => c.project_id === projectId && c.mode === mode);
      const row: StoredContractRow = {
        id: String(params[0]),
        org_id: String(params[1]),
        project_id: projectId,
        version: priorForPair.length + 1,
        mode,
        domain: String(params[4]),
        contract: JSON.parse(String(params[5])),
      };
      this.contracts.push(row);
      return wrap([row as unknown as Record<string, unknown>]);
    }
    if (text.includes("FROM design_contracts")) {
      // getLatest/getLatestState: highest version for (project, mode). The
      // store now passes `mode` as $2 (WHERE project_id = $1 AND mode = $2).
      const projectId = String(params[0]);
      const mode = String(params[1]);
      const forPair = this.contracts.filter((c) => c.project_id === projectId && c.mode === mode);
      if (forPair.length === 0) return wrap([]);
      const head = forPair.reduce((a, b) => (b.version > a.version ? b : a));
      return wrap([head as unknown as Record<string, unknown>]);
    }
    // ---- personas ----
    if (text.includes("FROM personas") && text.includes("org_id = $1")) {
      // listForProject — every org-scoped persona, ordered by name.
      return wrap([...this.personas].sort((a, b) => a.name.localeCompare(b.name)).map((p) => this.personaRow(p)));
    }
    if (text.includes("FROM personas")) {
      // PersonaStore.get by id.
      const p = this.personas.find((x) => x.id === String(params[0]));
      return wrap(p === undefined ? [] : [this.personaRow(p)]);
    }
    // ---- behaviors ----
    if (text.includes("FROM behaviors") && text.includes("persona_id = $1")) {
      // listForPersona — that persona's behaviors, ordered by title.
      const rows = this.behaviors
        .filter((b) => b.personaId === String(params[0]))
        .sort((a, b) => a.title.localeCompare(b.title));
      return wrap(rows.map((b) => this.behaviorRow(b)));
    }
    if (text.includes("FROM behaviors")) {
      // BehaviorStore.get by id.
      const b = this.behaviors.find((x) => x.id === String(params[0]));
      return wrap(b === undefined ? [] : [this.behaviorRow(b)]);
    }
    throw new Error(`MemoryGraph: unexpected query: ${text}`);
  }
}

// ---- The fake LLM seams (the ONLY fakes) -----------------------------------

export function fakeDesignAgent(
  answer: DesignAgentAnswer | ((input: DesignAgentInput) => DesignAgentAnswer),
): DesignAgent {
  return {
    async elaborate(input: DesignAgentInput): Promise<DesignAgentAnswer> {
      return typeof answer === "function" ? answer(input) : answer;
    },
  };
}

export function fakeOracleAdapter(verdict: DesignOracleAnswer): {
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
      expect(o.outputSchema.name).toBe(DESIGN_ORACLE_ANSWER_SCHEMA_ID);
      return o.outputSchema.parse(verdict);
    },
  };
  return { adapter, prompts };
}

// ---- The neatlink fixture: a v37-style UI product (a link shortener) -------
// Two personas, three behaviors — a realistic captured persona/behavior set.

export const NEATLINK_PERSONAS: PersonaSeed[] = [
  { id: "persona_member", name: "Member", description: "shortens + shares links" },
  { id: "persona_admin", name: "Admin", description: "manages the team workspace" },
];

// id | personaId | title | given | when | thenOutcome (compact tuples → BehaviorSeed).
const NEATLINK_BEHAVIOR_TUPLES: ReadonlyArray<readonly [string, string, string, string, string, string]> = [
  [
    "behavior_shorten",
    "persona_member",
    "Shorten a link",
    "a long URL",
    "the member submits it",
    "a short link is created and copyable",
  ],
  [
    "behavior_stats",
    "persona_member",
    "See click stats",
    "a shortened link",
    "the member opens its detail",
    "click counts over time are shown",
  ],
  [
    "behavior_invite",
    "persona_admin",
    "Invite a teammate",
    "an admin on the workspace",
    "they send an invite",
    "the teammate joins the workspace",
  ],
];
export const NEATLINK_BEHAVIORS: BehaviorSeed[] = NEATLINK_BEHAVIOR_TUPLES.map(
  ([id, personaId, title, given, when, thenOutcome]) => ({ id, personaId, title, given, when, thenOutcome }),
);

// The captured design intent (an interview-style capture, the WS-D1 seed).
export const NEATLINK_SEED = {
  domain: "saas-web",
  identity: "a crisp, fast, trustworthy link tool",
  intent: "shorten + track links with zero ceremony",
  principles: ["instant feedback", "no AI-slop"],
  constraints: ["WCAG AA"],
};

// The canned design-agent answer: a full saas-web contract that exhaustively covers all
// three behaviors and derives its own (web-appropriate) dimensions.
export function neatlinkAgentAnswer(): DesignAgentAnswer {
  return {
    domain: "saas-web",
    identity: "a crisp, fast, trustworthy link console",
    intent: "shorten + track links with zero ceremony — instant, legible, calm",
    principles: ["instant feedback", "two accent colors max"],
    constraints: ["WCAG AA"],
    dimensions: [
      {
        key: "tokens",
        label: "Design tokens",
        intent: "restrained palette, dense type scale",
        guidance: "",
        personaIds: [],
      },
      {
        key: "components",
        label: "Components",
        intent: "legible primitives; copy-on-click affordances",
        guidance: "tables over cards for stats",
        personaIds: ["persona_member"],
      },
      {
        key: "admin-surface",
        label: "Admin surface",
        intent: "an unobtrusive workspace-management surface",
        guidance: "",
        personaIds: ["persona_admin"],
      },
    ],
    coverage: [
      {
        behaviorId: "behavior_shorten",
        personaId: "persona_member",
        dimensionKey: "components",
        surface: "a one-field shorten form with copy button",
      },
      {
        behaviorId: "behavior_stats",
        personaId: "persona_member",
        dimensionKey: "components",
        surface: "a click-stats table on the link detail",
      },
      {
        behaviorId: "behavior_invite",
        personaId: "persona_admin",
        dimensionKey: "admin-surface",
        surface: "a members panel with an invite action",
      },
    ],
  };
}
