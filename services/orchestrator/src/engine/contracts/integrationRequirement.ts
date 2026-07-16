/**
 * in-2: IntegrationRequirementV1 + validation plan + semantic plane rules +
 * domainHash identity. Sole document compile target for Forge → lifecycle.
 * Consumes SP-3 Digest/domainHash only — no second hash family.
 */

import { z } from "zod";
import type { CanonicalBody, Digest } from "./cas.js";
import { domainHash } from "./cas.js";
import {
  ALL_BINDING_OUTPUT_KINDS,
  AppBindingOutputV1Schema,
  CONTROL_BINDING_OUTPUT_KINDS,
  planeOfBindingKind,
  PRODUCT_BINDING_OUTPUT_KINDS,
  type AppBindingOutputV1,
  type BindingOutputKind,
} from "./integrationBindingOutput.js";
import {
  BehaviorStimulusContractV1Schema,
  IntegrationEffectContractV1Schema,
  type BehaviorStimulusContractV1,
  type IntegrationEffectContractV1,
} from "./integrationEffect.js";

export const INTEGRATION_REQUIREMENT_DOMAIN_TAG = "integration_requirement.v1" as const;

export const INTEGRATION_REQUIREMENT_MEDIA_TYPE = "application/vnd.tanren.integration-requirement.v1+json" as const;

export const INTEGRATION_PLANES = ["control", "product"] as const;
export type IntegrationPlane = (typeof INTEGRATION_PLANES)[number];

export const INTEGRATION_DIRECTIONS = ["inbound", "outbound", "bidirectional"] as const;
export type IntegrationDirection = (typeof INTEGRATION_DIRECTIONS)[number];

export const INTEGRATION_ENVIRONMENTS = ["test", "preview", "production"] as const;
export type IntegrationEnvironment = (typeof INTEGRATION_ENVIRONMENTS)[number];

export const INTEGRATION_CRITICALITIES = ["merge_required", "release_required", "best_effort"] as const;
export type IntegrationCriticality = (typeof INTEGRATION_CRITICALITIES)[number];

/** Capabilities with hard plane affinity (open string still allowed; these are catalogued). */
export const CONTROL_CAPABILITIES = ["control.notify", "control.inbox", "deploy.release"] as const;
export const PRODUCT_CAPABILITIES = ["messaging.send", "errors.capture", "auth.oauth"] as const;

export const IntegrationValidationPlanV1Schema = z
  .object({
    version: z.literal(1),
    preMerge: z
      .object({
        contractTests: z.boolean(),
        recordingFake: z.boolean(),
        negativeControls: z.boolean(),
        /** Live provider calls are forbidden as merge authority. */
        liveProviderInMergeGate: z.literal(false),
      })
      .strict(),
    postDeploy: z
      .object({
        liveStimulus: z.boolean(),
        independentObservation: z.boolean(),
      })
      .strict(),
    negativeControls: z.array(z.string().min(1).max(200)).max(32),
  })
  .strict();

export type IntegrationValidationPlanV1 = z.infer<typeof IntegrationValidationPlanV1Schema>;

export const ProviderPolicyV1Schema = z
  .object({
    preferred: z.array(z.string().min(1).max(64)).max(16).optional(),
    allowed: z.array(z.string().min(1).max(64)).max(32).optional(),
    forbidden: z.array(z.string().min(1).max(64)).max(32).optional(),
  })
  .strict();

export type ProviderPolicyV1 = z.infer<typeof ProviderPolicyV1Schema>;

export const IntegrationRequirementV1Schema = z
  .object({
    version: z.literal(1),
    capability: z.string().min(1).max(128),
    plane: z.enum(INTEGRATION_PLANES),
    direction: z.enum(INTEGRATION_DIRECTIONS),
    providerPolicy: ProviderPolicyV1Schema,
    environments: z.array(z.enum(INTEGRATION_ENVIRONMENTS)).min(1).max(3),
    trigger: BehaviorStimulusContractV1Schema,
    expectedEffect: IntegrationEffectContractV1Schema,
    requiredOperations: z.array(z.string().min(1).max(128)).min(1).max(64),
    requiredScopes: z.array(z.string().min(1).max(128)).min(1).max(64),
    bindingOutputs: z.array(AppBindingOutputV1Schema).min(1).max(32),
    validation: IntegrationValidationPlanV1Schema,
    criticality: z.enum(INTEGRATION_CRITICALITIES),
  })
  .strict();

