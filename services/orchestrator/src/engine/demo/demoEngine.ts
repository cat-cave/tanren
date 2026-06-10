// The DEMO ENGINE — demos-as-evidence made real (design doc § "Native Deployment And
// Demos"). Given a DEPLOYED SURFACE and the spec's BEHAVIORS, it EXERCISES each
// behavior against the surface and records verifiable evidence PER BEHAVIOR. This is
// the production caller the `demo` role was missing: where `narration.ts` produces
// operator-facing PROSE, this produces the verifiable per-behavior EVIDENCE that
// prose then summarizes.
//
// The engine is provider-AGNOSTIC: it takes a `DemoSurface` (resolved by whichever
// DeployAdapter owns the deploy) and dispatches on the surface KIND. Today only the
// `web_url` arm exists (HTTP reachability of each behavior's described route); richer
// exercises (a scripted user flow, a JSON-shape assertion) and other surface kinds
// (package / app_channel / download) slot in as new arms — never a refactor.
//
// EVIDENCE → EVENTS: each behavior's verdict is emitted as a `demo.evidence.recorded`
// event (behavior id · surface kind · outcome · the captured detail) and the whole
// demo as a `demo.completed` summary (counts + the surface kind). Every field is
// NON-SECRET — an observable shape, never a token/credential/response body.
//
// HONEST, never a silent skip: a demo over a surface with ZERO behaviors records a
// `demo.completed` with zero counts (the operator sees the demo ran and found
// nothing to exercise) rather than returning invisibly. A per-behavior reach failure
// is recorded as FAILED evidence, not swallowed.

import { runWithJobOrgId } from "@tanren/db";
import type { DemoSurface } from "../contracts/deployAdapter.js";
import type { EventStore } from "../eventStore.js";
import { type BehaviorEvidence, type DemoWebProbe, exerciseWebBehavior } from "./demoEvidence.js";

/** A spec behavior the demo exercises — the row's id/title + its free-form metadata (carries `surfacePath`). */
export interface DemoBehavior {
  behaviorId: string;
  behaviorTitle: string;
  metadata: Record<string, unknown>;
}

/** The coordinates a demo records its evidence under (the merged run + its spec + the org scope). */
export interface DemoTarget {
  runId: string;
  specId: string;
  projectId: string;
  /** The org the tenant `events` writes are scoped under (RLS). */
  orgId: string;
}

/** The dependencies the demo engine runs over (the event sink + the surface-exercise probes). */
export interface DemoEngineDeps {
  /** The event store the per-behavior evidence + the demo summary are appended through. */
  events: EventStore;
  /** The HTTP reach probe a `web_url` surface is exercised over (scripted in tests). */
  webProbe: DemoWebProbe;
}

/** The in-memory result of a demo run — the per-behavior evidence + the pass/fail tally. */
export interface DemoResult {
  surfaceKind: DemoSurface["kind"];
  evidence: BehaviorEvidence[];
  passed: number;
  failed: number;
}

/**
 * The demo engine. `exercise` runs the spec's behaviors against the deployed surface,
 * records per-behavior evidence, and emits the evidence + a summary event — all under
 * the run's org scope so the tenant `events` writes are RLS-allowed.
 */
export class DemoEngine {
  constructor(private readonly deps: DemoEngineDeps) {}

  /**
   * Exercise `behaviors` against `surface`, recording evidence per behavior. Emits a
   * `demo.evidence.recorded` per behavior and a `demo.completed` summary. Returns the
   * in-memory result (the evidence + the tally) so a caller can layer narration on
   * top. Org-scoped throughout (RLS).
   */
  async exercise(
    target: DemoTarget,
    surface: DemoSurface,
    behaviors: ReadonlyArray<DemoBehavior>,
  ): Promise<DemoResult> {
    const evidence: BehaviorEvidence[] = [];
    for (const behavior of behaviors) {
      evidence.push(await this.exerciseOne(surface, behavior));
    }
    const passed = evidence.filter((entry) => entry.outcome === "passed").length;
    const failed = evidence.length - passed;

    await runWithJobOrgId(target.orgId, async () => {
      for (const entry of evidence) {
        await this.deps.events.append({
          runId: target.runId,
          specId: target.specId,
          projectId: target.projectId,
          eventType: "demo.evidence.recorded",
          payload: {
            behaviorId: entry.behaviorId,
            behaviorTitle: entry.behaviorTitle,
            surfaceKind: entry.surfaceKind,
            outcome: entry.outcome,
            detail: entry.detail,
          },
        });
      }
      await this.deps.events.append({
        runId: target.runId,
        specId: target.specId,
        projectId: target.projectId,
        eventType: "demo.completed",
        payload: { surfaceKind: surface.kind, behaviorCount: evidence.length, passed, failed },
      });
    });

    return { surfaceKind: surface.kind, evidence, passed, failed };
  }

  /** Dispatch a single behavior's exercise on the surface KIND (provider-agnostic). */
  private async exerciseOne(surface: DemoSurface, behavior: DemoBehavior): Promise<BehaviorEvidence> {
    switch (surface.kind) {
      case "web_url":
        return exerciseWebBehavior(this.deps.webProbe, surface.url, behavior);
      // The non-web surface kinds (package / app_channel / download) are RESOLVED by
      // their owning DeployAdapter classes (package_release / mobile_release /
      // manual_external), but a per-behavior EXERCISE for them (install-and-run a
      // package, drive an app-channel build, fetch-and-verify a download) is a separate
      // piece of demo-engine work. Until it lands, exercising one of these surfaces is a
      // LOUD throw — never a silent skip that would let a demo report "no evidence"
      // against a surface it cannot yet exercise. Each slots in here as a real exercise
      // arm — not a refactor.
      case "package":
      case "app_channel":
      case "download":
        throw new Error(
          `demoEngine: surface kind '${surface.kind}' is resolved by its deploy adapter but has no behavior exercise yet — ` +
            `the per-behavior exercise for non-web surfaces is not implemented`,
        );
      default: {
        const exhaustive: never = surface;
        throw new Error(`demoEngine: no exercise for surface kind '${String((exhaustive as { kind: string }).kind)}'`);
      }
    }
  }
}
