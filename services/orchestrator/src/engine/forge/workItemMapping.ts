import { z } from "zod";

export const PUBLIC_WORK_ITEM_MAPPING_VERSION = "work-item-mapping.v1" as const;
export const WORK_ITEM_LIFECYCLE_CORPUS_VERSION = "work-item-lifecycle.v1" as const;

const pointer = z.string().regex(/^\/(?:[^~]|~[01])*(?:\/(?:[^~]|~[01])*)*$/u);
const lifecycleEffect = z.enum(["open", "closed", "comment_recorded"]);
const lifecycleOperation = z.enum(["open", "close", "reopen", "comment"]);
const observationStatus = z.enum(["open", "closed", "reopened", "edited", "deleted", "unknown"]);

const pathField = z.object({ kind: z.literal("path"), path: pointer }).strict();
const templateField = z.object({ kind: z.literal("template"), template: z.string().min(1) }).strict();
const actionField = z
  .object({
    kind: z.literal("action_enum"),
    path: pointer,
    values: z.record(z.string().min(1), observationStatus),
  })
  .strict();
const severityField = z
  .object({
    kind: z.literal("label_severity"),
    path: pointer,
    failLabels: z.array(z.string().trim().min(1)),
    warnLabels: z.array(z.string().trim().min(1)),
  })
  .strict();
const lifecycleOperationConfig = z
  .object({
    effect: lifecycleEffect,
    readback: z.object({ path: pointer, equals: z.string().min(1) }).strict(),
  })
  .strict();

const mappingProfile = z
  .object({
    $schema: z.string().url().optional(),
    $id: z.string().url().optional(),
    version: z.literal(PUBLIC_WORK_ITEM_MAPPING_VERSION),
    profileId: z.string().trim().min(1),
    provider: z.string().trim().min(1),
    orgScope: z.literal("caller"),
    input: z.object({ requiredPaths: z.array(pointer).min(1) }).strict(),
    fields: z
      .object({
        externalKey: templateField,
        providerObjectId: templateField,
        providerRevision: pathField,
        status: actionField,
        severity: severityField,
        title: pathField,
        body: pathField,
      })
      .strict(),
    lifecycle: z
      .object({
        capabilities: z.array(lifecycleOperation).min(1),
        operations: z.record(z.string().min(1), lifecycleOperationConfig),
      })
      .strict(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    const capabilities = new Set(profile.lifecycle.capabilities);
    if (capabilities.size !== profile.lifecycle.capabilities.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lifecycle", "capabilities"],
        message: "duplicate capability",
      });
    }
    for (const operation of profile.lifecycle.capabilities) {
      if (profile.lifecycle.operations[operation] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lifecycle", "operations"],
          message: `missing ${operation}`,
        });
      }
    }
    for (const operation of Object.keys(profile.lifecycle.operations)) {
      if (!lifecycleOperation.safeParse(operation).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lifecycle", "operations"],
          message: `unknown ${operation}`,
        });
      } else if (!capabilities.has(operation as z.infer<typeof lifecycleOperation>)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lifecycle", "capabilities"],
          message: `undeclared ${operation}`,
        });
      }
    }
  });

export type WorkItemMappingProfile = z.infer<typeof mappingProfile>;
export type WorkItemObservationStatus = z.infer<typeof observationStatus>;

export interface MappedWorkItem {
  orgId: string;
  sourceId: string;
  projectId?: string;
  externalKey: string;
  providerObjectId: string;
  providerRevision: string;
  status: WorkItemObservationStatus;
  severity: "info" | "warn" | "fail";
  title: string;
  body: string;
}

export class UnknownWorkItemMappingVersionError extends Error {
  constructor(version: unknown) {
    super(`unsupported work-item mapping version: ${String(version)}`);
    this.name = "UnknownWorkItemMappingVersionError";
  }
}

export class InvalidWorkItemMappingError extends Error {
  constructor(message: string) {
    super(`invalid work-item mapping: ${message}`);
    this.name = "InvalidWorkItemMappingError";
  }
}

export class MalformedProviderWorkItemError extends Error {
  constructor(message: string) {
    super(`malformed provider work-item input: ${message}`);
    this.name = "MalformedProviderWorkItemError";
  }
}

export class LifecycleReadbackConformanceError extends Error {
  constructor(message: string) {
    super(`work-item lifecycle/readback conformance failed: ${message}`);
    this.name = "LifecycleReadbackConformanceError";
  }
}

type ObjectRecord = Record<string, unknown>;

function record(value: unknown, message: string): ObjectRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MalformedProviderWorkItemError(message);
  }
  return value as ObjectRecord;
}

function pointerValue(root: ObjectRecord, path: string): unknown {
  let current: unknown = root;
  for (const rawSegment of path.slice(1).split("/")) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current === null || typeof current !== "object" || !(segment in current)) return undefined;
    current = (current as ObjectRecord)[segment];
  }
  return current;
}

