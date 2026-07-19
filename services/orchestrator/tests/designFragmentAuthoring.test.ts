// ds-3 (F2D) — the design-fragment authoring loop over the REAL ds-0/1/2 substrate.
//
// The validator here is the SHIPPED `buildDesignFragmentValidator` exercising the
// real `DesignVfs` (path safety + collision), the real DTCG resolver, and the real
// ds-2 `WebDesignTargetAdapter` capability check — never a mock. The writer seam is
// driven by a deterministic fixture (the SAME seam production wires to a live LLM
// via `wrapProviderDesignFragmentAuthorer`). Proves: happy-path persist + succeeded;
// fail-closed on an unvalidatable draft (traversal path / unsupported capability /
// wrong slot); and RETRACT-WITH-DELETE — a failed batch compose deletes the
// persisted rows so the store ends EMPTY.

import { describe, expect, it } from "vitest";
import type { AuthoringAuthorer } from "../src/engine/contracts/authoringKernel.js";
import {
  parseDesignFragmentSpec,
  type DesignFragmentSpecV1,
} from "../src/engine/design/system/designArtifactSchemas.js";
import { resolveDtcgTokens } from "../src/engine/design/system/dtcgResolver.js";
import { WebDesignTargetAdapter } from "../src/engine/design/system/webAdapter.js";
import {
  createDesignFragmentAuthoringEventFactory,
  DesignFragmentAuthoringFailedError,
  resolveDesignFragmentConfig,
  runDesignFragmentAuthoring,
  selectMissingDesignFragments,
  type CreateDesignFragmentInput,
  type DesignFragmentAuthoringEvent,
  type DesignFragmentDraftV1,
  type DesignFragmentPersistenceStore,
} from "../src/engine/design/system/authoring/index.js";

function webAdapter(): WebDesignTargetAdapter {
  return new WebDesignTargetAdapter({
    designSystemId: "system_web",
    releaseId: "release_web_1",
    tokens: resolveDtcgTokens({
      color: {
        background: { $type: "color", $value: "#ffffff" },
        border: { $type: "color", $value: "#d0d5dd" },
        foreground: { $type: "color", $value: "#101828" },
        primary: { $type: "color", $value: "#155eef" },
      },
      radius: { md: { $type: "dimension", $value: "0.375rem" } },
      space: { md: { $type: "dimension", $value: "0.5rem" } },
    }),
  });
}

/** In-memory conformant persistence — records rows + retract deletes so a test can
 * assert the store is EMPTY after a retract. */
class FakeStore implements DesignFragmentPersistenceStore {
  readonly rows = new Map<string, { orgId: string; id: string }>();
  readonly deletes: string[] = [];
  async createValidated(input: CreateDesignFragmentInput): Promise<{ persistedId: string }> {
    const id = input.fragment.fragmentReleaseId;
    if (this.rows.has(id)) throw new Error(`duplicate ${id}`);
    this.rows.set(id, { orgId: input.orgId, id });
    return { persistedId: id };
  }
  async deleteById(orgId: string, id: string): Promise<void> {
    this.deletes.push(id);
    this.rows.delete(id);
  }
}

function captureEvents() {
  const captured: DesignFragmentAuthoringEvent[] = [];
  return {
    captured,
    events: {
      factory: createDesignFragmentAuthoringEventFactory(),
      sink: { emit: async (event: DesignFragmentAuthoringEvent) => void captured.push(event) },
    },
  };
}

function requiredSpec(kind: string, label: string): DesignFragmentSpecV1 {
  return parseDesignFragmentSpec({
    kind,
    label,
    phase: "patterns-and-templates",
    version: "1.0.0",
    conformanceSuiteId: `${kind}.conformance.v1`,
  });
}

