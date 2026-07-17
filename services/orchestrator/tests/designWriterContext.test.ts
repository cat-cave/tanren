// Native design subsystem (WS-D2) — inject the HEAD `DesignContract` into the
// WRITER prompt. Proves the moat behaviors of the load + render seam
// (designWriterContext.ts):
//   (a) PERSONA-SCOPED: contract-level personas resolve to real NAMES (no "assume
//       admin"); a dimension's own `personaRefs` render its persona-view line;
//   (b) BEHAVIOR COVERAGE: the design's `behaviorRefs` surface as given/when/then
//       acceptance criteria attributed to their persona (the same behaviors the
//       implementor builds from — the designer↔implementor gap closed);
//   (c) DOMAIN-GENERAL: the render walks WHATEVER dimensions the contract declares
//       across ≥2 domains (saas-web tokens/components vs a novel's typography/voice
//       /cover) — never assuming web;
//   (d) NO CONTRACT ⇒ undefined (no block — a real empty state, never a fabricated
//       default); an `unscopedPlatform` scope likewise yields no block;
//   (e) MALFORMED ⇒ LOUD: a malformed persisted contract throws (the store re-parse);
//   (f) DANGLING REF ⇒ LOUD: an unresolved persona/behavior ref throws (parity with the
//       design oracle's `resolvePersonas`/`resolveBehaviors` — never a silent drop);
//   (g) H2 BLOCKING (unify): the writer-context reads the SINGLE per-project head —
//       a scaffold/build/deploy spec (which under the old broken code silently got
//       `{ kind: absent }` from a per-mode lookup that never had a matching row)
//       now loads the project's shared product contract.

import { describe, expect, it } from "vitest";
import { parseDesignContract, type DesignContractV1 } from "../src/engine/design/designContract.js";
import {
  loadDesignContextBlock,
  renderDesignContractBlock,
  resolveDesignContext,
  type ResolvedDesignContext,
} from "../src/engine/design/designWriterContext.js";

const ORG = "org_design";
const PROJECT = "project_design";

// ---- Fakes -----------------------------------------------------------------

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

// A SQL-routing fake QueryClient over in-memory persona/behavior/design rows.
// Routes by the statement's table + the $1 id param, mirroring the real stores'
// SELECTs (the design store + the persona/behavior entity stores).
class FakeDesignClient {
  private readonly personaById: Map<string, PersonaSeed>;
  private readonly behaviorById: Map<string, BehaviorSeed>;
  constructor(
    private readonly seed: { contract?: DesignContractV1; personas: PersonaSeed[]; behaviors: BehaviorSeed[] },
  ) {
    this.personaById = new Map(seed.personas.map((p) => [p.id, p]));
    this.behaviorById = new Map(seed.behaviors.map((b) => [b.id, b]));
  }

