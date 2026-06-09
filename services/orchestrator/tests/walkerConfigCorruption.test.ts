// no_silent_fallbacks (LOUD-DEFAULT) — the walker's speculation-config resolver.
//
// The speculation threshold / depth cap gate WORK (eagerness), NOT MERGE, so a
// corrupt PRESENT config is genuinely SAFE to fall back to the schema default — but
// the corruption must NOT be silent. The resolver logs LOUD and emits a
// `dag.config.corrupt` observability event, then proceeds with the default. An
// ABSENT config (`{}`) is not corruption and uses the default WITHOUT the event.

import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSpeculationConfigResolver } from "../src/engine/dag/walker.js";
import type { DagEventEmitter } from "../src/engine/dag/walker.js";

// A fake pool whose `SELECT config FROM projects` returns a configured blob. Mirrors
// the `runWithSystemScope` no-system-pool fallback (BEGIN/COMMIT are no-ops; the
// SELECT delegates to the configured row).
function fakePoolReturningConfig(config: unknown): pg.Pool {
  const query = async (sql: string) => {
    const trimmed = sql.trim().toUpperCase();
    if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (trimmed.startsWith("SELECT CONFIG FROM PROJECTS")) {
      return { rows: [{ config }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release: () => {} } as unknown as pg.PoolClient;
  return { connect: async () => client, query } as unknown as pg.Pool;
}

// A fake emitter that records only the corruption event (the resolver never calls
// the other methods). Cast through the full interface for the resolver's param.
function recordingEmitter() {
  const calls: Array<{ projectId: string; knob: string; appliedDefault: unknown; reason: string }> = [];
  const emitter = {
    emitConfigCorrupt: async (input: {
      projectId: string;
      knob: "speculation_config";
      appliedDefault: { threshold: string; depthCap: number };
      reason: string;
    }) => {
      calls.push(input);
    },
  } as unknown as DagEventEmitter;
  return { emitter, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildSpeculationConfigResolver — corrupt config is LOUD, not silent", () => {
  it("a CORRUPT present config: logs + emits dag.config.corrupt, then applies the safe default", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { emitter, calls } = recordingEmitter();
    // version 99 is unsupported → migrateProjectConfig throws (corruption).
    const resolve = buildSpeculationConfigResolver(fakePoolReturningConfig({ version: 99 }), emitter);

    const result = await resolve("project_corrupt");

    // Safe default applied (moderate / depth 2 — the same a fresh project carries).
    expect(result).toEqual({ threshold: "moderate", depthCap: 2 });
    // LOUD: logged.
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.join(" ")).toMatch(/corrupt project config/iu);
    // LOUD: surfaced as an observability event with the applied default + reason.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      projectId: "project_corrupt",
      knob: "speculation_config",
      appliedDefault: { threshold: "moderate", depthCap: 2 },
    });
    expect(calls[0]?.reason).toBeTruthy();
  });

  it("an ABSENT config ({}) uses the default WITHOUT logging or emitting (not corruption)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { emitter, calls } = recordingEmitter();
    const resolve = buildSpeculationConfigResolver(fakePoolReturningConfig({}), emitter);

    const result = await resolve("project_fresh");

    expect(result).toEqual({ threshold: "moderate", depthCap: 2 });
    expect(warn).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("a CLEAN config returns its configured knobs (no event)", async () => {
    const { emitter, calls } = recordingEmitter();
    const resolve = buildSpeculationConfigResolver(
      fakePoolReturningConfig({ version: 1, speculationThreshold: "aggressive", speculativeIntegrationDepth: 4 }),
      emitter,
    );

    const result = await resolve("project_clean");

    expect(result).toEqual({ threshold: "aggressive", depthCap: 4 });
    expect(calls).toHaveLength(0);
  });
});
