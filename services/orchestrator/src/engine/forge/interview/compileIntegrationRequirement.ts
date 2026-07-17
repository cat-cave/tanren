// in-5: the DETERMINISTIC requirement compiler.
//
// Maps a captured Forge behavior (Given/When/Then) + the project DesignContract
// to a typed `IntegrationRequirementV1` (the in-2 document — produced here, never
// redefined). The map is a pure, total function of the inputs: the same behavior
// text + design contract always compiles to the SAME requirement, hence the SAME
// content digest, so a second (real-id) compilation hash-matches the provisional
// one (integrations spec §A). Nothing here reads a clock, a random source, or a
// row id — the requirement document carries only the STABLE behavior key, never a
// materialized behavior_revision id, so provisional and materialized compilations
// are byte-identical.
//
// DOCTRINE — no vacuous requirement, no guessed provider. A behavior that invokes
// no external integration compiles to `no_integration` (the caller simply persists
// nothing). A behavior that DOES invoke an integration but is ambiguous or
// unobservable (no resolvable provider, conflicting providers, a design contract
// that forbids the only candidate, multiple integration families in one behavior)
// compiles to `ambiguous` — a LOUD typed failure the caller must surface, never a
// fabricated best-guess row.

import type { Digest } from "../../contracts/cas.js";
import {
  type IntegrationRequirementIssue,
  type IntegrationRequirementV1,
  integrationRequirementDigest,
  parseIntegrationRequirement,
} from "../../contracts/integrationRequirement.js";
import { behaviorKey } from "./deriveDesignContract.js";
import type { CaptureBehavior, CaptureDesignContract } from "./types.js";

/** The policy revision this compiler encodes; stored on the requirement row. */
export const INTEGRATION_REQUIREMENT_POLICY_VERSION = "in-5.requirement-compiler.v1" as const;

/** The outcome of compiling one behavior. A discriminated, total result. */
export type IntegrationRequirementCompilation =
  | {
      readonly kind: "requirement";
      readonly requirement: IntegrationRequirementV1;
      readonly desiredStateHash: Digest;
      readonly behaviorKey: string;
    }
  | { readonly kind: "no_integration"; readonly reason: string }
  | { readonly kind: "ambiguous"; readonly issues: readonly IntegrationRequirementIssue[] };

/** Thrown by the persistence hook when compilation is ambiguous — fail loud. */
export class AmbiguousIntegrationRequirementError extends Error {
  public override readonly name = "AmbiguousIntegrationRequirementError";
  public readonly issues: readonly IntegrationRequirementIssue[];

  public constructor(behaviorKey: string, issues: readonly IntegrationRequirementIssue[]) {
    super(
      `integration requirement for behavior '${behaviorKey}' is ambiguous/unobservable and cannot be compiled ` +
        `without guessing: ${issues.map((i) => i.message).join("; ")}`,
    );
    this.issues = issues;
  }
}

// ── deterministic signal tables ─────────────────────────────────────────────

/** The integration capability families this compiler can derive, keyword-keyed. */
const CAPABILITY_KEYWORDS: ReadonlyArray<{ readonly capability: string; readonly keywords: readonly string[] }> = [
  {
    capability: "messaging.send",
    keywords: ["slack", "discord", "telegram", "message", "notify", "notification", "post ", "chat", "celebrat", "announce", "alert", "broadcast"],
  },
  {
    capability: "errors.capture",
    keywords: ["sentry", "rollbar", "bugsnag", "exception", "crash", "stack trace", "stacktrace", "capture error", "report error"],
  },
];

/** Providers compatible with each capability family (the only ones we resolve). */
const CAPABILITY_PROVIDERS: Readonly<Record<string, readonly string[]>> = {
  "messaging.send": ["slack", "discord", "telegram"],
  "errors.capture": ["sentry", "rollbar", "bugsnag"],
};

/** Every provider token we recognize in behavior/design text. */
const PROVIDER_TOKENS: readonly string[] = [
  ...CAPABILITY_PROVIDERS["messaging.send"]!,
  ...CAPABILITY_PROVIDERS["errors.capture"]!,
];

function normalizeText(behavior: CaptureBehavior): string {
  return `${behavior.title} ${behavior.given} ${behavior.when} ${behavior.then}`.toLowerCase();
}

function detectCapabilityFamilies(text: string): string[] {
  const families: string[] = [];
  for (const entry of CAPABILITY_KEYWORDS) {
    if (entry.keywords.some((kw) => text.includes(kw))) families.push(entry.capability);
  }
  return families;
}

