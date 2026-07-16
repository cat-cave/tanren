import { z } from "zod";
import type { PreparedGreenfieldDeploy } from "../forge/interview/deployDependency.js";
import type { DeriveResult } from "../forge/interview/derive.js";
import type { SeededTemplate } from "../templates/index.js";
import type { ProvisionAutonomousProjectResult } from "../workflow/provisionAutonomousProject.js";
import type { CreatedRepository } from "../contracts/codeHostTypes.js";
import { DesignContractV1, designContractDigest } from "../design/designContract.js";

export const DerivationKindSchema = z.enum(["direct_greenfield", "interview"]);
export type DerivationKind = z.infer<typeof DerivationKindSchema>;
const FingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const NonEmpty = z.string().min(1);
const JsonRecord = z.record(z.string(), z.unknown());
const RepositorySchema = z.object({ fullName: NonEmpty, repoUrl: NonEmpty, defaultBranch: NonEmpty }).strict();
const BindingSchema = z
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
const EffectIntentSchema = z.object({ effect: z.enum(["template", "deploy"]), idempotencyKey: NonEmpty }).strict();
const SeededTemplateSchema = z
  .object({ templateRef: NonEmpty, validatedAt: z.string().datetime({ offset: true }) })
  .strict();
const ProvisionedOutcomeSchema = z
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
const PreparedDeploySchema = z.object({ outcome: ProvisionedOutcomeSchema, projectConfig: JsonRecord }).strict();
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
const GraphResultSchema = z
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
const ResultEnvelopeSchemas = {
  repository: envelope("repository", RepositorySchema),
  template_intent: envelope("template_intent", EffectIntentSchema),
  deploy_intent: envelope("deploy_intent", EffectIntentSchema),
  deploy: envelope("deploy", PreparedDeploySchema),
  design_intent: envelope("design_intent", DesignIntentSchema),
  design: envelope("design", DesignResultSchema),
  graph: envelope("graph", GraphResultSchema),
  bootstrap: envelope("bootstrap", BootstrapSchema),
} as const;
const TemplateEnvelopeSchema = envelope("template", SeededTemplateSchema);

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

interface StoredEnvelope<T> {
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

export interface ExpectedDerivationIdentity {
  kind: DerivationKind;
  orgId: string;
  projectId: string;
  repoUrl: string;
  idempotencyFingerprint: string;
}

export class DerivationReceiptValidationError extends Error {
  override readonly name = "DerivationReceiptValidationError";

  constructor(
    readonly code: "binding_mismatch" | "invalid_receipt",
    message: string,
  ) {
    super(message);
  }
}

export function repositoryOwnershipMarker(fingerprint: string): string {
  const parsed = FingerprintSchema.parse(fingerprint);
  return `https://tanren.dev/derivations/${parsed.slice("sha256:".length)}`;
}

export function explicitRepositoryMarker(fingerprint: string): string {
  return `tanren:explicit:${FingerprintSchema.parse(fingerprint)}`;
}

export function derivationJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("project derivation receipt must be JSON-serializable");
  return encoded;
}

export function canonicalizeDerivation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalizeDerivation(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalizeDerivation(item)]),
    );
  }
  return value;
}

export function canonicalDerivationJson(value: unknown): string {
  return JSON.stringify(canonicalizeDerivation(value));
}

export function buildDerivationOwnership(input: {
  kind: "managed" | "explicit";
  orgId: string;
  projectId: string;
  repoUrl: string;
  idempotencyFingerprint: string;
  ownershipMarker: string;
  fullName: string;
  requestedDefaultBranch: string;
}): DerivationOwnershipReceipt {
  return DerivationOwnershipReceiptSchema.parse({
    receipt: "repository_ownership",
    mode: input.kind,
    orgId: input.orgId,
    projectId: input.projectId,
    repoUrl: input.repoUrl,
    idempotencyFingerprint: input.idempotencyFingerprint,
    ownershipMarker: input.ownershipMarker,
    repository: {
      fullName: input.fullName,
      repoUrl: input.repoUrl,
      requestedDefaultBranch: input.requestedDefaultBranch,
    },
  });
}

function bindingFrom(ownership: DerivationOwnershipReceipt): z.infer<typeof BindingSchema> {
  return BindingSchema.parse({
    orgId: ownership.orgId,
    projectId: ownership.projectId,
    repoUrl: ownership.repoUrl,
    idempotencyFingerprint: ownership.idempotencyFingerprint,
    ownershipMarker: ownership.ownershipMarker,
  });
}