/** A valid draft for a slot, optionally writing a specific path (for collision tests). */
function validDraft(spec: DesignFragmentSpecV1, path = `components/${spec.label}.tsx`): DesignFragmentDraftV1 {
  return {
    kind: spec.kind,
    label: spec.label,
    phase: spec.phase,
    version: "1.0.0",
    targetCapabilities: ["shadcn"],
    requires: [],
    provides: [],
    dependsOn: [],
    conflicts: [],
    replaces: [],
    personaRefs: [],
    behaviorRefs: [],
    conformanceSuiteId: spec.conformanceSuiteId,
    operations: [
      {
        operation: "addComponent",
        path,
        fileKind: "component-source",
        mediaType: "text/plain",
        content: `export const Comp = () => null; // ${spec.kind}`,
        executable: false,
      },
    ],
  };
}

function authorerFor(
  draftFor: (spec: DesignFragmentSpecV1) => DesignFragmentDraftV1,
): AuthoringAuthorer<DesignFragmentSpecV1, DesignFragmentDraftV1> {
  return { author: async ({ spec }) => draftFor(spec) };
}

const CONTEXT = { orgId: "org1", createdBy: "tester" };

/** Narrow a captured event to a specific frozen type (non-conditional assertion). */
function eventOfType<T extends DesignFragmentAuthoringEvent["eventType"]>(
  events: readonly DesignFragmentAuthoringEvent[],
  type: T,
): Extract<DesignFragmentAuthoringEvent, { eventType: T }> {
  const found = events.find((e) => e.eventType === type);
  if (found === undefined) throw new Error(`expected an event of type ${type}`);
  return found as Extract<DesignFragmentAuthoringEvent, { eventType: T }>;
}

