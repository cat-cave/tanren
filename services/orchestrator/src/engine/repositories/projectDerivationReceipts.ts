import { z } from "zod";
import type { PreparedGreenfieldDeploy } from "../forge/interview/deployDependency.js";
import type { DeriveResult } from "../forge/interview/derive.js";
import type { SeededTemplate } from "../templates/index.js";
import type { ProvisionAutonomousProjectResult } from "../workflow/provisionAutonomousProject.js";
import type { CreatedRepository } from "../contracts/codeHostTypes.js";

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
const BootstrapSchema = z
  .object({
    inboxSource: z.object({ id: NonEmpty, created: z.boolean() }).strict().optional(),
    notificationRoute: z
      .object({ targetId: NonEmpty, created: z.boolean(), events: z.number().int().nonnegative() })
      .strict()
      .optional(),
    auditCatalog: z
      .object({
        jobs: z.number().int().nonnegative(),
        created: z.array(z.enum(["security", "deps", "a11y", "mutation", "perf", "license", "stale_specs"])),
      })
      .strict()
      .optional(),
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
    designContractId: NonEmpty.optional(),
    templateSeed: SeededTemplateSchema.optional(),
    bootstrap: BootstrapSchema.optional(),
  })
  .strict();

const envelope = <T extends z.ZodType>(receipt: string, value: T) =>
  z.object({ receipt: z.literal(receipt), binding: BindingSchema, value }).strict();

const ResultEnvelopeSchemas = {
  repository: envelope("repository", RepositorySchema),
  template_intent: envelope("template_intent", EffectIntentSchema),
  deploy_intent: envelope("deploy_intent", EffectIntentSchema),
  deploy: envelope("deploy", PreparedDeploySchema),
  graph: envelope("graph", GraphResultSchema),
  bootstrap: envelope("bootstrap", BootstrapSchema),
} as const;
const TemplateEnvelopeSchema = envelope("template", SeededTemplateSchema);

export interface DerivationReceiptValueByKey {
  repository: CreatedRepository;
  template_intent: { effect: "template"; idempotencyKey: string };
  deploy_intent: { effect: "deploy"; idempotencyKey: string };
  deploy: PreparedGreenfieldDeploy;
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
  results: Required<DerivationReceiptValueByKey>;
}

export type CompleteProjectDerivation = CompleteDirectDerivation | CompleteInterviewDerivation;

export function completeDerivationReceipts(decoded: DecodedDerivationReceipts): CompleteProjectDerivation | undefined {
  const required =
    decoded.kind === "interview"
      ? (["repository", "template_intent", "deploy_intent", "deploy", "graph", "bootstrap"] as const)
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

function requestedProvider(kind: DerivationKind, sanitizedInput: Record<string, unknown>): string | undefined {
  const value =
    kind === "interview"
      ? sanitizedInput["deploy"]
      : typeof sanitizedInput["input"] === "object" && sanitizedInput["input"] !== null
        ? (sanitizedInput["input"] as Record<string, unknown>)["deploy"]
        : undefined;
  if (typeof value !== "object" || value === null) return undefined;
  const provider = (value as Record<string, unknown>)["providerKind"];
  return typeof provider === "string" ? provider : undefined;
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
        ? ["repository", "template_intent", "deploy_intent", "deploy", "graph", "bootstrap"]
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
        canonicalRepoUrl(repository.repoUrl) !== canonicalRepoUrl(ownership.repoUrl))
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
    const providerKind = requestedProvider(kind, input.sanitizedInput);
    if (providerKind === undefined) fail("invalid_receipt", "derivation input has no exact deploy provider");
    if (results.deploy !== undefined && results.deploy.outcome.providerKind !== providerKind) {
      fail("binding_mismatch", "deploy receipt belongs to another provider");
    }
    return {
      kind,
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