export type IntegrationRequirementV1 = z.infer<typeof IntegrationRequirementV1Schema>;

export interface IntegrationRequirementIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type IntegrationRequirementValidation =
  | { readonly ok: true; readonly requirement: IntegrationRequirementV1 }
  | { readonly ok: false; readonly issues: readonly IntegrationRequirementIssue[] };

/** Reject strings that look like live credentials (never store/return secrets). */
const SECRET_SHAPED = /\b(xox[baprs]-|sk_live_|sk_test_|ghp_[A-Za-z0-9]|github_pat_|AKIA[0-9A-Z]{16}|-----BEGIN )/u;

function scanSecrets(value: unknown, path: string, issues: IntegrationRequirementIssue[]): void {
  if (typeof value === "string") {
    if (SECRET_SHAPED.test(value)) {
      issues.push({
        path,
        code: "secret_value_forbidden",
        message: "Requirement documents must not embed credential material",
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => scanSecrets(item, `${path}[${i}]`, issues));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      scanSecrets(v, path === "" ? k : `${path}.${k}`, issues);
    }
  }
}

function capabilityPlaneAffinity(capability: string): IntegrationPlane | "either" {
  if ((CONTROL_CAPABILITIES as readonly string[]).includes(capability)) return "control";
  if ((PRODUCT_CAPABILITIES as readonly string[]).includes(capability)) return "product";
  if (capability.startsWith("control.")) return "control";
  if (capability.startsWith("product.")) return "product";
  return "either";
}

function semanticIssues(req: IntegrationRequirementV1): IntegrationRequirementIssue[] {
  const issues: IntegrationRequirementIssue[] = [];
  scanSecrets(req, "", issues);

  const affinity = capabilityPlaneAffinity(req.capability);
  if (affinity !== "either" && affinity !== req.plane) {
    issues.push({
      path: "capability",
      code: "plane_capability_mismatch",
      message: `Capability '${req.capability}' requires plane '${affinity}', got '${req.plane}'`,
    });
  }

  if (req.expectedEffect.plane !== req.plane) {
    issues.push({
      path: "expectedEffect.plane",
      code: "effect_plane_mismatch",
      message: `expectedEffect.plane '${req.expectedEffect.plane}' must equal requirement plane '${req.plane}'`,
    });
  }

  for (let i = 0; i < req.bindingOutputs.length; i++) {
    const out = req.bindingOutputs[i]!;
    const kindPlane = planeOfBindingKind(out.kind as BindingOutputKind);
    if (kindPlane !== req.plane) {
      issues.push({
        path: `bindingOutputs[${i}].kind`,
        code: "binding_plane_mismatch",
        message:
          `Binding kind '${out.kind}' is ${kindPlane}-plane and cannot validate on ` +
          `${req.plane}-plane (control credentials never validate as product bindings)`,
      });
    }
    if (out.classification === "secret_ref" && !out.kind.endsWith("_ref") && !out.kind.endsWith("_id")) {
      // handle/plain ok; secret_ref should be a ref-shaped kind
      issues.push({
        path: `bindingOutputs[${i}].classification`,
        code: "secret_ref_kind_mismatch",
        message: `classification 'secret_ref' requires a ref-shaped binding kind, got '${out.kind}'`,
      });
    }
  }

  const policy = req.providerPolicy;
  const preferred = new Set(policy.preferred ?? []);
  const allowed = new Set(policy.allowed ?? []);
  const forbidden = new Set(policy.forbidden ?? []);

  for (const p of preferred) {
    if (forbidden.has(p)) {
      issues.push({
        path: "providerPolicy.preferred",
        code: "provider_preferred_forbidden",
        message: `Provider '${p}' is both preferred and forbidden`,
      });
    }
    if (allowed.size > 0 && !allowed.has(p)) {
      issues.push({
        path: "providerPolicy.preferred",
        code: "provider_preferred_not_allowed",
        message: `Preferred provider '${p}' is outside allowed`,
      });
    }
  }
  for (const p of allowed) {
    if (forbidden.has(p)) {
      issues.push({
        path: "providerPolicy.allowed",
        code: "provider_allowed_forbidden",
        message: `Provider '${p}' is both allowed and forbidden`,
      });
    }
  }

  if (req.validation.postDeploy.independentObservation && !req.expectedEffect.independent) {
    issues.push({
      path: "validation.postDeploy.independentObservation",
      code: "independent_observation_required",
      message: "postDeploy independentObservation requires expectedEffect.independent === true",
    });
  }

  if (req.validation.preMerge.liveProviderInMergeGate !== false) {
    issues.push({
      path: "validation.preMerge.liveProviderInMergeGate",
      code: "live_provider_merge_forbidden",
      message: "Live provider calls cannot be merge authority",
    });
  }

  // Classic wrong-plane Slack: product messaging cannot use control notify bot token.
  if (req.plane === "product" && req.capability === "messaging.send") {
    const controlKinds = req.bindingOutputs.filter((o) => o.kind.startsWith("control."));
    if (controlKinds.length > 0) {
      issues.push({
        path: "bindingOutputs",
        code: "control_credential_as_product_messaging",
        message: "Plane-A control notification credentials cannot validate as a product messaging binding",
      });
    }
  }

  return issues;
}

export function parseIntegrationRequirement(input: unknown): IntegrationRequirementValidation {
  const parsed = IntegrationRequirementV1Schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.length === 0 ? "(root)" : issue.path.join("."),
        code: "schema",
        message: issue.message,
      })),
    };
  }
  const issues = semanticIssues(parsed.data);
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, requirement: parsed.data };
}

