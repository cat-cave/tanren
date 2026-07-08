// BUG1 seam test (apex v82) — the PRODUCTION lazy wrapper `defaultSpecQualityValidator`
// must expose AND forward BOTH `validate` AND `reAuthor` to the validator it resolves.
//
// The prior wrapper exposed ONLY `validate` and silently dropped `reAuthor`. Downstream,
// `resolveReviseSpec` (specQuality/stage.ts) falls back to `validator.reAuthor` when the
// triage path wires no emitter `reviseSpec` — with `reAuthor` undefined that fell to
// `undefined`, so `validateOne` escalated `PersistentlyInvalidSpecError` at round 0
// (never applying the guidance it produced). `specQualityContract.test.ts` drove a FAKE
// validator that already exposed `reAuthor`, so it never exercised the production
// wrapper — this is that missing seam.
//
// Seam (no module mocking, per the architecture lint): drive the wrapper with NO routing.
// Both methods route through the SAME lazy `ensure()` resolve, so BOTH must fail loud with
// the routing-required error. Before the fix, `reAuthor` was absent — calling it would
// throw a TypeError ("is not a function") rather than the routing-required message, which
// is exactly what the bug (a dropped `reAuthor`) looks like at this seam.

import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { defaultSpecQualityValidator } from "../src/engine/workflow/plannerRunAdapters.js";
import type { CandidateSpec } from "../src/engine/forge/specQuality/index.js";
import type { PlannerRunAdapterContext, RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:runner-host",
  identitySecretRef: "runner/test/identity",
};

class NoopSsh implements CommandSubstrate {
  async run(_target: RunnerHandle, _command: RunnerCommand): Promise<CommandResult> {
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

// A loop input whose context carries NO routing — the lazy `ensure()` resolve then fails
// loud with the routing-required error, for BOTH methods (proving both go through it).
function inputWithoutRouting(): RunPlannerLoopInput {
  return {
    secrets: new InMemorySecretStore(),
    ssh: new NoopSsh(),
    context: {
      runId: "run_1",
      specId: "spec_1",
      projectId: "project_1",
      repoUrl: "https://example.invalid/repo",
      targetBranch: "main",
      runBranch: "tanren/x",
      specTitle: "t",
      specDescription: "d",
      acceptanceCriteria: [],
      runnerImage: "img",
      identitySecretRef: "id",
      githubCredentialRef: "cred/gh",
      routing: undefined,
    },
  } as unknown as RunPlannerLoopInput;
}

const ctx: PlannerRunAdapterContext = { runId: "run_1", target, codexHome: "/home/tanren/.codex/run_1" };
const spec: CandidateSpec = { title: "opaque jargon", description: "d", acceptanceCriteria: [] };

describe("defaultSpecQualityValidator lazy wrapper — BUG1: forwards reAuthor", () => {
  it("exposes a reAuthor method (the wrapper no longer drops it)", () => {
    const validator = defaultSpecQualityValidator(inputWithoutRouting(), ctx);
    expect(typeof validator.reAuthor).toBe("function");
  });

  it("routes reAuthor through the SAME lazy resolve as validate (both fail loud on missing routing)", () => {
    const validator = defaultSpecQualityValidator(inputWithoutRouting(), ctx);
    // `validate` resolves lazily and fails loud (routing-required) when routing is absent.
    expect(() => validator.validate(spec)).toThrow(/routing is required/u);
    // …and `reAuthor` goes through the SAME `ensure()` — so it fails the SAME way, NOT
    // with a TypeError (which is what a dropped/undefined `reAuthor` would have produced).
    expect(() => validator.reAuthor!(spec, "split it")).toThrow(/routing is required/u);
  });
});