export function encodeTemplateReceipt(
  ownership: DerivationOwnershipReceipt,
  value: SeededTemplate,
): Record<string, unknown> {
  return TemplateEnvelopeSchema.parse({ receipt: "template", binding: bindingFrom(ownership), value });
}

export function encodeResultReceipt<K extends DerivationReceiptKey>(
  ownership: DerivationOwnershipReceipt,
  key: K,
  value: DerivationReceiptValueByKey[K],
): Record<string, unknown> {
  return ResultEnvelopeSchemas[key].parse({ receipt: key, binding: bindingFrom(ownership), value });
}

function canonicalRepoUrl(value: string): string {
  return value.replace(/\.git$/u, "");
}

function fail(code: DerivationReceiptValidationError["code"], message: string): never {
  throw new DerivationReceiptValidationError(code, message);
}

function assertSameBinding(
  actual: z.infer<typeof BindingSchema>,
  ownership: DerivationOwnershipReceipt,
  label: string,
): void {
  if (
    actual.orgId !== ownership.orgId ||
    actual.projectId !== ownership.projectId ||
    canonicalRepoUrl(actual.repoUrl) !== canonicalRepoUrl(ownership.repoUrl) ||
    actual.idempotencyFingerprint !== ownership.idempotencyFingerprint ||
    actual.ownershipMarker !== ownership.ownershipMarker
  ) {
    fail("binding_mismatch", `${label} is not bound to the derivation ownership receipt`);
  }
}

function requestedDeploy(
  kind: DerivationKind,
  sanitizedInput: Record<string, unknown>,
):
  | {
      providerKind: string;
      mode: "greenfield" | "brownfield";
      connectionId?: string;
      grantId?: string;
    }
  | undefined {
  const value =
    kind === "interview"
      ? sanitizedInput["deploy"]
      : typeof sanitizedInput["input"] === "object" && sanitizedInput["input"] !== null
        ? (sanitizedInput["input"] as Record<string, unknown>)["deploy"]
        : undefined;
  if (typeof value !== "object" || value === null) return undefined;
  const deploy = value as Record<string, unknown>;
  const providerKind = deploy["providerKind"];
  const mode = deploy["mode"] ?? "greenfield";
  if (typeof providerKind !== "string" || (mode !== "greenfield" && mode !== "brownfield")) return undefined;
  const connectionId = deploy["connectionId"];
  const grantId = deploy["grantId"];
  if (
    (connectionId !== undefined && typeof connectionId !== "string") ||
    (grantId !== undefined && typeof grantId !== "string")
  ) {
    return undefined;
  }
  return {
    providerKind,
    mode,
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(grantId === undefined ? {} : { grantId }),
  };
}

function requestedDesign(input: Record<string, unknown>): {
  mode: "captured" | "provider";
  inputDigest: string;
} {
  const mode = input["designMode"];
  const inputDigest = input["designInputDigest"];
  if ((mode !== "captured" && mode !== "provider") || typeof inputDigest !== "string") {
    fail("invalid_receipt", "interview derivation has no exact design mode/input digest");
  }
  return { mode, inputDigest: FingerprintSchema.parse(inputDigest) };
}