/** Canonical body for domainHash — deterministic key order via object construction. */
export function toCanonicalRequirementBody(req: IntegrationRequirementV1): CanonicalBody {
  return req as unknown as CanonicalBody;
}

export function integrationRequirementDigest(req: IntegrationRequirementV1): Digest {
  return domainHash(INTEGRATION_REQUIREMENT_DOMAIN_TAG, toCanonicalRequirementBody(req));
}

export function canonicalRequirementBytes(req: IntegrationRequirementV1): Uint8Array {
  // Stable stringify matching SP-3 key sort (domainHash uses sorted keys internally;
  // stored bytes are the validated document JSON with sorted keys for durability).
  return new TextEncoder().encode(stableStringify(req as unknown as CanonicalBody));
}

function stableStringify(value: CanonicalBody): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON cannot contain a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const objectValue = value as { readonly [k: string]: CanonicalBody };
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key]!)}`)
    .join(",")}}`;
}

export interface IntegrationContractCatalogV1 {
  readonly missionNodeId: "in-2";
  readonly version: 1;
  readonly planes: readonly IntegrationPlane[];
  readonly directions: readonly IntegrationDirection[];
  readonly environments: readonly IntegrationEnvironment[];
  readonly criticalities: readonly IntegrationCriticality[];
  readonly controlCapabilities: readonly string[];
  readonly productCapabilities: readonly string[];
  readonly controlBindingKinds: readonly string[];
  readonly productBindingKinds: readonly string[];
  readonly allBindingKinds: readonly string[];
  readonly domainTag: typeof INTEGRATION_REQUIREMENT_DOMAIN_TAG;
  readonly mediaType: typeof INTEGRATION_REQUIREMENT_MEDIA_TYPE;
}