function requiredValue(root: ObjectRecord, path: string): unknown {
  const value = pointerValue(root, path);
  if (value === undefined) throw new MalformedProviderWorkItemError(`missing required path ${path}`);
  return value;
}

function stringValue(value: unknown, field: string, allowNull = false): string {
  if (allowNull && value === null) return "";
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MalformedProviderWorkItemError(`${field} must be a non-empty string`);
  }
  return value;
}

function templatePart(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new MalformedProviderWorkItemError(`${field} must be a non-empty string or finite number`);
}

function templateValue(root: ObjectRecord, template: string, field: string): string {
  const result = template.replaceAll(/\{\{([A-Za-z0-9_.~-]+)\}\}/gu, (_match, dotted: string) => {
    let current: unknown = root;
    for (const segment of dotted.split(".")) {
      if (current === null || typeof current !== "object" || !(segment in current)) {
        throw new MalformedProviderWorkItemError(`${field} references missing path ${dotted}`);
      }
      current = (current as ObjectRecord)[segment];
    }
    return templatePart(current, `${field}.${dotted}`);
  });
  return stringValue(result, field);
}

function labelsValue(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new MalformedProviderWorkItemError(`${field} must be an array`);
  return value.map((item, index) => {
    if (typeof item === "string") return stringValue(item, `${field}[${index}]`).toLowerCase();
    const object = record(item, `${field}[${index}] must be a label object or string`);
    return stringValue(object["name"], `${field}[${index}].name`).toLowerCase();
  });
}

export function parseWorkItemMappingProfile(input: unknown): WorkItemMappingProfile {
  const version =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as ObjectRecord)["version"]
      : undefined;
  if (version !== PUBLIC_WORK_ITEM_MAPPING_VERSION) throw new UnknownWorkItemMappingVersionError(version);
  const parsed = mappingProfile.safeParse(input);
  if (!parsed.success)
    throw new InvalidWorkItemMappingError(parsed.error.issues.map((issue) => issue.message).join("; "));
  return parsed.data;
}

export interface MapProviderWorkItemInput {
  orgId: string;
  sourceId: string;
  projectId?: string;
  payload: unknown;
}

export function mapProviderWorkItem(profileInput: unknown, input: MapProviderWorkItemInput): MappedWorkItem {
  const profile = parseWorkItemMappingProfile(profileInput);
  if (input.orgId.trim().length === 0 || input.sourceId.trim().length === 0) {
    throw new MalformedProviderWorkItemError("orgId and sourceId are required caller scope");
  }
  const payload = record(input.payload, "payload must be an object");
  for (const path of profile.input.requiredPaths) requiredValue(payload, path);
  const labels = labelsValue(requiredValue(payload, profile.fields.severity.path), profile.fields.severity.path);
  const severity = labels.some((label) =>
    profile.fields.severity.failLabels.map((item) => item.toLowerCase()).includes(label),
  )
    ? "fail"
    : labels.some((label) => profile.fields.severity.warnLabels.map((item) => item.toLowerCase()).includes(label))
      ? "warn"
      : "info";
  const action = stringValue(requiredValue(payload, profile.fields.status.path), profile.fields.status.path);
  const status = profile.fields.status.values[action];
  if (status === undefined) throw new MalformedProviderWorkItemError(`unmapped lifecycle action ${action}`);
  return {
    orgId: input.orgId,
    sourceId: input.sourceId,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    externalKey: templateValue(payload, profile.fields.externalKey.template, "externalKey"),
    providerObjectId: templateValue(payload, profile.fields.providerObjectId.template, "providerObjectId"),
    providerRevision: stringValue(requiredValue(payload, profile.fields.providerRevision.path), "providerRevision"),
    status,
    severity,
    title: stringValue(requiredValue(payload, profile.fields.title.path), "title"),
    body: stringValue(requiredValue(payload, profile.fields.body.path), "body", true),
  };
}

const evidence = z
  .object({
    caseId: z.string().min(1),
    orgId: z.string().min(1),
    workItemId: z.string().min(1),
    operation: lifecycleOperation,
    receipt: z.object({ providerRevision: z.string().min(1), effect: lifecycleEffect }).strict(),
    readback: z
      .object({
        providerRevision: z.string().min(1),
        effect: lifecycleEffect,
        observation: z.record(z.string().min(1), z.unknown()),
      })
      .strict(),
  })
  .strict();

const corpus = z
  .object({
    version: z.literal(WORK_ITEM_LIFECYCLE_CORPUS_VERSION),
    profileVersion: z.literal(PUBLIC_WORK_ITEM_MAPPING_VERSION),
    orgId: z.string().min(1),
    workItemId: z.string().min(1),
    cases: z.array(evidence).min(1),
  })
  .strict();