export function decodeDerivationReceipts(input: {
  orgId: string;
  projectId: string;
  idempotencyFingerprint: string;
  sanitizedInput: Record<string, unknown>;
  ownershipReceipt: unknown;
  templateReceipt: unknown;
  resultReceipt: Record<string, unknown>;
  expected?: ExpectedDerivationIdentity;
}): DecodedDerivationReceipts {
  try {
    const kind = DerivationKindSchema.parse(input.sanitizedInput["kind"]);
    const ownership = DerivationOwnershipReceiptSchema.parse(input.ownershipReceipt);
    if (
      ownership.orgId !== input.orgId ||
      ownership.projectId !== input.projectId ||
      ownership.idempotencyFingerprint !== input.idempotencyFingerprint ||
      canonicalRepoUrl(ownership.repoUrl) !== canonicalRepoUrl(ownership.repository.repoUrl)
    ) {
      fail("binding_mismatch", "derivation ownership does not match its durable row");
    }
    const expected = input.expected;
    if (
      expected !== undefined &&
      (kind !== expected.kind ||
        ownership.orgId !== expected.orgId ||
        ownership.projectId !== expected.projectId ||
        canonicalRepoUrl(ownership.repoUrl) !== canonicalRepoUrl(expected.repoUrl) ||
        ownership.idempotencyFingerprint !== expected.idempotencyFingerprint)
    ) {
      fail("binding_mismatch", "derivation does not match the requested shell identity");
    }

    const allowed =
      kind === "interview"
        ? ["repository", "template_intent", "deploy_intent", "deploy", "design_intent", "design", "graph", "bootstrap"]
        : ["repository", "deploy_intent", "deploy", "bootstrap"];
    for (const key of Object.keys(input.resultReceipt)) {
      if (!allowed.includes(key)) fail("invalid_receipt", `receipt '${key}' is not valid for ${kind}`);
    }
    const results: Partial<DerivationReceiptValueByKey> = {};
    for (const key of allowed as DerivationReceiptKey[]) {
      const stored = input.resultReceipt[key];
      if (stored === undefined) continue;
      const parsed = ResultEnvelopeSchemas[key].parse(stored) as StoredEnvelope<unknown>;
      assertSameBinding(parsed.binding, ownership, key);
      (results as Record<string, unknown>)[key] = parsed.value;
    }
    const templateEnvelope =
      input.templateReceipt === null || input.templateReceipt === undefined
        ? undefined
        : (TemplateEnvelopeSchema.parse(input.templateReceipt) as StoredEnvelope<SeededTemplate>);
    if (templateEnvelope !== undefined) assertSameBinding(templateEnvelope.binding, ownership, "template");

    const repository = results.repository;
    if (
      repository !== undefined &&
      (repository.fullName !== ownership.repository.fullName ||
        canonicalRepoUrl(repository.repoUrl) !== canonicalRepoUrl(ownership.repoUrl) ||
        repository.defaultBranch !== ownership.repository.requestedDefaultBranch)
    ) {
      fail("binding_mismatch", "repository receipt does not match the owned repository");
    }
    for (const effect of ["template", "deploy"] as const) {
      const intent = results[`${effect}_intent`];
      if (
        intent !== undefined &&
        (intent.effect !== effect || intent.idempotencyKey !== `${input.idempotencyFingerprint}:${effect}`)
      ) {
        fail("binding_mismatch", `${effect} intent does not match the derivation fingerprint`);
      }
    }
    if (results.graph !== undefined && results.graph.projectId !== input.projectId) {
      fail("binding_mismatch", "graph receipt belongs to another project");
    }
    const design = kind === "interview" ? requestedDesign(input.sanitizedInput) : undefined;
    if (design !== undefined) {
      const intent = results.design_intent;
      const result = results.design;
      if (design.mode === "captured" && intent !== undefined) {
        fail("binding_mismatch", "captured design mode cannot carry provider design intent");
      }
      if (design.mode === "provider" && result !== undefined && intent === undefined) {
        fail("invalid_receipt", "design result has no durable design intent");
      }
      if (
        (intent !== undefined &&
          (intent.effect !== "design" ||
            intent.idempotencyKey !== `${input.idempotencyFingerprint}:design` ||
            intent.inputDigest !== design.inputDigest)) ||
        (result !== undefined &&
          (result.inputDigest !== design.inputDigest ||
            result.contractDigest !== designContractDigest(result.contract)))
      ) {
        fail("binding_mismatch", "design evidence does not match the derivation design intent");
      }
    }
    const deployRequest = requestedDeploy(kind, input.sanitizedInput);
    if (deployRequest === undefined) fail("invalid_receipt", "derivation input has no exact deploy request");
    const deploy = results.deploy?.outcome;
    if (
      deploy !== undefined &&
      (deploy.providerKind !== deployRequest.providerKind ||
        deploy.mode !== deployRequest.mode ||
        (deployRequest.connectionId !== undefined && deploy.authority.connectionId !== deployRequest.connectionId) ||
        (deployRequest.grantId !== undefined && deploy.authority.grantId !== deployRequest.grantId))
    ) {
      fail("binding_mismatch", "deploy receipt does not match the exact requested deployment authority");
    }
    return {
      kind,
      designMode: design?.mode,
      designInputDigest: design?.inputDigest,
      ownership,
      ...(templateEnvelope === undefined ? {} : { template: templateEnvelope.value }),
      results,
    };
  } catch (error) {
    if (error instanceof DerivationReceiptValidationError) throw error;
    throw new DerivationReceiptValidationError(
      "invalid_receipt",
      error instanceof Error ? error.message : String(error),
    );
  }
}
