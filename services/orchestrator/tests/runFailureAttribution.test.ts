// THE NEVER-PARK PROOF — failure-cause attribution + precondition-blocked re-drive.
//
// THE DEFECT THESE PIN (measured on a live instance driving a real monorepo for a day):
// 225 `run.failed`, 146 `dag.spec.redriven`, 80 `dag.spec.needs_attention`, ZERO
// `run.completed`, and 65 specs parked at the terminal `needs_attention` status that only
// an operator `requeue` could free. Three layers produced it:
//
//   1. The failure SIGNATURE was lossy. `classifyRunFailure` keys an allowlist off
//      `error.name`, and the dominant real error classes were absent from it — so 209 of
//      225 failures (93%) classified as the catch-all `internal`.
//   2. The convergence detector was therefore fed IDENTICAL signatures for categorically
//      different causes. Run failures carry no `workSignature`, so the failure code IS the
//      whole signature: an SSH outage, then a missing credential, then a control-plane 500
//      read as ONE repeating state and parked the spec as "genuinely stuck".
//   3. A missing credential parked on its FIRST occurrence (`GENUINE_TERMINAL_CODES`), with
//      zero retries.
//
// Every blocking cause observed was ENVIRONMENTAL and every one CLEARED later (the SSH key
// was re-provisioned, the credential seeded, the config corrected). Tanren resumed for none
// of them. The doctrine: "Halts are not tolerable. If tanren is working correctly, a user
// has budget, and the roadmap is not complete, halting means a fundamental failure in
// tanren." A halt is a BUG REPORT, not a terminal state.
//
// THIS FILE holds the CLASSIFIER arms (the allowlist entries whose absence produced the
// 93%-`internal` reading), the convergence-history SOURCE FILTER in both readers, and the
// back-compat guarantees for history written before this change. The behavioral recovery
// proof lives in `preconditionRedrive.test.ts`.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { buildRedriveHistoryReader } from "../src/engine/workflow/plannerRunRedrive.js";
import { classifyRunFailure } from "../src/engine/worker/runFailureClassifier.js";
import type { ClassifiedRunFailure } from "../src/engine/worker/runFailureClassifier.js";
import { readOrphanConsecutive } from "../src/engine/worker/runFinalize.js";
import { DagSpecRedrivenPayload } from "../src/engine/events/schemas/dagRedrive.js";
import { PersistentSshOutageError } from "../src/engine/ssh/transientRetry.js";
import { MissingGithubCredentialRefError } from "../src/engine/credentials/githubTokenResolver.js";
import { MissingGithubAppCredentialRefError } from "../src/engine/credentials/githubApp.js";
import { UnscopedOrgError } from "../src/engine/credentials/resolveCredentials.js";
import { RunStateWriteTransportError } from "../src/engine/worker/httpRunStateWriter.js";
import { RunnerClaimLiveRowError } from "../src/engine/allocators/runnerStore.js";
import { WorkspaceDepsInstallError } from "../src/engine/workspace/index.js";
// ─────────────────────────────────────────────────────────────────────────────────────
// (1) THE CLASSIFIER — the missing allowlist entries, and their cause/attribution.
// ─────────────────────────────────────────────────────────────────────────────────────