describe("ds-3 F2D — design fragment authoring", () => {
  it("selector: filters the required set against the present registry", () => {
    const required = [requiredSpec("surface/dashboard", "Dashboard"), requiredSpec("surface/settings", "Settings")];
    const missing = selectMissingDesignFragments(required, [{ kind: "surface/dashboard", label: "Dashboard" }]);
    expect(missing.map((s) => s.kind)).toEqual(["surface/settings"]);
  });

  it("HAPPY PATH: a valid draft validates against the real substrate, persists, and emits succeeded", async () => {
    const store = new FakeStore();
    const { captured, events } = captureEvents();
    const spec = requiredSpec("surface/dashboard", "Dashboard");
    const result = await runDesignFragmentAuthoring({
      missing: [spec],
      context: CONTEXT,
      deps: { authorer: authorerFor((s) => validDraft(s)), adapter: webAdapter(), store, events },
    });
    expect(result.failedIds).toEqual([]);
    expect(result.validated).toHaveLength(1);
    expect(store.rows.size).toBe(1);
    expect(store.deletes).toEqual([]);
    const succeeded = eventOfType(captured, "designFragment.authoring.succeeded");
    expect(succeeded.payload.fragmentReleaseId).toBe("org1:surface/dashboard-Dashboard:1.0.0");
    expect(succeeded.payload.fragmentDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(succeeded.envelope.orgId).toBe("org1");
  });

  it("FAIL-CLOSED (traversal): a draft with an unsafe path is REJECTED by the real DesignVfs and never persists", async () => {
    const store = new FakeStore();
    const { captured, events } = captureEvents();
    const spec = requiredSpec("surface/dashboard", "Dashboard");
    const result = await runDesignFragmentAuthoring({
      missing: [spec],
      context: CONTEXT,
      deps: { authorer: authorerFor((s) => validDraft(s, "../escape.tsx")), adapter: webAdapter(), store, events },
    });
    expect(result.validated).toEqual([]);
    expect(result.failedIds).toEqual(["surface/dashboard@Dashboard"]);
    expect(store.rows.size).toBe(0);
    expect(eventOfType(captured, "designFragment.authoring.failed")).toBeDefined();
    const attempt = eventOfType(captured, "designFragment.authoring.attempt");
    expect(attempt.payload.rejectionSignature).toContain("apply_plan_rejected");
  });

  it("FAIL-CLOSED (unsupported capability): the real web adapter rejects a bevy capability", async () => {
    const store = new FakeStore();
    const { events } = captureEvents();
    const spec = requiredSpec("surface/hud", "Hud");
    const bevyDraft = (s: DesignFragmentSpecV1): DesignFragmentDraftV1 => ({
      ...validDraft(s),
      targetCapabilities: ["bevy.tactical-hud"],
    });
    const result = await runDesignFragmentAuthoring({
      missing: [spec],
      context: CONTEXT,
      deps: { authorer: authorerFor(bevyDraft), adapter: webAdapter(), store, events },
    });
    expect(result.validated).toEqual([]);
    expect(result.failedIds).toEqual(["surface/hud@Hud"]);
    expect(store.rows.size).toBe(0);
    expect(result.failureReasons["surface/hud@Hud"]).toContain("capability_not_composable");
  });

  it("FAIL-CLOSED (wrong slot): a draft that authors a different kind is rejected", async () => {
    const store = new FakeStore();
    const { events } = captureEvents();
    const spec = requiredSpec("surface/dashboard", "Dashboard");
    const wrongSlot = (): DesignFragmentDraftV1 => validDraft(requiredSpec("surface/OTHER", "Other"));
    const result = await runDesignFragmentAuthoring({
      missing: [spec],
      context: CONTEXT,
      deps: { authorer: authorerFor(wrongSlot), adapter: webAdapter(), store, events },
    });
    expect(result.validated).toEqual([]);
    expect(result.failureReasons["surface/dashboard@Dashboard"]).toContain("wrong_slot_kind");
    expect(store.rows.size).toBe(0);
  });

  it("RETRACT-WITH-DELETE: a cross-fragment path collision fails the batch and the store ends EMPTY", async () => {
    const store = new FakeStore();
    const { captured, events } = captureEvents();
    const a = requiredSpec("surface/dashboard", "Dashboard");
    const b = requiredSpec("surface/settings", "Settings");
    // Both fragments write the SAME path — each per-fragment validate passes (fresh
    // VFS), but the whole-batch compose collides ⇒ retract BOTH persisted rows.
    const collidingDraft = (s: DesignFragmentSpecV1): DesignFragmentDraftV1 => validDraft(s, "components/shared.tsx");
    const result = await runDesignFragmentAuthoring({
      missing: [a, b],
      context: CONTEXT,
      deps: { authorer: authorerFor(collidingDraft), adapter: webAdapter(), store, events },
    });
    expect(result.validated).toEqual([]);
    expect(result.failedIds.sort()).toEqual(["surface/dashboard@Dashboard", "surface/settings@Settings"]);
    // The rows were persisted-as-validated, then RETRACTED — the store is now empty.
    expect(store.rows.size).toBe(0);
    expect(store.deletes.sort()).toEqual([
      "org1:surface/dashboard-Dashboard:1.0.0",
      "org1:surface/settings-Settings:1.0.0",
    ]);
    // No succeeded event fired for either unit; both got a failed terminal.
    expect(captured.filter((e) => e.eventType === "designFragment.authoring.succeeded")).toHaveLength(0);
    const failedEvents = captured.filter(
      (e): e is Extract<DesignFragmentAuthoringEvent, { eventType: "designFragment.authoring.failed" }> =>
        e.eventType === "designFragment.authoring.failed",
    );
    expect(failedEvents).toHaveLength(2);
    for (const failed of failedEvents) expect(failed.payload.reason).toContain("batch_compose_failed");
  });

  it("resolveDesignFragmentConfig HALTS LOUD when a fragment is missing and no authoring seam exists", async () => {
    const required = [requiredSpec("surface/dashboard", "Dashboard")];
    await expect(resolveDesignFragmentConfig({ required, present: [] })).rejects.toBeInstanceOf(
      DesignFragmentAuthoringFailedError,
    );
  });

  it("resolveDesignFragmentConfig authors the missing set and returns the validated fragments", async () => {
    const store = new FakeStore();
    const { events } = captureEvents();
    const required = [requiredSpec("surface/dashboard", "Dashboard")];
    const resolved = await resolveDesignFragmentConfig({
      required,
      present: [],
      runAuthoring: (missing) =>
        runDesignFragmentAuthoring({
          missing,
          context: CONTEXT,
          deps: { authorer: authorerFor((s) => validDraft(s)), adapter: webAdapter(), store, events },
        }),
    });
    expect(resolved.authored).toHaveLength(1);
    expect(store.rows.size).toBe(1);
  });
});