function detectProviders(text: string): string[] {
  // Word-boundary match so "slackness" does not resolve "slack". Deterministic
  // insertion order (PROVIDER_TOKENS order), de-duplicated.
  const found: string[] = [];
  for (const token of PROVIDER_TOKENS) {
    const re = new RegExp(`\\b${token}\\b`, "u");
    if (re.test(text) && !found.includes(token)) found.push(token);
  }
  return found;
}

/**
 * Providers the design contract explicitly forbids. Deterministic scan of the
 * constraints + principles for a negative verb near a known provider token.
 */
function forbiddenProviders(design: CaptureDesignContract | null): Set<string> {
  const forbidden = new Set<string>();
  if (design === null) return forbidden;
  const lines = [...design.constraints, ...design.principles].map((l) => l.toLowerCase());
  for (const line of lines) {
    for (const token of PROVIDER_TOKENS) {
      const re = new RegExp(`\\b(no|not|never|avoid|forbid|forbidden|do not use|don't use)\\b[^.]*\\b${token}\\b`, "u");
      if (re.test(line)) forbidden.add(token);
    }
  }
  return forbidden;
}

function detectTriggerKind(text: string): "user_action" | "http" | "schedule" | "event" | "threshold" {
  // Order is load-bearing: a "100th click" is a THRESHOLD, not a user_action.
  if (/\b(cross|crosses|crossed|reach|reaches|reached|exceed|exceeds|threshold|\d{2,})\b/u.test(text)) return "threshold";
  if (/\b(schedule|scheduled|every|daily|hourly|weekly|nightly|cron)\b/u.test(text)) return "schedule";
  if (/\b(http|https|endpoint|api request|webhook|get request|post request)\b/u.test(text)) return "http";
  if (/\b(click|clicks|submit|submits|press|presses|tap|taps|select|selects)\b/u.test(text)) return "user_action";
  return "event";
}

function detectDirection(text: string): "inbound" | "outbound" | "bidirectional" {
  if (/\b(bidirectional|two-way|two way|both directions)\b/u.test(text)) return "bidirectional";
  if (/\b(receive|receives|incoming|inbound|listen for)\b/u.test(text)) return "inbound";
  return "outbound";
}

// ── per-capability requirement builders ─────────────────────────────────────

interface BuildContext {
  readonly capability: string;
  readonly provider: string;
  readonly direction: "inbound" | "outbound" | "bidirectional";
  readonly triggerKind: "user_action" | "http" | "schedule" | "event" | "threshold";
  readonly behavior: CaptureBehavior;
  readonly behaviorKey: string;
  readonly providerPolicyForbidden: readonly string[];
}

function baseTrigger(ctx: BuildContext) {
  const given = ctx.behavior.given.trim();
  const when = ctx.behavior.when.trim();
  return {
    version: 1 as const,
    kind: ctx.triggerKind,
    description: ctx.behavior.title.trim(),
    ...(given !== "" ? { given } : {}),
    ...(when !== "" ? { when } : {}),
    behaviorKey: ctx.behaviorKey,
  };
}

function providerPolicy(ctx: BuildContext) {
  return {
    preferred: [ctx.provider],
    allowed: [ctx.provider],
    ...(ctx.providerPolicyForbidden.length > 0 ? { forbidden: [...ctx.providerPolicyForbidden] } : {}),
  };
}

function buildMessagingSend(ctx: BuildContext): IntegrationRequirementV1 {
  const pu = ctx.provider.toUpperCase();
  return {
    version: 1,
    capability: "messaging.send",
    plane: "product",
    direction: ctx.direction,
    providerPolicy: providerPolicy(ctx),
    environments: ["test", "production"],
    trigger: baseTrigger(ctx),
    expectedEffect: {
      version: 1,
      plane: "product",
      provider: ctx.provider,
      observation: "message_in_channel",
      correlationFields: ["behaviorKey", "correlationId", "bindingGeneration", "deploySha"],
      independent: true,
    },
    requiredOperations: ["chat.postMessage", "conversations.history"],
    requiredScopes: ["chat:write", "channels:history"],
    bindingOutputs: [
      {
        version: 1,
        kind: "product.messaging.relay_binding_id",
        logicalKey: `${pu}_PRODUCT_BINDING_ID`,
        classification: "handle",
        required: true,
        description: "Managed relay binding; the provider token never reaches product code",
      },
      {
        version: 1,
        kind: "product.messaging.channel_id",
        logicalKey: `${pu}_PRODUCT_CHANNEL_ID`,
        classification: "plain",
        required: true,
      },
    ],
    validation: {
      version: 1,
      preMerge: { contractTests: true, recordingFake: true, negativeControls: true, liveProviderInMergeGate: false },
      postDeploy: { liveStimulus: true, independentObservation: true },
      negativeControls: ["stimulus_below_threshold_no_effect", "retry_no_duplicate", "cross_org_denied"],
    },
    criticality: "release_required",
  };
}

