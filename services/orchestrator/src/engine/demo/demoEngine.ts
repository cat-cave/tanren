// The DEMO ENGINE — demos-as-evidence made real (design doc § "Native Deployment And
// Demos"). Given a DEPLOYED SURFACE and the spec's BEHAVIORS, it EXERCISES each
// behavior against the surface and records verifiable evidence PER BEHAVIOR. This is
// the production caller the `demo` role was missing: where `narration.ts` produces
// operator-facing PROSE, this produces the verifiable per-behavior EVIDENCE that
// prose then summarizes.
//
// The engine is provider-AGNOSTIC: it takes a `DemoSurface` (resolved by whichever
// DeployAdapter owns the deploy) and dispatches on the surface KIND. ALL FOUR surface
// kinds have real per-behavior exercise arms:
//   • `web_url`      — HTTP reachability of each behavior's described route.
//   • `package`      — registry metadata resolve for the coordinate (installability).
//   • `download`     — HTTP GET + streamed SHA-256 hash, verified against a behavior's
//                       declared `expectedSha256` when present.
//   • `app_channel`  — presence attested on the distribution channel for the buildRef
//                       (the adapter's verify step already confirmed availability;
//                       richer launch-and-drive on a device farm is a legitimate later
//                       extension the probe seam accommodates).
// Richer exercises (a scripted user flow, a JSON-shape assertion, a substrate-driven
// package invocation) slot in as probe extensions — never a refactor of this dispatch.
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
import { type DemoPackageProbe, exercisePackageBehavior } from "./demoPackageArm.js";
import { type DemoDownloadProbe, exerciseDownloadBehavior } from "./demoDownloadArm.js";
import { type DemoAppChannelProbe, exerciseAppChannelBehavior } from "./demoAppChannelArm.js";

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
  /**
   * The registry-metadata probe a `package` surface is exercised over. Optional at the
   * type level for tests that never encounter a package surface; missing at runtime
   * when the engine actually encounters one is a LOUD typed throw (via
   * {@link DemoProbeMissingError}) — never a silent skip.
   */
  packageProbe?: DemoPackageProbe;
  /**
   * The streamed-fetch + SHA-256 probe a `download` surface is exercised over.
   * Optional-with-loud-throw, same discipline as `packageProbe`.
   */
  downloadProbe?: DemoDownloadProbe;
  /**
   * The presence-reread probe an `app_channel` surface is exercised over.
   * Optional-with-loud-throw, same discipline as `packageProbe`.
   */
  appChannelProbe?: DemoAppChannelProbe;
}

/**
 * A LOUD, TYPED throw when the engine encounters a surface kind whose probe is not wired
 * — the honest failure that lets a caller (or a test) diagnose "the surface HAS an arm,
 * but its probe is not present in the DI graph" apart from the older "the surface kind
 * has no arm" family. Fixed non-secret message stem so the demo-on-deploy watcher can
 * refine the `demo.failed.reason` to `probe_unwired` when it lands (today it maps to
 * the more generic `exercise_failed`, which is already durable).
 */
export class DemoProbeMissingError extends Error {
  constructor(readonly surfaceKind: DemoSurface["kind"]) {
    super(`demoEngine: probe for surface kind '${surfaceKind}' is not wired into DemoEngineDeps`);
    this.name = "DemoProbeMissingError";
  }
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
          orgId: target.orgId,
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
        orgId: target.orgId,
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
      case "package": {
        if (this.deps.packageProbe === undefined) throw new DemoProbeMissingError("package");
        return exercisePackageBehavior(this.deps.packageProbe, surface, behavior);
      }
      case "download": {
        if (this.deps.downloadProbe === undefined) throw new DemoProbeMissingError("download");
        return exerciseDownloadBehavior(this.deps.downloadProbe, surface, behavior);
      }
      case "app_channel": {
        if (this.deps.appChannelProbe === undefined) throw new DemoProbeMissingError("app_channel");
        return exerciseAppChannelBehavior(this.deps.appChannelProbe, surface, behavior);
      }
      default: {
        const exhaustive: never = surface;
        throw new Error(`demoEngine: no exercise for surface kind '${(exhaustive as { kind: string }).kind}'`);
      }
    }
  }
}
