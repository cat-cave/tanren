import { z } from "zod";
import type { PreparedGreenfieldDeploy } from "../forge/interview/deployDependency.js";
import type { DeriveResult } from "../forge/interview/derive.js";
import type { SeededTemplate } from "../templates/index.js";
import type { ProvisionAutonomousProjectResult } from "../workflow/provisionAutonomousProject.js";
import type { CreatedRepository } from "../contracts/codeHostTypes.js";
import { DesignContractV1 } from "../design/designContract.js";

export const DerivationKindSchema = z.enum(["direct_greenfield", "interview"]);
export type DerivationKind = z.infer<typeof DerivationKindSchema>;
export const FingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export const NonEmpty = z.string().min(1);
export const JsonRecord = z.record(z.string(), z.unknown());
export const RepositorySchema = z.object({ fullName: NonEmpty, repoUrl: NonEmpty, defaultBranch: NonEmpty }).strict();
export const BindingSchema = z
  .object({
    orgId: NonEmpty,
    projectId: NonEmpty,
    repoUrl: NonEmpty,
    idempotencyFingerprint: FingerprintSchema,
    ownershipMarker: NonEmpty,
  })
  .strict();
export const DerivationOwnershipReceiptSchema = BindingSchema.extend({
  receipt: z.literal("repository_ownership"),
  mode: z.enum(["managed", "explicit"]),
  repository: z.object({ fullName: NonEmpty, repoUrl: NonEmpty, requestedDefaultBranch: NonEmpty }).strict(),
}).strict();
export type DerivationOwnershipReceipt = z.infer<typeof DerivationOwnershipReceiptSchema>;
export const EffectIntentSchema = z
  .object({ effect: z.enum(["template", "deploy"]), idempotencyKey: NonEmpty })
  .strict();
export const SeededTemplateSchema = z
  .object({ templateRef: NonEmpty, validatedAt: z.string().datetime({ offset: true }) })
  .strict();
export const ProvisionedOutcomeSchema = z
  .object({
    status: z.literal("provisioned"),
    capability: z.literal("deploy"),
    providerKind: z.enum(["deploy.vercel", "deploy.flyio"]),
    action: z.enum(["provision", "bind"]),
    mode: z.enum(["greenfield", "brownfield"]),
    authority: z
      .object({
        connectionId: NonEmpty,
        grantId: NonEmpty,
        providerPrincipalId: NonEmpty,
        authGeneration: z.number().int().positive(),
        grantGeneration: z.number().int().positive(),
      })
      .strict(),
    secretRefNames: z.array(NonEmpty),
    surfaces: z
      .object({
        inboxSourceId: NonEmpty.optional(),
        notificationTargetId: NonEmpty.optional(),
        projectConfigKeys: z.array(NonEmpty),
        deployRef: NonEmpty.optional(),
      })
      .strict(),
  })
  .strict();
export const PreparedDeploySchema = z.object({ outcome: ProvisionedOutcomeSchema, projectConfig: JsonRecord }).strict();
export const BootstrapSchema = z
  .object({
    inboxSource: z.object({ id: NonEmpty, created: z.boolean() }).strict(),
    notificationRoute: z
      .object({
        targetId: NonEmpty,
        created: z.boolean(),
        requiredEvents: z.array(
          z.object({ eventName: NonEmpty, minSeverity: z.enum(["ok", "info", "warn", "fail"]) }).strict(),
        ),
      })
      .strict(),
    auditCatalog: z
      .object({
        requiredCategories: z.array(z.enum(["security", "deps", "a11y", "mutation", "perf", "license", "stale_specs"])),
        created: z.array(z.enum(["security", "deps", "a11y", "mutation", "perf", "license", "stale_specs"])),
      })
      .strict(),
    errors: z.array(
      z.object({ seed: z.enum(["auditCatalog", "notificationRoute", "inbox"]), message: NonEmpty }).strict(),
    ),
  })
  .strict();
