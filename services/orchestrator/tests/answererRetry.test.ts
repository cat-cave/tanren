// Transient-tolerant retry for the PRE-BUILD template-creation answerer calls (v35).
//
// THE BUG (confirmed live): a single slow/timed-out codex call at the FIRST
// pre-build creation step (`tanren.template_research.v1`) used to fail the WHOLE
// derive terminally — one `Codex Answerer timed out for schema ...` →
// `TemplateRequiredError` halt → 409 — even though local codex was healthy and a
// retry usually succeeds (codex latency is variable, observed 168-282s, exceeding
// the prior 180s per-call ceiling). These run BEFORE the build DAG exists, so the
// unified-finalize re-drive (#582) + the per-spec retry do NOT cover them.
//
// THE FIX: the research answerer call now RETRIES a transient failure (timeout /
// transient transport / network blip) with bounded exponential backoff; only a
// PERSISTENT failure (across the bound, or a non-self-healing usage-limit) fails
// loud. The research-seam tests FAIL without the fix (today one timeout is terminal).

import { describe, expect, it } from "vitest";
import type { AnswererAdapter } from "../src/engine/providers/types.js";
import {
  isTransientAnswererError,
  PersistentAnswererOutageError,
  transientSignature,
  withAnswererRetry,
  wrapProviderResearcher,
} from "../src/engine/templates/index.js";
import { ResearchOutput } from "../src/engine/templates/creation/researchSchema.js";

const request = { stack: "ts-pnpm", runtime: "node", packageManager: "pnpm", deployTarget: "vercel" };

const groundedOutput: ResearchOutput = {
  researchSources: ["https://example.test/ts-best-practice", "https://example.test/tooling"],
  lifecycle: {
    bootstrap: "pnpm install",
    tier1: "pnpm typecheck && pnpm lint",
    tier2: "pnpm test",
    tier3: "pnpm test:e2e",
    build: "pnpm build",
    deploy: "pnpm deploy",
    toolchain: [
      { name: "node", version: "24" },
      { name: "pnpm", version: "11" },
    ],
  },
  tooling: {
    typecheck: true,
    lint: true,
    test: true,
    mutation: true,
    junit: true,
    bdd: true,
    mutationStep: "pnpm mutation",
  },
  summary: "modern TS/pnpm with tsgo + oxlint + vitest + stryker",
};

// An adapter whose Nth call behaves as scripted (throw `error` until `okOn`).
function scriptedAdapter(behavior: { throwUntil: number; error: () => Error }): {
  adapter: AnswererAdapter<ResearchOutput>;
  calls: () => number;
} {
  let calls = 0;
  const adapter: AnswererAdapter<ResearchOutput> = {
    kind: "answerer",
    cli: "fake",
    authRef: "test/research",
    async runAnswerer() {
      calls += 1;
      if (calls < behavior.throwUntil) {
        throw behavior.error();
      }
      return ResearchOutput.parse(groundedOutput);
    },
  };
  return { adapter, calls: () => calls };
}

describe("research seam — transient timeout RETRIES, persistent fails loud (v35)", () => {
  it("RETRIES a transient codex timeout then succeeds (one timeout is NOT terminal)", async () => {
    // The first two calls trip the per-call hang bound (the codex latency spike); the
    // third succeeds — exactly the variable-latency live case.
    const { adapter, calls } = scriptedAdapter({
      throwUntil: 3,
      error: () => new Error("Codex Answerer timed out for schema tanren.template_research.v1"),
    });
    const researcher = wrapProviderResearcher(adapter, { retry: { sleep: async () => {} } });
    const research = await researcher.research(request);
    expect(calls()).toBe(3);
    expect(research.researchSources).toEqual(groundedOutput.researchSources);
  });

  it("a PERSISTENT (identical, stuck) timeout surfaces LOUD on non-convergence — never infinite", async () => {
    const { adapter, calls } = scriptedAdapter({
      throwUntil: Number.POSITIVE_INFINITY,
      error: () => new Error("Codex Answerer timed out for schema tanren.template_research.v1"),
    });
    // The IDENTICAL "timeout" signal recurring at the saturated backoff is a proven
    // outage — it surfaces loud as a PersistentAnswererOutageError (no infinite loop,
    // and no fixed attempt count — it escalates only once the curve has saturated).
    const researcher = wrapProviderResearcher(adapter, { retry: { sleep: async () => {} } });
    await expect(researcher.research(request)).rejects.toBeInstanceOf(PersistentAnswererOutageError);
    // The retries ran past the old 4-attempt cap (the curve saturates at 4 entries,
    // then the 5th identical signal proves the fixed point) — unbounded-until-stuck.
    expect(calls()).toBeGreaterThan(4);
  });

  it("RETRIES a transient SSH-CONNECT failure then succeeds (apex v37 — never terminal)", async () => {
    // The live v37 finding: the FIRST template-research answerer failed with an
    // `ssh_failed` connect-establishment blip while the runner was momentarily saturated;
    // it must RETRY (the runner recovers in seconds), not halt template-creation fail-closed.
    const { adapter, calls } = scriptedAdapter({
      throwUntil: 2,
      error: () =>
        new Error(
          'Codex Answerer failed for schema tanren.template_research.v1: exit unknown failure={"kind":"ssh_failed","target":"tanren@runner:22","message":"SSH connection failed to establish within 30000ms"}',
        ),
    });
    const researcher = wrapProviderResearcher(adapter, { retry: { sleep: async () => {} } });
    const research = await researcher.research(request);
    expect(calls()).toBe(2);
    expect(research.researchSources).toEqual(groundedOutput.researchSources);
  });

  it("a SUSTAINED identical SSH-connect failure escalates LOUD as an outage (not on a count)", async () => {
    const { adapter, calls } = scriptedAdapter({
      throwUntil: Number.POSITIVE_INFINITY,
      error: () =>
        new Error(
          'Codex Answerer failed for schema tanren.template_research.v1: exit unknown failure={"kind":"ssh_failed","message":"SSH connection failed to establish within 30000ms"}',
        ),
    });
    const researcher = wrapProviderResearcher(adapter, { retry: { sleep: async () => {} } });
    await expect(researcher.research(request)).rejects.toBeInstanceOf(PersistentAnswererOutageError);
    // It retried past the saturation curve before the identical signal proved a fixed point —
    // an outage surfaces only on intelligent NON-convergence, never a hardcoded attempt cap.
    expect(calls()).toBeGreaterThan(4);
  });

  it("a PERSISTENT (non-transient) usage-limit fails LOUD immediately — no retry burned", async () => {
    const { adapter, calls } = scriptedAdapter({
      throwUntil: Number.POSITIVE_INFINITY,
      error: () => {
        const error = new Error("Codex usage limit reached for schema tanren.template_research.v1: resets at 5pm");
        error.name = "CodexUsageLimitError";
        return error;
      },
    });
    const researcher = wrapProviderResearcher(adapter, { retry: { sleep: async () => {} } });
    await expect(researcher.research(request)).rejects.toThrow(/usage limit/u);
    // A window-exhausted condition does not self-heal in seconds → loud on the first.
    expect(calls()).toBe(1);
  });
});

