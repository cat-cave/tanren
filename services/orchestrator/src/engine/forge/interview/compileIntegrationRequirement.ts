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
// DOCTRINE — strictly EVIDENCE-BASED, fail-closed, NEVER a guess:
//   - An integration requirement is derived ONLY when the behavior NAMES a known
//     external provider (slack/discord/sentry/…). Naming a provider is the strong
//     evidence; generic UI verbs ("a success message is shown", "notify the user",
//     "post the form") carry NO provider and compile to `no_integration` — the
//     live derive hook then no-ops. False positives (provisioning an integration
//     for an ordinary UI message) are strictly worse than misses, so this biases
//     hard toward `no_integration`.
//   - Provider-specific operations/scopes come from a VERIFIED per-provider
//     mapping. A recognized-but-unmapped provider (e.g. discord) is `ambiguous`
//     (unsupported) — we never stamp one provider's scopes onto another.
//   - Every emitted field is EVIDENCED. The trigger stimulus must be evidenced by
//     the G/W/T (threshold/schedule/http/user_action/event); an unevidenced
//     trigger is `ambiguous`, never a silent `event` default. `direction` is not
//     text-guessed — it is intrinsic to the capability (send/capture ⇒ outbound).
//   - `plane`, `environments`, `independent observation`, `criticality`, and the
//     negative-control set are explicit, documented COMPILER POLICY invariants
//     (they only tighten the proof obligation); they never fabricate a capability.

import type { Digest } from "../../contracts/cas.js";
import {
  type AppBindingOutputV1,
  type IntegrationCriticality,
  type IntegrationRequirementIssue,
  type IntegrationRequirementV1,
  integrationRequirementDigest,
  parseIntegrationRequirement,
} from "../../contracts/integrationRequirement.js";
import { behaviorKey } from "./deriveDesignContract.js";
import type { CaptureBehavior, CaptureDesignContract } from "./types.js";

/** The policy revision this compiler encodes; stored on the requirement row. */
export const INTEGRATION_REQUIREMENT_POLICY_VERSION = "in-5.requirement-compiler.v1" as const;

type IntegrationCapability = "messaging.send" | "errors.capture";

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

// ── VERIFIED provider mappings (the only providers we can honestly compile) ──

interface SupportedProvider {
  readonly capability: IntegrationCapability;
  readonly requiredOperations: readonly string[];
  readonly requiredScopes: readonly string[];
  readonly bindingOutputs: readonly AppBindingOutputV1[];
}

/**
 * Providers with a VERIFIED, canonical operation/scope mapping. Only these
 * compile to a concrete requirement. Extend this table (with real, verified
 * operation/scope strings) to add a provider — never approximate one.
 */
const SUPPORTED_PROVIDERS: Readonly<Record<string, SupportedProvider>> = {
  slack: {
    capability: "messaging.send",
    // Real Slack Web API: post the message, read it back for independent proof.
    requiredOperations: ["chat.postMessage", "conversations.history"],
    requiredScopes: ["chat:write", "channels:history"],
    bindingOutputs: [
      {
        version: 1,
        kind: "product.messaging.relay_binding_id",
        logicalKey: "SLACK_PRODUCT_BINDING_ID",
        classification: "handle",
        required: true,
        description: "Managed relay binding; the Slack token never reaches product code",
      },
      {
        version: 1,
        kind: "product.messaging.channel_id",
        logicalKey: "SLACK_PRODUCT_CHANNEL_ID",
        classification: "plain",
        required: true,
      },
    ],
  },
  sentry: {
    capability: "errors.capture",
    // Real Sentry ingest: store an event against the project DSN.
    requiredOperations: ["store.event"],
    requiredScopes: ["event:write"],
    bindingOutputs: [
      {
        version: 1,
        kind: "product.errors.dsn_ref",
        logicalKey: "SENTRY_DSN",
        classification: "secret_ref",
        required: true,
        description: "Product Sentry DSN reference; resolved from the org grant, never inlined",
      },
    ],
  },
};

/**
 * Providers we RECOGNIZE by name (so naming one is still strong integration
 * evidence) but do NOT have a verified operation/scope mapping for. They compile
 * to `ambiguous` (unsupported) rather than borrowing another provider's scopes.
 */