export const GraphResultSchema = z
  .object({
    projectId: NonEmpty,
    projectName: NonEmpty,
    repository: RepositorySchema.optional(),
    specIds: z.array(NonEmpty),
    personaIds: z.array(NonEmpty),
    behaviorIds: z.array(NonEmpty),
    milestoneIds: z.array(NonEmpty),
    designContract: z
      .object({ id: NonEmpty, version: z.number().int().positive(), domain: NonEmpty, digest: FingerprintSchema })
      .strict(),
    templateSeed: SeededTemplateSchema.optional(),
    bootstrap: BootstrapSchema.optional(),
  })
  .strict();

const envelope = <T extends z.ZodType>(receipt: string, value: T) =>
  z.object({ receipt: z.literal(receipt), binding: BindingSchema, value }).strict();
const DesignIntentSchema = z
  .object({ effect: z.literal("design"), idempotencyKey: NonEmpty, inputDigest: FingerprintSchema })
  .strict();
const DesignResultSchema = z
  .object({ inputDigest: FingerprintSchema, contract: DesignContractV1, contractDigest: FingerprintSchema })
  .strict();
export const ResultEnvelopeSchemas = {
  repository: envelope("repository", RepositorySchema),
  template_intent: envelope("template_intent", EffectIntentSchema),
  deploy_intent: envelope("deploy_intent", EffectIntentSchema),
  deploy: envelope("deploy", PreparedDeploySchema),
  design_intent: envelope("design_intent", DesignIntentSchema),
  design: envelope("design", DesignResultSchema),
  graph: envelope("graph", GraphResultSchema),
  bootstrap: envelope("bootstrap", BootstrapSchema),
} as const;
export const TemplateEnvelopeSchema = envelope("template", SeededTemplateSchema);

export interface DerivationReceiptValueByKey {
  repository: CreatedRepository;
  template_intent: { effect: "template"; idempotencyKey: string };
  deploy_intent: { effect: "deploy"; idempotencyKey: string };
  deploy: PreparedGreenfieldDeploy;
  design_intent: { effect: "design"; idempotencyKey: string; inputDigest: string };
  design: { inputDigest: string; contract: z.infer<typeof DesignContractV1>; contractDigest: string };
  graph: DeriveResult;
  bootstrap: ProvisionAutonomousProjectResult;
}
export type DerivationReceiptKey = keyof DerivationReceiptValueByKey;

export interface StoredEnvelope<T> {
  receipt: string;
  binding: z.infer<typeof BindingSchema>;
  value: T;
}

export interface DecodedDerivationReceipts {
  kind: DerivationKind;
  designMode: "captured" | "provider" | undefined;
  designInputDigest: string | undefined;
  ownership: DerivationOwnershipReceipt;
  template?: SeededTemplate;
  results: Partial<DerivationReceiptValueByKey>;
}

export interface CompleteDirectDerivation extends DecodedDerivationReceipts {
  kind: "direct_greenfield";
  results: Required<Pick<DerivationReceiptValueByKey, "repository" | "deploy_intent" | "deploy" | "bootstrap">>;
}

export interface CompleteInterviewDerivation extends DecodedDerivationReceipts {
  kind: "interview";
  template: SeededTemplate;
  results: Required<
    Pick<
      DerivationReceiptValueByKey,
      "repository" | "template_intent" | "deploy_intent" | "deploy" | "design" | "graph" | "bootstrap"
    >
  > &
    Partial<Pick<DerivationReceiptValueByKey, "design_intent">>;
}

export type CompleteProjectDerivation = CompleteDirectDerivation | CompleteInterviewDerivation;

export function completeDerivationReceipts(decoded: DecodedDerivationReceipts): CompleteProjectDerivation | undefined {
  const required =
    decoded.kind === "interview"
      ? ([
          "repository",
          "template_intent",
          "deploy_intent",
          "deploy",
          ...(decoded.designMode === "provider" ? (["design_intent", "design"] as const) : []),
          ...(decoded.designMode === "captured" ? (["design"] as const) : []),
          "graph",
          "bootstrap",
        ] as const)
      : (["repository", "deploy_intent", "deploy", "bootstrap"] as const);
  if (
    required.some((key) => decoded.results[key] === undefined) ||
    (decoded.kind === "interview" && decoded.template === undefined) ||
    decoded.results.bootstrap?.errors.length !== 0
  ) {
    return undefined;
  }
  return decoded as CompleteProjectDerivation;
}