describe("withAnswererRetry — transient classification + bounded backoff", () => {
  it("classifies timeouts + transient transport/network errors as transient", () => {
    expect(isTransientAnswererError(new Error("Codex Answerer timed out for schema x"))).toBe(true);
    expect(isTransientAnswererError(new Error("HTTP 503 Service Unavailable"))).toBe(true);
    expect(isTransientAnswererError(new Error("read ECONNRESET"))).toBe(true);
    expect(isTransientAnswererError(new Error("socket hang up"))).toBe(true);
  });

  it("classifies an SSH-CONNECT / ssh_failed transport failure as transient (apex v37)", () => {
    expect(
      isTransientAnswererError(
        new Error(
          'Codex Answerer failed: exit unknown failure={"kind":"ssh_failed","message":"SSH connection failed to establish within 30000ms"}',
        ),
      ),
    ).toBe(true);
    // It keys to its OWN stable signature class (so a sustained-identical ssh-connect
    // failure converges to a fixed point, distinct from a generic timeout/transport blip).
    expect(transientSignature(new Error("SSH connection failed to establish within 30000ms"))).toBe("ssh-connect");
    expect(transientSignature(new Error('failure={"kind":"ssh_failed","message":"something"}'))).toBe("ssh-connect");
  });

  it("classifies a typed provider stall (AnswererStalledError) as transient", () => {
    const stalled = new Error("Answerer stalled (no sign of life) for schema x");
    stalled.name = "AnswererStalledError";
    expect(isTransientAnswererError(stalled)).toBe(true);
    expect(transientSignature(stalled)).toBe("stalled");
  });

  it("classifies usage-limit / auth / host-key / unknown errors as PERSISTENT (not retried)", () => {
    const usage = new Error("usage limit reached");
    usage.name = "CodexUsageLimitError";
    expect(isTransientAnswererError(usage)).toBe(false);
    expect(isTransientAnswererError(new Error("HTTP 401 Unauthorized"))).toBe(false);
    expect(isTransientAnswererError(new Error("something else entirely"))).toBe(false);
    // A host-key fingerprint mismatch rides an `ssh_failed` but is a GENUINE, non-self-healing
    // security/config failure — it must stay terminal, never retried as a transient blip.
    expect(
      isTransientAnswererError(
        new Error('failure={"kind":"ssh_failed","message":"SSH host key fingerprint mismatch for tanren@runner:22"}'),
      ),
    ).toBe(false);
  });

  it("backs off (exponential, saturating) between UNBOUNDED transient retries", async () => {
    const waits: number[] = [];
    let calls = 0;
    const value = await withAnswererRetry(
      async () => {
        calls += 1;
        if (calls < 4) {
          throw new Error("timed out");
        }
        return "ok";
      },
      {
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    expect(value).toBe("ok");
    // 3 backoff waits before the 4th (succeeding) attempt, the recoverable curve: 3s/10s/30s.
    // A CHANGING / clearing signal keeps retrying — no fixed attempt cap stopped it.
    expect(waits).toEqual([3_000, 10_000, 30_000]);
  });

  it("a CHANGING transient signal keeps retrying past saturation (progress, not a fixed point)", async () => {
    // The transient signal changes each attempt (timeout → 503 → reset → 504 → 502 …)
    // — that is PROGRESS, so the loop keeps retrying well past the saturated curve and
    // succeeds, never tripping the non-convergence escalation.
    const signals = [
      "timed out",
      "HTTP 503 Service Unavailable",
      "read ECONNRESET",
      "HTTP 504 Gateway Timeout",
      "HTTP 502 Bad Gateway",
      "socket hang up",
    ];
    let calls = 0;
    const value = await withAnswererRetry(
      async () => {
        if (calls < signals.length) {
          const message = signals[calls]!;
          calls += 1;
          throw new Error(message);
        }
        return "ok";
      },
      { sleep: async () => {} },
    );
    expect(value).toBe("ok");
    // It retried through all 6 distinct signals (past the 4-entry saturation) — a
    // changing signal is forward motion, so the fixed-point escalation never fired.
    expect(calls).toBe(signals.length);
  });
});
