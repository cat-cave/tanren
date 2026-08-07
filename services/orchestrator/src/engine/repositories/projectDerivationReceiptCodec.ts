import { designContractDigest } from "../design/designContract.js";
import type { z } from "zod";
import type { SeededTemplate } from "../templates/index.js";
import {
  BindingSchema,
  DerivationKindSchema,
  DerivationOwnershipReceiptSchema,
  FingerprintSchema,
  ResultEnvelopeSchemas,
  TemplateEnvelopeSchema,
  type DecodedDerivationReceipts,
  type DerivationKind,
  type DerivationOwnershipReceipt,
  type DerivationReceiptKey,
  type DerivationReceiptValueByKey,
  type StoredEnvelope,
} from "./projectDerivationReceiptSchemas.js";

// Encoding/decoding is kept separate from the immutable receipt schema catalog so
// callers can validate durable envelopes without loading provider-side codecs.

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