  async query(text: string, params: unknown[] = []): Promise<FakeResult> {
    const id = typeof params[0] === "string" ? params[0] : "";
    if (text.includes("FROM design_contracts")) {
      if (this.seed.contract === undefined) return rows([]);
      // H2 BLOCKING (unify): the store SELECT keys on `project_id = $1` only —
      // one contract per project, shared across every spec type (migration
      // 0028 dropped the broken per-mode key).
      return rows([
        {
          id: "design_1",
          org_id: ORG,
          project_id: PROJECT,
          version: 1,
          domain: this.seed.contract.domain,
          contract: this.seed.contract,
        },
      ]);
    }
    if (text.includes("FROM personas")) {
      const p = this.personaById.get(id);
      if (p === undefined) return rows([]);
      return rows([
        {
          id: p.id,
          scope: "project",
          org_id: ORG,
          project_id: PROJECT,
          name: p.name,
          description: p.description,
          metadata: {},
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);
    }
    if (text.includes("FROM behaviors")) {
      const b = this.behaviorById.get(id);
      if (b === undefined) return rows([]);
      return rows([
        {
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
        },
      ]);
    }
    throw new Error(`unexpected query in fake client: ${text}`);
  }
}

function rows(value: unknown[]): FakeResult {
  return { rows: value, rowCount: value.length };
}

function fakeClient(seed: {
  contract?: DesignContractV1;
  personas: PersonaSeed[];
  behaviors: BehaviorSeed[];
}): FakeDesignClient {
  return new FakeDesignClient(seed);
}

// ---- Fixtures --------------------------------------------------------------

const saasContract = parseDesignContract({
  version: 1,
  domain: "saas-web",
  identity: "a calm, dense, trustworthy ops console",
  intent: "an information-dense control surface an operator trusts at a glance",
  principles: ["two accent colors max", "no AI-slop gradients"],
  constraints: ["WCAG AA"],
  personaRefs: ["persona_operator", "persona_admin"],
  behaviorRefs: ["behavior_view_runs"],
  dimensions: [
    { key: "tokens", label: "Design tokens", intent: "a restrained palette + a dense type scale", guidance: "" },
    {
      key: "components",
      label: "Components",
      intent: "consistent, legible primitives",
      guidance: "prefer table over cards for dense data",
      // PERSONA-SCOPED dimension: the admin's view of the components surface.
      personaRefs: ["persona_admin"],
    },
  ],
});

const novelContract = parseDesignContract({
  version: 1,
  domain: "novel-translation",
  identity: "an austere literary classic",
  intent: "preserve the source register while reading naturally in the target language",
  personaRefs: ["persona_reader"],
  behaviorRefs: [],
  dimensions: [
    { key: "typography", label: "Typography", intent: "a classic serif, generous leading", guidance: "" },
    { key: "voice", label: "Voice", intent: "keep the translator's consistent register", guidance: "" },
    { key: "cover", label: "Cover", intent: "restrained, period-appropriate", guidance: "" },
  ],
});

const personas: PersonaSeed[] = [
  { id: "persona_operator", name: "Operator", description: "runs the day-to-day ops" },
  { id: "persona_admin", name: "Admin", description: "configures the org" },
  { id: "persona_reader", name: "Reader", description: "reads the translated work" },
];
const behaviors: BehaviorSeed[] = [
  {
    id: "behavior_view_runs",
    personaId: "persona_operator",
    title: "View runs",
    given: "an authenticated operator",
    when: "they open the dashboard",
    thenOutcome: "they see the live run list",
  },
];

describe("WS-D2 design writer context — resolve + render (persona-scoped, behavior-linked, domain-general)", () => {
  it("renders the contract core + resolves contract-level personas to NAMES (no assume-admin)", async () => {
    const client = fakeClient({ contract: saasContract, personas, behaviors });
    const block = await loadDesignContextBlock({ client, orgScope: { kind: "org", orgId: ORG }, projectId: PROJECT });
    expect(block).toBeDefined();
    expect(block).toContain("Design domain: saas-web");
    expect(block).toContain("Design identity: a calm, dense, trustworthy ops console");
    expect(block).toContain("Design intent: an information-dense control surface");
    // The principles + constraints render.
    expect(block).toContain("two accent colors max");
    expect(block).toContain("WCAG AA");
    // Personas resolve to NAMES + descriptions (strict resolution, no guessing).
    expect(block).toContain("Operator — runs the day-to-day ops");
    expect(block).toContain("Admin — configures the org");
  });

  it("surfaces the design's behaviorRefs as given/when/then acceptance criteria attributed to the persona", async () => {
    const client = fakeClient({ contract: saasContract, personas, behaviors });
    const block = await loadDesignContextBlock({ client, orgScope: { kind: "org", orgId: ORG }, projectId: PROJECT });
    expect(block).toContain("Behaviors this design must cover");
    expect(block).toContain(
      "[Operator] View runs — given an authenticated operator, when they open the dashboard, then they see the live run list",
    );
  });

  it("renders DOMAIN-DECLARED dimensions and a dimension's own persona view (saas-web)", async () => {
    const client = fakeClient({ contract: saasContract, personas, behaviors });
    const block = await loadDesignContextBlock({ client, orgScope: { kind: "org", orgId: ORG }, projectId: PROJECT });
    expect(block).toContain("Design tokens (tokens): a restrained palette");
    expect(block).toContain("Components (components): consistent, legible primitives");
    // The components dimension's persona-scoped view resolves to the admin's NAME.
    expect(block).toContain("Persona view: Admin");
    expect(block).toContain("Guidance: prefer table over cards for dense data");
    // It NEVER fabricates dimensions Tanren didn't get from the contract.
    expect(block).not.toContain("art-direction");
  });

  it("is DOMAIN-GENERAL — a novel-translation contract renders its typography/voice/cover dimensions, not web ones", async () => {
    const client = fakeClient({ contract: novelContract, personas, behaviors: [] });
    const block = await loadDesignContextBlock({ client, orgScope: { kind: "org", orgId: ORG }, projectId: PROJECT });
    expect(block).toBeDefined();
    expect(block).toContain("Design domain: novel-translation");
    expect(block).toContain("Typography (typography): a classic serif");
    expect(block).toContain("Voice (voice): keep the translator's consistent register");
    expect(block).toContain("Cover (cover): restrained, period-appropriate");
    // No web vocabulary is assumed.
    expect(block).not.toContain("tokens");
    expect(block).not.toContain("WCAG");
    // A contract with no behaviorRefs surfaces no behavior section (a real empty state).
    expect(block).not.toContain("Behaviors this design must cover");
  });

  it("returns undefined when the project has NO design contract (no fabricated default)", async () => {
    const client = fakeClient({ personas, behaviors });
    const block = await loadDesignContextBlock({ client, orgScope: { kind: "org", orgId: ORG }, projectId: PROJECT });
    expect(block).toBeUndefined();
  });

  it("enforces the tenant-scope invariant at the TYPE level (unscopedPlatform is unreachable)", () => {
    // The vestigial "silent skip on `kind !== "org"`" branch is gone — the
    // hydration boundary (`orgScopeFromRunOrgId`) throws `UnscopedOrgError` on a
    // missing/empty org id, so a run never reaches `loadDesignContextBlock` with
    // an `unscopedPlatform` scope. The invariant is enforced HERE at the TYPE
    // (loadDesignContextBlock now requires `TenantScope`, not `OrgScope`).
    const client = fakeClient({ contract: saasContract, personas, behaviors });
    // @ts-expect-error `unscopedPlatform` is not a `TenantScope`.
    void loadDesignContextBlock({ client, orgScope: { kind: "unscopedPlatform" }, projectId: PROJECT });
    // The compile-time proof IS the assertion (the `@ts-expect-error` above);
    // this expect anchors it as a runtime-observable test too.
    expect(typeof loadDesignContextBlock).toBe("function");
  });

  // H2 BLOCKING (unify) — pins the fix's core promise: the SAME contract, written
  // ONCE at derive under `from_scratch` mode, is now visible to a scaffold /
  // build / deploy spec's writer (which runs under `specialize_seed`). Under the
  // pre-fix code the store SELECT filtered `mode = 'specialize_seed'` and found
  // no row → `{ kind: 'absent' }` → the writer got NO design block, exactly the
  // silent no-op the H2 audit flagged. Post-fix: one head per project, every
  // spec type reads it.
  it("H2: a scaffold spec (specialize_seed) reads the SAME project head the derive wrote (was silent no-op)", async () => {
    const contract = parseDesignContract({
      version: 1,
      domain: "saas-web",
      identity: "the neatlink workspace",
      intent: "link shortening with zero ceremony",
      personaRefs: ["persona_operator"],
      behaviorRefs: [],
      dimensions: [],
    });
    // A store where the ONLY persisted row was written at derive (as the code
    // path used to do at DEFAULT_SPEC_MODE = "from_scratch"). Post-fix the store
    // doesn't care about mode: it returns the project's single head to whichever
    // caller asks. The fake refuses to serve a row if the SQL WHERE clause
    // includes any mode filter — proving the H2 collapse in the store SQL.
    const scaffoldClient = {
      async query(text: string, params: unknown[] = []): Promise<FakeResult> {
        if (text.includes("FROM design_contracts")) {
          // The pre-fix SQL was `WHERE project_id = $1 AND mode = $2`. Post-H2
          // it is `WHERE project_id = $1`. Guard the collapse in the SQL text
          // AND the bound-param shape (one param, the project id).
          expect(text).not.toContain("mode");
          expect(params).toEqual([PROJECT]);
          return rows([
            {
              id: "design_derive",
              org_id: ORG,
              project_id: PROJECT,
              version: 1,
              domain: contract.domain,
              contract,
            },
          ]);
        }
        return new FakeDesignClient({ contract, personas, behaviors: [] }).query(text, params);
      },
    };
    const block = await loadDesignContextBlock({
      client: scaffoldClient,
      orgScope: { kind: "org", orgId: ORG },
      projectId: PROJECT,
    });
    // The block IS defined — the scaffold spec now gets its product identity.
    // (Pre-fix this was `undefined` and the writer got NO design context —
    // exactly the H2 finding.)
    expect(block).toBeDefined();
    expect(block).toContain("Design identity: the neatlink workspace");
    expect(block).toContain("Operator");
  });

  // H2 BLOCKING (unify) — the writer-context load surface itself. Prove the
  // store SELECT does NOT include a mode filter and only binds the project id.
  it("H2: loads the project head for ANY spec type (scaffold/build/deploy included)", async () => {
    const capturedParams: unknown[][] = [];
    const spyFakeClient = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async query(text: string, params: unknown[] = []): Promise<any> {
        if (text.includes("FROM design_contracts")) {
          capturedParams.push([...params]);
          // The SELECT must NOT include a mode filter — one head per project.
          expect(text).not.toContain("mode");
          return rows([
            {
              id: "design_1",
              org_id: ORG,
              project_id: PROJECT,
              version: 1,
              domain: saasContract.domain,
              contract: saasContract,
            },
          ]);
        }
        return new FakeDesignClient({ contract: saasContract, personas, behaviors }).query(text, params);
      },
    };
    // The load produces the same block regardless of the downstream spec's mode
    // — the contract is PRODUCT-scoped, shared across every spec type.
    const block = await loadDesignContextBlock({
      client: spyFakeClient,
      orgScope: { kind: "org", orgId: ORG },
      projectId: PROJECT,
    });
    expect(block).toBeDefined();
    expect(block).toContain("Design domain: saas-web");
    // Only one bound param — the project id.
    expect(capturedParams).toEqual([[PROJECT]]);
  });

  it("THROWS LOUD on a dangling persona ref (parity with the design oracle — no silent drop)", async () => {
    const danglingPersona = parseDesignContract({
      version: 1,
      domain: "saas-web",
      identity: "x",
      intent: "y",
      personaRefs: ["persona_operator", "persona_gone"],
      behaviorRefs: [],
      dimensions: [],
    });
    const client = fakeClient({ contract: danglingPersona, personas, behaviors });
    // The writer-context now resolves identically to the oracle: an unresolved ref is
    // malformed graph state and fails loud, never a thinner silently-built design.
    await expect(
      loadDesignContextBlock({ client, orgScope: { kind: "org", orgId: ORG }, projectId: PROJECT }),
    ).rejects.toThrow(/personaRef 'persona_gone' does not resolve/u);
  });

  it("THROWS LOUD on a dangling behavior ref (parity with the design oracle — no silent drop)", async () => {
    const danglingBehavior = parseDesignContract({
      version: 1,
      domain: "saas-web",
      identity: "x",
      intent: "y",
      personaRefs: ["persona_operator"],
      behaviorRefs: ["behavior_gone"],
      dimensions: [],
    });
    const client = fakeClient({ contract: danglingBehavior, personas, behaviors });
    await expect(
      loadDesignContextBlock({ client, orgScope: { kind: "org", orgId: ORG }, projectId: PROJECT }),
    ).rejects.toThrow(/behaviorRef 'behavior_gone' does not resolve/u);
  });

  it("fails LOUD on a malformed persisted contract (store re-parse throws — no silent degrade)", async () => {
    // A malformed `contract` jsonb (missing the required `intent`) — the store's
    // mapRow re-parses through the schema and throws before render.
    const client = {
      query: async (text: string): Promise<FakeResult> => {
        if (text.includes("FROM design_contracts")) {
          return rows([
            {
              id: "design_1",
              org_id: ORG,
              project_id: PROJECT,
              version: 1,
              domain: "saas-web",
              contract: { version: 1, domain: "saas-web", identity: "x" },
            },
          ]);
        }
        return rows([]);
      },
    };
    await expect(
      loadDesignContextBlock({ client, orgScope: { kind: "org", orgId: ORG }, projectId: PROJECT }),
    ).rejects.toThrow(/intent/u);
  });

  it("renderDesignContractBlock omits the persona-view line for a dimension with no personaRefs (all-personas state)", () => {
    const context: ResolvedDesignContext = {
      contract: novelContract,
      personasById: new Map([["persona_reader", { id: "persona_reader", name: "Reader", description: "" }]]),
      behaviorsById: new Map(),
    };
    const block = renderDesignContractBlock(context);
    // The typography dimension declares no personaRefs ⇒ no "Persona view:" line under it.
    expect(block).toContain("Typography (typography)");
    expect(block).not.toContain("Persona view:");
  });

  it("resolveDesignContext resolves only the referenced personas/behaviors", async () => {
    const client = fakeClient({ contract: saasContract, personas, behaviors });
    const context = await resolveDesignContext(
      client,
      {
        id: "design_1",
        orgId: ORG,
        projectId: PROJECT,
        version: 1,
        domain: saasContract.domain,
        contract: saasContract,
      },
      { userId: "t", orgId: ORG, projectId: PROJECT, scopes: ["platform:admin"], source: "local_dev" },
    );
    expect([...context.personasById.keys()].sort()).toEqual(["persona_admin", "persona_operator"]);
    expect([...context.behaviorsById.keys()]).toEqual(["behavior_view_runs"]);
    expect(context.behaviorsById.get("behavior_view_runs")?.persona).toBe("Operator");
  });

  it("additively injects an explicitly resolved web catalog and tokens for the Writer", async () => {
    const block = await loadDesignContextBlock({
      client: fakeClient({ personas, behaviors }),
      orgScope: { kind: "org", orgId: ORG },
      projectId: PROJECT,
      webDesignSystem: {
        designSystemId: "system_web",
        releaseId: "release_web_1",
        artifactId: "artifact_web_1",
        tokens: [{ path: "color.primary", cssVariable: "--tanren-color-primary", cssValue: "#155eef", type: "color" }],
        catalog: {
          schemaVersion: 1,
          framework: "react",
          style: "shadcn",
          components: [
            {
              key: "dialog",
              primitive: "@radix-ui/react-dialog",
              packageName: "@radix-ui/react-dialog",
              sourcePath: "components/ui/dialog.tsx",
              tokenBindings: { background: "--tanren-color-primary" },
            },
          ],
        },
      },
    });
    expect(block).toContain("Web design system — use this published system");
    expect(block).toContain("--tanren-color-primary = #155eef");
    expect(block).toContain("dialog (@radix-ui/react-dialog; components/ui/dialog.tsx)");
  });
});
