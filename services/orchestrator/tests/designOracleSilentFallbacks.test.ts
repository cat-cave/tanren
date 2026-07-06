// Codex critic #7 + #8 — the design-oracle stage's silent-fallback surfaces at the
// contract-store read boundary + the null-orgId actor branch of
// `detectReElaborationGap`. This suite pins the fail-loud typed-error shapes both
// paths land on now, complementing `designOracleStage.test.ts` (the main-flow
// behaviors that lived under the 500-line file cap).
//
// - Codex critic #7: a CORRUPT persisted contract row must throw
//   `DesignContractCorruptError`, not silently return `undefined` from
//   `getLatest`. The design-oracle caller uses `getLatestState` (the typed
//   discriminated-union lookup) and re-throws on the `corrupt` variant.
// - Codex critic #8: an `actor.orgId === null` invocation throws
//   `DesignOracleActorConfigError` BEFORE the store read, so a misconfigured
//   design actor never silently suppresses the re-elaboration finding class.
//
// "then" in the faked behavior rows is the BDD Given/When/Then column vocabulary,
// not a thenable — the awaitable-object lint does not apply to these fixtures.
/* eslint-disable unicorn/no-thenable */
import { describe, expect, it } from "vitest";

import type { ActorContext } from "../src/auth/schemas.js";
import { parseDesignContract, type DesignContractV1 } from "../src/engine/design/designContract.js";
import type { DesignOracleAnswer } from "../src/engine/answerers/schemas/index.js";
import type { AnswererAdapter } from "../src/engine/providers/types.js";
import {
  DesignOracleActorConfigError,
  runDesignOracleStage,
} from "../src/engine/workflow/designOracle/designOracle.js";
import { DesignContractCorruptError } from "../src/engine/repositories/designContracts.js";

const baselineSha = "b".repeat(40);
const ORG = "org_oracle_fallbacks";
const actor: ActorContext = {
  userId: "user_1",
  orgId: ORG,
  projectId: null,
  scopes: [],
  source: "session",
};
const actorRef = { kind: "operator" as const };

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

function noOpAdapter(): AnswererAdapter<DesignOracleAnswer> {
  return {
    kind: "answerer",
    cli: "fake",
    authRef: "fake",
    async runAnswerer(o) {
      return o.outputSchema.parse({ verificationMode: "x", findings: [], summary: "x" });
    },
  };
}

// The FROM design_contracts SELECT returns the given jsonb payload verbatim, so a
// deliberately-broken payload exercises the store's `corrupt` classification.
interface Seeds {
  contract?: DesignContractV1 | unknown;
  personaId?: string;
  behaviorId?: string;
}
function fakeClient(seeds: Seeds): { query: (text: string, params?: unknown[]) => Promise<unknown> } {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    async query(text: string, params?: unknown[]) {
      if (text.includes("FROM design_contracts")) {
        if (seeds.contract === undefined) return { rows: [] };
        return {
          rows: [
            {
              id: "design_1",
              org_id: ORG,
              project_id: "project_1",
              version: 3,
              domain: "saas-web",
              contract: seeds.contract,
            },
          ],
        };
      }
      if (text.includes("FROM personas")) {
        if (seeds.personaId === undefined || (params?.[0] as string) !== seeds.personaId) return { rows: [] };
        return {
          rows: [
            {
              id: seeds.personaId,
              scope: "org",
              org_id: ORG,
              project_id: null,
              name: "Admin",
              description: "runs the org",
              metadata: {},
              created_at: now,
              updated_at: now,
            },
          ],
        };
      }
      if (text.includes("FROM behaviors")) {
        if (seeds.behaviorId === undefined || (params?.[0] as string) !== seeds.behaviorId) return { rows: [] };
        return {
          rows: [
            {
              id: seeds.behaviorId,
              persona_id: seeds.personaId ?? "persona_admin",
              title: "Invite a teammate",
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

describe("runDesignOracleStage — silent-fallback fail-loud typed errors (Codex critic #7 / #8)", () => {
  // Codex critic #8: the prior `detectReElaborationGap` returned `[]` when
  // `actor.orgId === null`, silently converting "cannot enumerate the project's
  // behaviors" into "no re-elaboration gaps" — a misconfigured design actor suppressed
  // the ENTIRE re-elaboration finding class. The fix pulls the check upstream in
  // `runDesignOracleStage` so a null-orgId actor throws a typed config error
  // BEFORE any store read — never a silent skip.
  it("throws DesignOracleActorConfigError when actor.orgId is null (Codex critic #8)", async () => {
    const client = fakeClient({
      contract: webContract(),
      personaId: "persona_admin",
      behaviorId: "behavior_invite",
    });
    const nullOrgActor: ActorContext = { ...actor, orgId: null };
    await expect(
      runDesignOracleStage({
        client,
        projectId: "project_1",
        actor: nullOrgActor,
        actorRef,
        adapter: noOpAdapter(),
        baselineSha,
        workspacePath: "/tmp/ws",
      }),
    ).rejects.toBeInstanceOf(DesignOracleActorConfigError);
  });

  // Codex critic #8 (companion assertion): the thrown error carries the project id
  // + the concrete reason so an operator can search the timeline for the
  // deterministic failure and triage — not the prior silent `[]` return that
  // suppressed the finding class.
  it("the DesignOracleActorConfigError carries the project id + concrete reason", async () => {
    const nullOrgActor: ActorContext = { ...actor, orgId: null };
    let caught: unknown;
    try {
      await runDesignOracleStage({
        client: fakeClient({ contract: webContract() }),
        projectId: "project_null_org",
        actor: nullOrgActor,
        actorRef,
        adapter: noOpAdapter(),
        baselineSha,
        workspacePath: "/tmp/ws",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DesignOracleActorConfigError);
    const err = caught as DesignOracleActorConfigError;
    expect(err.projectId).toBe("project_null_org");
    expect(err.reason).toContain("orgId");
  });

  // Codex critic #7: a CORRUPT persisted contract row must throw loud (a
  // `DesignContractCorruptError` propagated through the store's typed-state
  // lookup). Under the prior silent-fallback shape, a parse failure was
  // indistinguishable from a legit no-contract project on some paths — the
  // design ring skipped cleanly.
  it("throws DesignContractCorruptError when the persisted contract row is malformed (Codex critic #7)", async () => {
    // A persisted row whose `contract` jsonb is NOT a valid `DesignContractV1`
    // (missing every required field).
    const client = fakeClient({ contract: { some: "unexpected", shape: true } });
    await expect(
      runDesignOracleStage({
        client,
        projectId: "project_1",
        actor,
        actorRef,
        adapter: noOpAdapter(),
        baselineSha,
        workspacePath: "/tmp/ws",
      }),
    ).rejects.toBeInstanceOf(DesignContractCorruptError);
  });

  // Codex critic #7 (companion assertion): the corrupt case does NOT quietly
  // return the `hasContract: false` empty state (which would silently skip the
  // design ring exactly like the pre-fix behavior).
  it("the CORRUPT case throws, never returns hasContract=false silently", async () => {
    const client = fakeClient({ contract: null });
    let resolved: unknown;
    let caught: unknown;
    try {
      resolved = await runDesignOracleStage({
        client,
        projectId: "project_1",
        actor,
        actorRef,
        adapter: noOpAdapter(),
        baselineSha,
        workspacePath: "/tmp/ws",
      });
    } catch (error) {
      caught = error;
    }
    expect(resolved).toBeUndefined();
    expect(caught).toBeInstanceOf(DesignContractCorruptError);
  });
});