type LifecycleReadbackEvidence = z.infer<typeof evidence>;
export type LifecycleReadbackCorpus = z.infer<typeof corpus>;

export function parseLifecycleReadbackCorpus(input: unknown): LifecycleReadbackCorpus {
  const parsed = corpus.safeParse(input);
  if (!parsed.success) throw new LifecycleReadbackConformanceError("corpus is missing required versioned fields");
  return parsed.data;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  return `{${Object.entries(value as ObjectRecord)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function evidenceKey(item: LifecycleReadbackEvidence): string {
  return canonical(item);
}

function countStrings(values: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function assertEvidence(
  profile: WorkItemMappingProfile,
  corpusValue: LifecycleReadbackCorpus,
  item: LifecycleReadbackEvidence,
): void {
  if (item.orgId !== corpusValue.orgId || item.workItemId !== corpusValue.workItemId) {
    throw new LifecycleReadbackConformanceError(`evidence ${item.caseId} escaped explicit org/work-item scope`);
  }
  const operation = profile.lifecycle.operations[item.operation];
  if (operation === undefined || !profile.lifecycle.capabilities.includes(item.operation)) {
    throw new LifecycleReadbackConformanceError(`unsupported lifecycle capability ${item.operation}`);
  }
  if (item.receipt.effect !== operation.effect || item.readback.effect !== operation.effect) {
    throw new LifecycleReadbackConformanceError(`proof does not equal lifecycle effect for ${item.caseId}`);
  }
  const observed = pointerValue(item.readback.observation, operation.readback.path);
  if (observed !== operation.readback.equals) {
    throw new LifecycleReadbackConformanceError(
      `readback contract does not prove ${item.operation} for ${item.caseId}`,
    );
  }
  if (item.receipt.providerRevision !== item.readback.providerRevision) {
    throw new LifecycleReadbackConformanceError(`readback revision does not prove receipt for ${item.caseId}`);
  }
}

function assertLifecycleOperationCoverage(
  profile: WorkItemMappingProfile,
  cases: readonly LifecycleReadbackEvidence[],
): void {
  const expected = countStrings(profile.lifecycle.capabilities);
  const observed = countStrings(cases.map((item) => item.operation));
  if (expected.size !== observed.size || profile.lifecycle.capabilities.length !== cases.length) {
    throw new LifecycleReadbackConformanceError(
      "lifecycle corpus operation multiset does not cover profile capabilities",
    );
  }
  for (const [operation, count] of expected) {
    if (observed.get(operation) !== count) {
      throw new LifecycleReadbackConformanceError(
        "lifecycle corpus operation multiset does not cover profile capabilities",
      );
    }
  }
}

function assertExactMultiset(
  expected: readonly LifecycleReadbackEvidence[],
  actual: readonly LifecycleReadbackEvidence[],
): void {
  const counts = (items: readonly LifecycleReadbackEvidence[]): Map<string, number> => {
    const result = new Map<string, number>();
    for (const item of items) result.set(evidenceKey(item), (result.get(evidenceKey(item)) ?? 0) + 1);
    return result;
  };
  const expectedCounts = counts(expected);
  const actualCounts = counts(actual);
  if (expected.length !== actual.length || expectedCounts.size !== actualCounts.size) {
    throw new LifecycleReadbackConformanceError("lifecycle/readback evidence is incomplete or has extra cases");
  }
  for (const [key, count] of expectedCounts) {
    if (actualCounts.get(key) !== count)
      throw new LifecycleReadbackConformanceError("lifecycle/readback evidence mismatched");
  }
}

export function verifyLifecycleReadbackConformance(
  profileInput: unknown,
  corpusInput: unknown,
  actualInput: unknown,
): { profileVersion: typeof PUBLIC_WORK_ITEM_MAPPING_VERSION; orgId: string; workItemId: string; caseCount: number } {
  const profile = parseWorkItemMappingProfile(profileInput);
  const corpusValue = parseLifecycleReadbackCorpus(corpusInput);
  if (corpusValue.profileVersion !== profile.version)
    throw new LifecycleReadbackConformanceError("profile/corpus versions differ");
  const expected = corpusValue.cases;
  assertLifecycleOperationCoverage(profile, expected);
  const parsedActual = z.array(evidence).safeParse(actualInput);
  if (!parsedActual.success)
    throw new LifecycleReadbackConformanceError("readback evidence is incomplete or malformed");
  for (const item of expected) assertEvidence(profile, corpusValue, item);
  for (const item of parsedActual.data) assertEvidence(profile, corpusValue, item);
  assertExactMultiset(expected, parsedActual.data);
  return {
    profileVersion: profile.version,
    orgId: corpusValue.orgId,
    workItemId: corpusValue.workItemId,
    caseCount: expected.length,
  };
}