export function integrationContractCatalog(): IntegrationContractCatalogV1 {
  return {
    missionNodeId: "in-2",
    version: 1,
    planes: INTEGRATION_PLANES,
    directions: INTEGRATION_DIRECTIONS,
    environments: INTEGRATION_ENVIRONMENTS,
    criticalities: INTEGRATION_CRITICALITIES,
    controlCapabilities: CONTROL_CAPABILITIES,
    productCapabilities: PRODUCT_CAPABILITIES,
    controlBindingKinds: CONTROL_BINDING_OUTPUT_KINDS,
    productBindingKinds: PRODUCT_BINDING_OUTPUT_KINDS,
    allBindingKinds: ALL_BINDING_OUTPUT_KINDS,
    domainTag: INTEGRATION_REQUIREMENT_DOMAIN_TAG,
    mediaType: INTEGRATION_REQUIREMENT_MEDIA_TYPE,
  };
}

/** Golden vectors shared by tests + overview UI samples. */
export function goldenProductMessagingRequirement(): IntegrationRequirementV1 {
  return {
    version: 1,
    capability: "messaging.send",
    plane: "product",
    direction: "outbound",
    providerPolicy: { preferred: ["slack"], allowed: ["slack"], forbidden: ["twilio"] },
    environments: ["test", "production"],
    trigger: {
      version: 1,
      kind: "threshold",
      description: "when any short link crosses 100 clicks",
      given: "a short link exists with 99 clicks",
      when: "the 100th click is recorded",
      behaviorKey: "celebrate_100_clicks",
    },
    expectedEffect: {
      version: 1,
      plane: "product",
      provider: "slack",
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
        logicalKey: "SLACK_PRODUCT_BINDING_ID",
        classification: "handle",
        required: true,
        description: "Managed relay binding; token never reaches product code",
      },
      {
        version: 1,
        kind: "product.messaging.channel_id",
        logicalKey: "SLACK_PRODUCT_CHANNEL_ID",
        classification: "plain",
        required: true,
      },
    ],
    validation: {
      version: 1,
      preMerge: {
        contractTests: true,
        recordingFake: true,
        negativeControls: true,
        liveProviderInMergeGate: false,
      },
      postDeploy: { liveStimulus: true, independentObservation: true },
      negativeControls: ["99_clicks_no_message", "retry_no_duplicate", "cross_org_denied"],
    },
    criticality: "release_required",
  };
}

export function goldenControlNotifyRequirement(): IntegrationRequirementV1 {
  return {
    version: 1,
    capability: "control.notify",
    plane: "control",
    direction: "outbound",
    providerPolicy: { preferred: ["slack"], allowed: ["slack"] },
    environments: ["production"],
    trigger: {
      version: 1,
      kind: "event",
      description: "Tanren operator notification on run failure",
      when: "run.status becomes failed",
    },
    expectedEffect: {
      version: 1,
      plane: "control",
      provider: "slack",
      observation: "operator_channel_message",
      correlationFields: ["runId", "orgId"],
      independent: true,
    },
    requiredOperations: ["chat.postMessage"],
    requiredScopes: ["chat:write"],
    bindingOutputs: [
      {
        version: 1,
        kind: "control.notify.bot_token_ref",
        logicalKey: "TANREN_SLACK_BOT_TOKEN_REF",
        classification: "secret_ref",
        required: true,
      },
      {
        version: 1,
        kind: "control.notify.channel_id",
        logicalKey: "TANREN_SLACK_CHANNEL_ID",
        classification: "plain",
        required: true,
      },
    ],
    validation: {
      version: 1,
      preMerge: {
        contractTests: true,
        recordingFake: true,
        negativeControls: true,
        liveProviderInMergeGate: false,
      },
      postDeploy: { liveStimulus: false, independentObservation: false },
      negativeControls: ["revoked_token_fails_closed"],
    },
    criticality: "best_effort",
  };
}

/** Control bot-token shape illegally claimed as product messaging (must reject). */
export function goldenCrossPlaneForbiddenRequirement(): unknown {
  const product = goldenProductMessagingRequirement();
  return {
    ...product,
    bindingOutputs: [
      {
        version: 1,
        kind: "control.notify.bot_token_ref",
        logicalKey: "SLACK_BOT_TOKEN",
        classification: "secret_ref",
        required: true,
      },
    ],
  };
}

// Re-export nested types for consumers.
export type { AppBindingOutputV1, BehaviorStimulusContractV1, IntegrationEffectContractV1 };