describe("classifyRunFailure — the error classes that produced the live 93%-`internal` reading", () => {
  it("PersistentSshOutageError (~122 of 225 live failures) is NOT `internal` — and NOT a precondition", () => {
    // The single largest live failure class. Every occurrence landed on the opaque
    // `internal` default, so an SSH outage was indistinguishable from any other unknown
    // throw and three of them in a row read as one repeating state.
    const outage = new PersistentSshOutageError({ stuckSignature: "econnreset recurred", retriesObserved: 9 });
    // The fixture must be a REAL outage, not a husk: the constructor takes ONE object, and
    // the positional form silently produced an error whose every field was `undefined`
    // while still passing every assertion below (the classifier keys on `name` alone).
    expect(outage.stuckSignature).toBe("econnreset recurred");
    expect(outage.retriesObserved).toBe(9);
    const classified = classifyRunFailure(outage);
    expect(classified.code).not.toBe("internal");
    expect(classified).toMatchObject({ cause: "runner_ssh_outage", attribution: "environment" });
    // NOT a precondition. This class is the OUTPUT of `transientRetry.ts`'s own convergence
    // detector — its doc says "a proven fixed point" and its message says "NOT retrying a
    // fixed point forever". A precondition buys an UNBOUNDED re-drive whose rows are filtered
    // out of every convergence history, so tagging a proven fixed point with one discards the
    // proof and makes the loop unbounded again, one layer up. It takes the ordinary
    // convergence path instead: it re-drives, and a sustained outage parks.
    expect(classified.precondition).toBeUndefined();
  });

  it("MissingGithubCredentialRefError (49 live failures) is NOT `internal` — it is a github_credential precondition", () => {
    const classified = classifyRunFailure(new MissingGithubCredentialRefError("credential/github_token/org/o1/x"));
    expect(classified.code).not.toBe("internal");
    expect(classified).toMatchObject({
      cause: "github_credential_missing",
      attribution: "environment",
      precondition: "github_credential",
    });
  });

  it("MissingGithubAppCredentialRefError (20 live failures, previously a BARE Error) classifies at all", () => {
    // This throw used to be `new Error("missing GitHub App credential ref: …")`, so its
    // `error.name` was the generic "Error" and the classifier — which keys off the class
    // name and nothing else — structurally could not see it. A named class is the minimum
    // a failure needs in order to be attributable.
    const error = new MissingGithubAppCredentialRefError("credential/github_app/org/o1/default");
    expect(error.name).toBe("MissingGithubAppCredentialRefError");
    // The message is byte-identical to the previous bare throw (callers matching on text
    // keep matching), and `instanceof Error` still holds.
    expect(error.message).toBe("missing GitHub App credential ref: credential/github_app/org/o1/default");
    expect(error).toBeInstanceOf(Error);
    const classified = classifyRunFailure(error);
    expect(classified.code).not.toBe("internal");
    expect(classified).toMatchObject({
      cause: "github_app_credential_missing",
      attribution: "environment",
      precondition: "github_app_credential",
    });
  });

  it.each([408, 429, 502, 503, 504])(
    "RunStateWriteTransportError keeps the control_plane precondition on a %s — a status that asserts a retry",
    (status) => {
      // Attribution and precondition are INDEPENDENT axes. Attribution answers "who fixes the
      // bug" (tanren's own control plane); precondition answers "may this park". These
      // statuses say "come back later" in their own right, so the wait is supported.
      const error = new RunStateWriteTransportError(status, "/internal/append-event", "unavailable");
      // Same husk hazard, reversed: the signature is (status, endpoint, body).
      expect(error.status).toBe(status);
      expect(error.endpoint).toBe("/internal/append-event");
      expect(classifyRunFailure(error)).toMatchObject({
        cause: "control_plane_write_failed",
        attribution: "tanren",
        precondition: "control_plane",
      });
    },
  );

  it.each([400, 401, 403, 404, 409, 422, 500, 501])(
    "RunStateWriteTransportError DROPS the precondition on a %s — the status does not support the claim",
    (status) => {
      // The class is thrown on ANY non-2xx and the precondition used to be attached
      // statically. A permanent 500 from tanren's own defect — which is exactly what
      // `attribution: "tanren"` says it is — was then indistinguishable from a transient 503,
      // and looped forever on a fixed 30s cadence with no escalation and no convergence
      // signal, because precondition rows are excluded from both histories. The two axes
      // contradicted each other on the same row: "our bug" and "clears on its own".
      //
      // Dropping the precondition does NOT abandon it: it re-drives on the ordinary
      // convergence path, so a transient 500 still recovers unattended, and a permanent one
      // reaches a proven fixed point and parks.
      const error = new RunStateWriteTransportError(status, "/internal/append-event", "boom");
      const classified = classifyRunFailure(error);
      expect(classified).toMatchObject({ cause: "control_plane_write_failed", attribution: "tanren" });
      expect(classified.precondition).toBeUndefined();
    },
  );

  it("RunStateWriteTransportError with an unreadable status fails CLOSED to no precondition", () => {
    // The refinement reads a typed field off a known class. If it is not a number the claim
    // cannot be supported, and the conservative direction is the one that can still park:
    // parking is recoverable via an operator requeue, an invisible probe loop is not.
    const error = new RunStateWriteTransportError(503, "/internal/append-event", "unavailable");
    Object.defineProperty(error, "status", { value: "503", configurable: true });
    expect(classifyRunFailure(error).precondition).toBeUndefined();
  });

  it("RunnerClaimLiveRowError is TANREN's bug with NO precondition (nothing external clears it)", () => {
    const classified = classifyRunFailure(new RunnerClaimLiveRowError("runner_1"));
    expect(classified).toMatchObject({ cause: "runner_double_claim", attribution: "tanren" });
    expect(classified.precondition).toBeUndefined();
  });

  it("UnscopedOrgError stays a GENUINE terminal: tanren's bug, no precondition", () => {
    // This is why `GENUINE_TERMINAL_CODES` is not dead code after the precondition check
    // moved ahead of it — see the sibling assertion in runFinalizeAuthority.test.ts.
    const classified = classifyRunFailure(new UnscopedOrgError());
    expect(classified).toMatchObject({ cause: "credential_org_scope_lost", attribution: "tanren" });
    expect(classified.precondition).toBeUndefined();
  });

  it("attributes the workspace classes to the owner the class name can actually prove", () => {
    // The target repo's dependency graph failed to install in a clean container — a
    // repo-side reproducibility defect the repo can fix.
    const depsFailure = new WorkspaceDepsInstallError("/w/repo", "pnpm install", 1, "ERR_PNPM_NO_LOCKFILE", false);
    // Five arguments, not one: the single-string form built an error whose `command`,
    // `exitCode`, `outputTail` and `stalled` were all `undefined`, and whose message was
    // assembled from those. It classified correctly anyway — `name` is a class property —
    // so the assertion below passed against a husk.
    expect(depsFailure.command).toBe("pnpm install");
    expect(depsFailure.exitCode).toBe(1);
    expect(classifyRunFailure(depsFailure)).toMatchObject({
      cause: "workspace_deps_install_failed",
      attribution: "target_repo",
    });
  });

  it.each(["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"])(
    "an error named `%s` falls CLOSED — an Object.prototype member is NOT a classification",
    (inheritedName) => {
      // The lookup table is an object literal, so `BY_ERROR_NAME[error.name]` also resolves
      // members inherited from `Object.prototype`. Those are functions, so they are not
      // `undefined`, so a plain `!== undefined` guard would return one AS the classification —
      // and every field an event payload needs (`code`, `stage`, `summary`, `cause`,
      // `attribution`) would be `undefined` inside a strict payload schema. The module's whole
      // contract is that an unrecognized error falls closed to `internal`.
      const error = new Error("something broke");
      error.name = inheritedName;
      const classified = classifyRunFailure(error);
      expect(classified).toMatchObject({ code: "internal", cause: "unclassified", attribution: "unknown" });
      expect(typeof classified.summary).toBe("string");
    },
  );

  it("an unrecognized throw still falls CLOSED — `unclassified` / `unknown`, never message-derived", () => {
    const leaky = new Error("clone https://x-access-token:ghp_SECRET@github.com/acme/p.git failed");
    const classified = classifyRunFailure(leaky);
    expect(classified).toMatchObject({ code: "internal", cause: "unclassified", attribution: "unknown" });
    expect(JSON.stringify(classified)).not.toContain("ghp_SECRET");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// (4) THE SOURCE FILTER — precondition blocks are excluded from BOTH readers.
// ─────────────────────────────────────────────────────────────────────────────────────

/** A `pg.Pool` substitute serving a fixed `dag.spec.redriven` row list to the planner reader. */
function fixedPool(rows: Record<string, unknown>[]): pg.Pool {
  return {
    connect: async () => ({
      query: async (sql: string) => {
        if (sql.includes("SET LOCAL") || sql.startsWith("SET") || sql.startsWith("BEGIN") || sql.startsWith("COMMIT"))
          return { rows: [], rowCount: 0 };
        if (sql.includes("github.pr.created")) return { rows: [], rowCount: 0 };
        return {
          rows: rows.map((payload, i) => ({ payload, ts: new Date(1_700_000_000_000 + i).toISOString() })),
          rowCount: rows.length,
        };
      },
      release: () => {},
    }),
  } as never;
}

/** A `pg.PoolClient` substitute serving a fixed row list to the orphan reader. */
function fixedClient(rows: Record<string, unknown>[]): pg.PoolClient {
  return {
    query: async () => ({ rows: rows.map((payload) => ({ payload })), rowCount: rows.length }),
    release: () => {},
  } as unknown as pg.PoolClient;
}

const doubleClaimAtBootstrap: ClassifiedRunFailure = {
  code: "internal",
  stage: "bootstrap",
  summary: "the run's runner already carried a live claim",
  cause: "runner_double_claim",
  attribution: "tanren",
};

describe("precondition_block rows are excluded from the convergence history in BOTH readers", () => {
  it("planner reader: interleaved precondition blocks do not break an otherwise-proven cycle", async () => {
    // Two structural `runner_double_claim` priors + the current one is a cycle. If the
    // interleaved waits counted, the history would read as "a new state appeared between
    // structural re-drives" and the genuinely stuck spec would re-drive forever.
    const reader = buildRedriveHistoryReader(
      fixedPool([
        { failureCode: "internal", cause: "runner_double_claim", stage: "bootstrap" },
        { failureCode: "credential", cause: "github_credential_missing", source: "precondition_block" },
        { failureCode: "internal", cause: "runner_double_claim", stage: "bootstrap" },
        { failureCode: "credential", cause: "credential_missing", source: "precondition_block" },
      ]),
    );
    const result = await reader({
      orgId: "org_1",
      specId: "spec_1",
      code: "internal",
      stage: "bootstrap",
      cause: "runner_double_claim",
    });
    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" ? result.priorSameFixedPoint : -1).toBe(1);
  });

  it("planner reader: a history of ONLY precondition blocks reads as NO structural priors (progress)", async () => {
    const reader = buildRedriveHistoryReader(
      fixedPool([
        { failureCode: "credential", cause: "github_credential_missing", source: "precondition_block" },
        { failureCode: "credential", cause: "github_credential_missing", source: "precondition_block" },
        { failureCode: "credential", cause: "github_credential_missing", source: "precondition_block" },
      ]),
    );
    const result = await reader({
      orgId: "org_1",
      specId: "spec_1",
      code: "credential",
      stage: "credentials",
      cause: "github_credential_missing",
    });
    expect(result.kind === "ok" ? result.priorSameFixedPoint : -1).toBe(0);
  });

  it("orphan reader: a long precondition WAIT between two identical crashes must not hide the cycle", async () => {
    // DELIBERATELY DISCRIMINATING FIXTURE. A naive interleave (A, P, A, P + A) is NOT a
    // valid test of the filter: the latest `A` still recurs an earlier `A` inside the
    // detector's 8-attempt cycle window, so the verdict is `escalate` with or without the
    // filter — the assertion would pass against a broken filter. This fixture pads the wait
    // out to the FULL window, which is also the realistic shape (a spec that crashed twice,
    // then waited many probe cycles for a credential). Unfiltered, the eight waits push both
    // genuine crashes out of the window and the spec would re-drive forever; filtered, the
    // three identical crashes are the proven dead-end they are.
    const wait = {
      failureCode: "credential",
      cause: "github_credential_missing",
      stage: "credentials",
      source: "precondition_block",
    };
    const got = await readOrphanConsecutive(
      fixedClient([
        { failureCode: "internal", cause: "runner_double_claim", stage: "bootstrap" },
        { failureCode: "internal", cause: "runner_double_claim", stage: "bootstrap" },
        ...Array.from({ length: 8 }, () => ({ ...wait })),
      ]),
      "spec_1",
      doubleClaimAtBootstrap,
    );
    expect(got.kind === "ok" ? got.consecutive : -1).toBe(1);
  });

  it("orphan reader: a history of ONLY precondition blocks reads as NO structural priors (progress)", async () => {
    // Also deliberately discriminating: the CURRENT failure shares the waits' cause, so
    // WITHOUT the filter the three waits plus this attempt are a textbook cycle and the
    // spec parks — waiting would have manufactured its own fixed point, which is exactly
    // the live defect. WITH the filter there are no structural priors at all.
    const credentialMissing: ClassifiedRunFailure = {
      code: "credential",
      stage: "credentials",
      summary: "a required credential is missing",
      cause: "credential_missing",
      attribution: "environment",
      precondition: "credential",
    };
    const got = await readOrphanConsecutive(
      fixedClient([
        { failureCode: "credential", cause: "credential_missing", stage: "credentials", source: "precondition_block" },
        { failureCode: "credential", cause: "credential_missing", stage: "credentials", source: "precondition_block" },
        { failureCode: "credential", cause: "credential_missing", stage: "credentials", source: "precondition_block" },
      ]),
      "spec_1",
      credentialMissing,
    );
    expect(got.kind === "ok" ? got.consecutive : -1).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// (5) BACK-COMPAT — history written before this change still parses and still works.
// ─────────────────────────────────────────────────────────────────────────────────────

describe("back-compat: legacy dag.spec.redriven rows (no cause/attribution) keep working", () => {
  it("a legacy payload PARSES against the .strict() schema with the new fields absent", () => {
    const legacy = {
      specId: "spec_1",
      runId: "run_1",
      failureCode: "internal",
      stage: "run",
      consecutiveSameFailure: 1,
      backoffSeconds: 30,
    };
    expect(() => DagSpecRedrivenPayload.parse(legacy)).not.toThrow();
    const parsed = DagSpecRedrivenPayload.parse(legacy);
    expect(parsed.cause).toBeUndefined();
    expect(parsed.attribution).toBeUndefined();
    expect(parsed.precondition).toBeUndefined();
  });

  it("planner reader: a legacy history with NO cause still keys the signature off failureCode", async () => {
    // Two legacy `internal` rows + a current attempt whose signature is also `internal`
    // (supplied without a cause, as a pre-change caller would) ⇒ the cycle is still found.
    const reader = buildRedriveHistoryReader(
      fixedPool([
        { failureCode: "internal", stage: "run" },
        { failureCode: "internal", stage: "run" },
      ]),
    );
    const result = await reader({ orgId: "org_1", specId: "spec_1", code: "internal", stage: "run" });
    expect(result.kind === "ok" ? result.priorSameFixedPoint : -1).toBe(1);
    // And a DIFFERENT legacy code is still progress, exactly as before.
    const mixed = buildRedriveHistoryReader(
      fixedPool([
        { failureCode: "internal", stage: "run" },
        { failureCode: "merge", stage: "merge" },
      ]),
    );
    const progressed = await mixed({ orgId: "org_1", specId: "spec_1", code: "internal", stage: "run" });
    expect(progressed.kind === "ok" ? progressed.priorSameFixedPoint : -1).toBe(0);
  });

  it("orphan reader: a legacy history with NO cause still keys the signature off failureCode@stage", async () => {
    const legacyInternalAtRun: ClassifiedRunFailure = {
      code: "internal",
      stage: "run",
      summary: "the run failed with an internal error",
      cause: "unclassified",
      attribution: "unknown",
    };
    // The legacy rows key off `internal@run`; this attempt keys off `unclassified@run`, so
    // the transition reads as PROGRESS exactly once — a deliberate, one-time reset of stale
    // evidence when the classifier's vocabulary changed, never a permanent escape hatch.
    const transition = await readOrphanConsecutive(
      fixedClient([
        { failureCode: "internal", stage: "run" },
        { failureCode: "internal", stage: "run" },
      ]),
      "spec_1",
      legacyInternalAtRun,
    );
    expect(transition.kind === "ok" ? transition.consecutive : -1).toBe(0);
    // Once the history is written in the new shape, the cycle is found again.
    const settled = await readOrphanConsecutive(
      fixedClient([
        { failureCode: "internal", cause: "unclassified", stage: "run" },
        { failureCode: "internal", cause: "unclassified", stage: "run" },
      ]),
      "spec_1",
      legacyInternalAtRun,
    );
    expect(settled.kind === "ok" ? settled.consecutive : -1).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// (5) THE SCHEMA ENFORCES THE COUPLING — `precondition` and its `source` are ONE fact.
// ─────────────────────────────────────────────────────────────────────────────────────

describe("dag.spec.redriven — `precondition` is present exactly when the source is `precondition_block`", () => {
  const base = {
    specId: "spec_1",
    runId: "run_1",
    failureCode: "credential",
    stage: "credentials",
    consecutiveSameFailure: 0,
    backoffSeconds: 60,
  } as const;

  it("accepts the PAIR the producer actually writes", () => {
    const parsed = DagSpecRedrivenPayload.safeParse({
      ...base,
      source: "precondition_block",
      precondition: "github_credential",
      cause: "github_credential_missing",
      attribution: "environment",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a `precondition` carried on a STRUCTURAL re-drive", () => {
    // This is the dangerous half. A structural row is convergence EVIDENCE, so a
    // precondition smuggled onto one is a wait being counted as a strike — exactly the
    // accounting error that parked live specs for waiting on a credential.
    for (const source of [undefined, "workflow_redrive", "prober_resume"]) {
      const parsed = DagSpecRedrivenPayload.safeParse({
        ...base,
        ...(source === undefined ? {} : { source }),
        precondition: "github_credential",
      });
      expect(parsed.success, `source=${String(source)} must not carry a precondition`).toBe(false);
    }
  });

  it("rejects a `precondition_block` with NO named condition", () => {
    // The other half: an indefinite probe cadence whose blocking condition is anonymous.
    // The spec would re-drive forever and the timeline could never say what for.
    const parsed = DagSpecRedrivenPayload.safeParse({ ...base, source: "precondition_block" });
    expect(parsed.success).toBe(false);
  });

  it("still accepts a LEGACY row (no source, no precondition, no cause)", () => {
    expect(DagSpecRedrivenPayload.safeParse({ ...base, failureCode: "internal", stage: "run" }).success).toBe(true);
  });
});