function buildErrorsCapture(ctx: BuildContext): IntegrationRequirementV1 {
  const pu = ctx.provider.toUpperCase();
  return {
    version: 1,
    capability: "errors.capture",
    plane: "product",
    direction: ctx.direction,
    providerPolicy: providerPolicy(ctx),
    environments: ["test", "production"],
    trigger: baseTrigger(ctx),
    expectedEffect: {
      version: 1,
      plane: "product",
      provider: ctx.provider,
      observation: "error_event_ingested",
      correlationFields: ["behaviorKey", "correlationId", "deploySha"],
      independent: true,
    },
    requiredOperations: ["store.event"],
    requiredScopes: ["event:write"],
    bindingOutputs: [
      {
        version: 1,
        kind: "product.errors.dsn_ref",
        logicalKey: `${pu}_DSN`,
        classification: "secret_ref",
        required: true,
        description: "Product error-reporting DSN reference; resolved from the org grant, never inlined",
      },
    ],
    validation: {
      version: 1,
      preMerge: { contractTests: true, recordingFake: true, negativeControls: true, liveProviderInMergeGate: false },
      postDeploy: { liveStimulus: true, independentObservation: true },
      negativeControls: ["healthy_request_no_ingest", "cross_org_denied"],
    },
    criticality: "best_effort",
  };
}

function buildRequirement(ctx: BuildContext): IntegrationRequirementV1 {
  switch (ctx.capability) {
    case "messaging.send":
      return buildMessagingSend(ctx);
    case "errors.capture":
      return buildErrorsCapture(ctx);
    default:
      // Unreachable: capability is drawn from CAPABILITY_KEYWORDS, both of which
      // have builders. A future family without a builder is a programming error.
      throw new Error(`no requirement builder for capability '${ctx.capability}'`);
  }
}

function ambiguous(path: string, code: string, message: string): IntegrationRequirementCompilation {
  return { kind: "ambiguous", issues: [{ path, code, message }] };
}

/**
 * Compile one captured behavior (+ optional design contract) to a typed
 * integration requirement. Pure and deterministic: recompiling with identical
 * inputs yields an identical requirement and identical `desiredStateHash`.
 */
export function compileIntegrationRequirement(
  behavior: CaptureBehavior,
  design: CaptureDesignContract | null,
): IntegrationRequirementCompilation {
  const key = behaviorKey(behavior.persona, behavior.title);
  const text = normalizeText(behavior);

  const families = detectCapabilityFamilies(text);
  if (families.length === 0) {
    return { kind: "no_integration", reason: "behavior invokes no external integration capability" };
  }
  if (families.length > 1) {
    return ambiguous(
      "capability",
      "multiple_integration_families",
      `behavior invokes multiple integration families (${families.join(", ")}); split it into one behavior per integration`,
    );
  }
  const capability = families[0]!;
  const compatibleProviders = CAPABILITY_PROVIDERS[capability]!;

  const detected = detectProviders(text);
  const candidates = detected.filter((p) => compatibleProviders.includes(p));
  if (candidates.length === 0) {
    return ambiguous(
      "providerPolicy",
      "provider_unresolved",
      `behavior needs '${capability}' but names no ${capability} provider — refusing to guess a provider`,
    );
  }
  if (candidates.length > 1) {
    return ambiguous(
      "providerPolicy",
      "provider_conflict",
      `behavior names multiple ${capability} providers (${candidates.join(", ")}); specify exactly one`,
    );
  }
  const provider = candidates[0]!;

  const forbidden = forbiddenProviders(design);
  if (forbidden.has(provider)) {
    return ambiguous(
      "providerPolicy.forbidden",
      "provider_forbidden_by_design",
      `the design contract forbids provider '${provider}', the only resolvable provider for '${capability}'`,
    );
  }
  // Forbidden providers OTHER than the selected one are surfaced on the policy.
  const providerPolicyForbidden = [...forbidden].filter((p) => p !== provider).sort();

  const requirement = buildRequirement({
    capability,
    provider,
    direction: detectDirection(text),
    triggerKind: detectTriggerKind(text),
    behavior,
    behaviorKey: key,
    providerPolicyForbidden,
  });

  // Guarantee the compiled document is a valid in-2 requirement. A build that
  // fails the schema/semantic rules is a compiler bug — fail closed (ambiguous),
  // never emit an invalid or wrong-plane requirement.
  const validated = parseIntegrationRequirement(requirement);
  if (!validated.ok) {
    return { kind: "ambiguous", issues: validated.issues };
  }

  return {
    kind: "requirement",
    requirement: validated.requirement,
    desiredStateHash: integrationRequirementDigest(validated.requirement),
    behaviorKey: key,
  };
}