const UNSUPPORTED_PROVIDERS: Readonly<Record<string, IntegrationCapability>> = {
  discord: "messaging.send",
  telegram: "messaging.send",
  rollbar: "errors.capture",
  bugsnag: "errors.capture",
};

const ALL_KNOWN_PROVIDERS: readonly string[] = [
  ...Object.keys(SUPPORTED_PROVIDERS),
  ...Object.keys(UNSUPPORTED_PROVIDERS),
];

function capabilityOf(provider: string): IntegrationCapability {
  return SUPPORTED_PROVIDERS[provider]?.capability ?? UNSUPPORTED_PROVIDERS[provider]!;
}

/** The per-capability proof-obligation POLICY (documented, not GWT-guessed). */
const CAPABILITY_POLICY: Readonly<
  Record<
    IntegrationCapability,
    {
      readonly observation: string;
      readonly correlationFields: readonly string[];
      readonly criticality: IntegrationCriticality;
      readonly negativeControls: readonly string[];
    }
  >
> = {
  "messaging.send": {
    observation: "message_in_channel",
    correlationFields: ["behaviorKey", "correlationId", "bindingGeneration", "deploySha"],
    criticality: "release_required",
    negativeControls: ["stimulus_below_threshold_no_effect", "retry_no_duplicate", "cross_org_denied"],
  },
  "errors.capture": {
    observation: "error_event_ingested",
    correlationFields: ["behaviorKey", "correlationId", "deploySha"],
    criticality: "best_effort",
    negativeControls: ["healthy_request_no_ingest", "cross_org_denied"],
  },
};

// ── evidence extraction ─────────────────────────────────────────────────────

function normalizeText(behavior: CaptureBehavior): string {
  return `${behavior.title} ${behavior.given} ${behavior.when} ${behavior.then}`.toLowerCase();
}

// The ROOT-CAUSE fix: a provider token alone is NOT evidence — ordinary English
// ("don't slack off", "keep a sentry over the process", "slack tide") names a
// provider without invoking it. An integration requirement is classified only
// when the provider co-occurs with an explicit external-delivery SIGNAL: a
// delivery verb/preposition tied to the provider, or the provider named with a
// service noun ("slack channel", "sentry error", "post to slack", "report to
// sentry"). Family-specific delivery vocabulary keeps the collocation honest.
const FAMILY_SIGNAL: Readonly<Record<IntegrationCapability, { readonly verbs: string; readonly nouns: string }>> = {
  "messaging.send": {
    verbs:
      "post|posts|posted|posting|send|sends|sent|sending|message|messages|messaged|messaging|notify|notifies|notified|notifying|announce|announces|announced|announcing|broadcast|broadcasts|broadcasted|alert|alerts|alerted|ping|pings|pinged|deliver|delivers|delivered|publish|publishes|published|dm|drop|drops|dropped",
    nouns:
      "channel|channels|message|messages|notification|notifications|webhook|webhooks|workspace|workspaces|bot|bots|dm|dms|thread|threads|post|posts|announcement|announcements|integration",
  },
  "errors.capture": {
    verbs:
      "report|reports|reported|reporting|capture|captures|captured|capturing|send|sends|sent|sending|log|logs|logged|logging|track|tracks|tracked|tracking|ingest|ingests|ingested|forward|forwards|forwarded|push|pushes|pushed|record|records|recorded",
    nouns: "error|errors|exception|exceptions|event|events|issue|issues|dsn|crash|crashes|stack trace|stacktrace|integration",
  },
};

// Prepositions that mark a provider as a delivery destination/service.
const DELIVERY_PREPS = "to|into|in|on|onto|via|through|using|toward|towards";
// Optional article/possessive between a preposition and the provider.
const ARTICLE = "(?:the\\s+|our\\s+|a\\s+|an\\s+|my\\s+|your\\s+|their\\s+)?";

