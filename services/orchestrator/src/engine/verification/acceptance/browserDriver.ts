/**
 * rv-26.6 (apex P6): the interactive BROWSER acceptance surface driver. Given a plan's
 * `clickInteractions` and the deployed dashboard's base URL, it drives a REAL browser
 * (through the {@link BrowserClickRunner} seam) to perform N clicks on a target selector
 * — apex P6's Gherkin: an operator clicks "Send notification" 100 times in the deployed
 * UI. Each CONFIRMED click emits one `behavior.action.observed` event through the
 * canonical {@link AcceptanceEventSink}, and the interaction's confirmed-click count is
 * returned as the observation `<interactionId>.clickCount` (so an assertion
 * `notify.clickCount equals 100` executes against a REAL count).
 *
 * It is a NEW impl behind the SAME `AcceptanceSurfaceDriver` contract the rv-6 HTTP
 * driver implements — added as a `browser`-surface driver alongside the `api` one, not a
 * refactor of it. It drives ONLY the public dashboard HTTP surface (the served URL); DB
 * reads are verification-only and belong to other stages.
 *
 * FAIL-CLOSED, NEVER FABRICATE (the P6 core invariant):
 *  - The base URL cannot be resolved (no deploy) ⇒ `unavailable`
 *    (inconclusive_infrastructure). No clicks are invented.
 *  - The browser cannot launch / the page is unreachable / a click cannot be confirmed ⇒
 *    the runner returns `{ ok: false }` and the driver returns `unavailable` — it emits
 *    NO `behavior.action.observed` events for that interaction and contributes NO
 *    clickCount observation, so the assertion cannot execute and can never be laundered
 *    into a pass on a short/fabricated count.
 *  - A runner that returns `ok: true` with a click count that does NOT exactly equal the
 *    requested clicks is a contract violation the driver catches by THROWING — never a
 *    silent short/over count.
 *
 * DOCTRINE (timeout-eradication): the click sequence is a bounded operation the runner
 * drives to completion; there is NO wall-clock deadline / retry cap / loop ceiling here.
 */

import type {
  AdapterUnavailableResult,
  DriverExecutionResult,
  DriverObservation,
} from "../../contracts/runtimeVerificationAdapters.js";
import type { RequiredSurface } from "../../contracts/runtimeVerificationPlan.js";
import type { AppendEventInput } from "../../eventStore.js";
import type { AcceptanceEventSink } from "./eventSink.js";
import type { AcceptanceBaseUrlResolver } from "./httpDriver.js";
import type { BrowserClickRunner } from "./browserClickRunner.js";
import type { AcceptanceDriveInput, AcceptanceSurfaceDriver, ClickInteractionSpec } from "./orchestrator.js";

const CLICK_COUNT_SELECTOR = "clickCount";

export interface BrowserAcceptanceDriverDependencies {
  readonly resolveBaseUrl: AcceptanceBaseUrlResolver;
  /** The REAL browser runtime (production: {@link buildPodmanBrowserClickRunner}). */
  readonly runner: BrowserClickRunner;
  /** The canonical event sink each confirmed click's `behavior.action.observed` is appended through. */
  readonly events: AcceptanceEventSink;
  /** The surface this driver serves; defaults to "browser". */
  readonly surface?: RequiredSurface;
  /** Injectable observation clock (tests); defaults to the wall clock. */
  readonly now?: () => string;
}

/** A runner failure the browser could not be exercised through is INFRA-inconclusive (never a pass). */
class BrowserSurfaceUnavailable {
  public constructor(public readonly result: AdapterUnavailableResult) {}
}

export class BrowserAcceptanceSurfaceDriver implements AcceptanceSurfaceDriver {
  public readonly surface: RequiredSurface;
  private readonly resolveBaseUrl: AcceptanceBaseUrlResolver;
  private readonly runner: BrowserClickRunner;
  private readonly events: AcceptanceEventSink;
  private readonly now: () => string;

  public constructor(dependencies: BrowserAcceptanceDriverDependencies) {
    this.surface = dependencies.surface ?? "browser";
    this.resolveBaseUrl = dependencies.resolveBaseUrl;
    this.runner = dependencies.runner;
    this.events = dependencies.events;
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async drive(input: AcceptanceDriveInput): Promise<DriverExecutionResult | AdapterUnavailableResult> {
    const resolved = await this.resolveBaseUrl.resolve(input);
    if (resolved.kind === "unresolved") {
      return { kind: "unavailable", outcome: "inconclusive_infrastructure", reason: resolved.reason };
    }
    const interactions = input.plan.clickInteractions ?? [];
    const observedAt = this.now();
    const observations: DriverObservation[] = [];
    // The shardId the rv-11 orchestrator stamps this behavior's events with is
    // `${planId}:0`; the driver's per-click events MUST share it so a proof stitches
    // the click stream to the same shard.
    const shardId = `${input.plan.planId}:0`;
    try {
      for (const interaction of interactions) {
        const confirmed = await this.driveInteraction(resolved.baseUrl, interaction);
        // Emit exactly one behavior.action.observed per CONFIRMED click — only after the
        // full requested count is confirmed, so a partial run never leaks a short stream.
        for (let emitted = 0; emitted < confirmed.length; emitted += 1) {
          await this.events.append(this.actionObservedEvent(input, shardId, interaction.interactionId));
        }
        observations.push({
          observationKind: "browser",
          subject: `${interaction.interactionId}.${CLICK_COUNT_SELECTOR}`,
          value: confirmed.length,
          observedAt,
        });
      }
    } catch (error) {
      if (error instanceof BrowserSurfaceUnavailable) return error.result;
      throw error;
    }
    return { kind: "executed", observations, providerChecksums: [] };
  }

  /**
   * Drive ONE interaction to a fully-confirmed click set or fail loud. Returns the
   * confirmed observations only when the runner reports `ok` AND the count EXACTLY equals
   * the requested clicks; any runner failure raises {@link BrowserSurfaceUnavailable}
   * (infra-inconclusive), and an ok-but-miscounted result THROWS (never a fabricated count).
   */
  private async driveInteraction(
    baseUrl: string,
    interaction: ClickInteractionSpec,
  ): Promise<readonly { readonly ordinal: number }[]> {
    const result = await this.runner.runClicks({
      url: baseUrl,
      selector: interaction.selector,
      clicks: interaction.clicks,
    });
    if (!result.ok) {
      throw new BrowserSurfaceUnavailable({
        kind: "unavailable",
        outcome: "inconclusive_infrastructure",
        reason: `browser interaction '${interaction.interactionId}' (${result.kind}): ${result.reason}`,
      });
    }
    if (result.observations.length !== interaction.clicks) {
      // Contract violation: a runner reported success with the wrong count. Fail LOUD —
      // never emit events / an observation for a fabricated or short click count.
      throw new Error(
        `browser runner returned ${String(result.observations.length)} confirmed clicks for interaction '${interaction.interactionId}' but ${String(interaction.clicks)} were requested`,
      );
    }
    return result.observations;
  }

  private actionObservedEvent(
    input: AcceptanceDriveInput,
    shardId: string,
    actionId: string,
  ): AppendEventInput<"behavior.action.observed"> {
    return {
      orgId: input.orgId,
      projectId: input.projectId,
      eventType: "behavior.action.observed",
      payload: {
        behaviorRevisionId: input.plan.behaviorRevisionId,
        shardId,
        actionId,
        surface: this.surface,
      },
    };
  }
}