function providerHasIntegrationSignal(text: string, provider: string, family: IntegrationCapability): boolean {
  const sig = FAMILY_SIGNAL[family];
  // (a) provider immediately followed by a family service noun: "slack channel".
  if (new RegExp(`\\b${provider}\\b\\s*(?:'s\\s+)?(?:${sig.nouns})\\b`, "u").test(text)) return true;
  // (b) service noun … delivery prep … provider: "message … to slack", "error … in sentry".
  if (new RegExp(`\\b(?:${sig.nouns})\\b[\\s\\w]{0,24}?\\b(?:${DELIVERY_PREPS})\\b\\s+${ARTICLE}${provider}\\b`, "u").test(text)) {
    return true;
  }
  // (c) delivery verb … delivery prep … provider: "post … to slack", "report … to sentry".
  if (new RegExp(`\\b(?:${sig.verbs})\\b[^.]{0,40}?\\b(?:${DELIVERY_PREPS})\\b\\s+${ARTICLE}${provider}\\b`, "u").test(text)) {
    return true;
  }
  // (d) delivery verb immediately targeting the provider: "notify slack", "message discord".
  if (new RegExp(`\\b(?:${sig.verbs})\\b\\s+${ARTICLE}${provider}\\b`, "u").test(text)) return true;
  return false;
}

function detectProviders(text: string): string[] {
  // A provider is detected ONLY when it co-occurs with an integration signal (see
  // providerHasIntegrationSignal). Deterministic order (ALL_KNOWN_PROVIDERS).
  const found: string[] = [];
  for (const token of ALL_KNOWN_PROVIDERS) {
    if (found.includes(token)) continue;
    if (providerHasIntegrationSignal(text, token, capabilityOf(token))) found.push(token);
  }
  return found;
}

/**
 * Providers the design contract explicitly forbids. Handles natural constraint
 * phrasing in either order: a negative verb before the provider ("do not use
 * Slack", "instead of Slack") AND a negative predicate after it ("Slack is not
 * allowed", "Slack is forbidden").
 */
function forbiddenProviders(design: CaptureDesignContract | null): Set<string> {
  const forbidden = new Set<string>();
  if (design === null) return forbidden;
  const lines = [...design.constraints, ...design.principles].map((l) => l.toLowerCase());
  const before =
    "no|not|never|avoid|avoids|forbid|forbids|forbidden|ban|bans|banned|prohibit|prohibits|prohibited|disallow|disallows|disallowed|do not use|don't use|without|instead of";
  const after =
    "not allowed|not permitted|forbidden|banned|prohibited|disallowed|off[- ]limits|not to be used|is not|are not|is never|are never|is banned|is forbidden|is prohibited";
  for (const line of lines) {
    for (const token of ALL_KNOWN_PROVIDERS) {
      const negBefore = new RegExp(`\\b(?:${before})\\b[^.]{0,40}?\\b${token}\\b`, "u");
      const negAfter = new RegExp(`\\b${token}\\b[^.]{0,40}?\\b(?:${after})\\b`, "u");
      if (negBefore.test(line) || negAfter.test(line)) forbidden.add(token);
    }
  }
  return forbidden;
}

/**
 * The trigger stimulus kind, ONLY when the G/W/T evidences one. Returns
 * `undefined` when unevidenced — the caller then fails closed (ambiguous), never
 * a silent `event` fallback. A bare number is NOT a threshold: a threshold needs
 * a real quantity tied to a comparator/ordinal ("the 100th click", "after 5
 * failures", "crosses 100 clicks"). A version number or the word "hits" alone
 * ("API v2 hits production") is NOT a threshold.
 */
function detectTriggerKind(text: string): "user_action" | "http" | "schedule" | "event" | "threshold" | undefined {
  const ordinal = /\b\d+(?:st|nd|rd|th)\b/u.test(text);
  // A comparator/quantifier immediately governing a number ("reaches 100",
  // "after 5", "over 100", "at least 3").
  const quantifiedThreshold =
    /\b(?:cross|crosses|crossed|reach|reaches|reached|exceed|exceeds|exceeded|surpass|surpasses|surpassed|above|below|over|under|after|every|at least|more than|greater than|less than|fewer than|no more than|up to)\s+(?:the\s+)?\d+/u.test(
      text,
    );
  if (ordinal || quantifiedThreshold) return "threshold";
  if (/\b(every|daily|hourly|nightly|weekly|monthly|cron|scheduled|on a schedule)\b/u.test(text)) return "schedule";
  if (/\b(http|https|endpoint|webhook|api request|get request|post request|incoming request|inbound request)\b/u.test(text)) {
    return "http";
  }
  if (
    /\b(click|clicks|clicked|tap|taps|tapped|press|presses|pressed|submit|submits|submitted|select|selects|selected)\b/u.test(
      text,
    )
  ) {
    return "user_action";
  }
  if (
    /\b(occurs?|occurred|happens?|happened|is recorded|are recorded|is created|are created|is triggered|throws?|thrown|raises?|raised|fails?|failed|is received|are received|is detected)\b/u.test(
      text,
    )
  ) {
    return "event";
  }
  return undefined;
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

  // (1) STRONG evidence gate: an integration requirement needs a named provider.
  const detected = detectProviders(text);
  if (detected.length === 0) {
    return { kind: "no_integration", reason: "behavior names no external integration provider" };
  }

  const families = new Set(detected.map(capabilityOf));
  if (families.size > 1) {
    return ambiguous(
      "capability",
      "multiple_integration_families",
      `behavior names providers across multiple integration families (${detected.join(", ")}); split it into one behavior per integration`,
    );
  }
  if (detected.length > 1) {
    return ambiguous(
      "providerPolicy",
      "provider_conflict",
      `behavior names multiple providers (${detected.join(", ")}); specify exactly one`,
    );
  }
  const provider = detected[0]!;

  // (2) Only a VERIFIED provider mapping compiles — never approximate scopes.
  const supported = SUPPORTED_PROVIDERS[provider];
  if (supported === undefined) {
    return ambiguous(
      "providerPolicy",
      "provider_unsupported",
      `provider '${provider}' is recognized but has no verified operation/scope mapping for '${capabilityOf(provider)}'; refusing to fabricate its operations/scopes`,
    );
  }

  const forbidden = forbiddenProviders(design);
  if (forbidden.has(provider)) {
    return ambiguous(
      "providerPolicy.forbidden",
      "provider_forbidden_by_design",
      `the design contract forbids provider '${provider}', the only named provider for '${supported.capability}'`,
    );
  }
  const providerPolicyForbidden = [...forbidden].filter((p) => p !== provider).sort();

  // (3) The trigger stimulus must be EVIDENCED — no silent `event` default.
  const triggerKind = detectTriggerKind(text);
  if (triggerKind === undefined) {
    return ambiguous(
      "trigger.kind",
      "trigger_stimulus_unevidenced",
      "the behavior does not evidence a trigger stimulus (threshold/schedule/http/user_action/event); refusing to default one",
    );
  }

  const given = behavior.given.trim();
  const when = behavior.when.trim();
  const policy = CAPABILITY_POLICY[supported.capability];

  const requirement: IntegrationRequirementV1 = {
    version: 1,
    capability: supported.capability,
    plane: "product",
    // Intrinsic to the capability (send/capture ⇒ outbound); not a text default.
    direction: "outbound",
    providerPolicy: {
      preferred: [provider],
      allowed: [provider],
      ...(providerPolicyForbidden.length > 0 ? { forbidden: providerPolicyForbidden } : {}),
    },
    // POLICY: a product integration is proven in test + production.
    environments: ["test", "production"],
    trigger: {
      version: 1,
      kind: triggerKind,
      description: behavior.title.trim(),
      ...(given !== "" ? { given } : {}),
      ...(when !== "" ? { when } : {}),
      behaviorKey: key,
    },
    expectedEffect: {
      version: 1,
      plane: "product",
      provider,
      observation: policy.observation,
      correlationFields: [...policy.correlationFields],
      // POLICY: A3 always demands provider-independent observation.
      independent: true,
    },
    requiredOperations: [...supported.requiredOperations],
    requiredScopes: [...supported.requiredScopes],
    bindingOutputs: [...supported.bindingOutputs],
    validation: {
      version: 1,
      preMerge: { contractTests: true, recordingFake: true, negativeControls: true, liveProviderInMergeGate: false },
      postDeploy: { liveStimulus: true, independentObservation: true },
      negativeControls: [...policy.negativeControls],
    },
    criticality: policy.criticality,
  };

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
