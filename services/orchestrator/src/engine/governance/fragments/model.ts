import { createHash } from "node:crypto";
import { z } from "zod";
import { compilePolicy } from "../policyCompiler.js";
import { PolicyAstSchema, PolicyLayerSchema, type PolicyAst } from "../policyAst.js";

const FragmentId = z.string().regex(/^[a-z][a-z0-9-]{0,127}$/u);
const Version = z.string().regex(/^\d+\.\d+\.\d+$/u);
const PolicyLayersSchema = z
  .object({ core: PolicyLayerSchema, org: PolicyLayerSchema, tier: PolicyLayerSchema, binding: PolicyLayerSchema })
  .strict();
const JsonSchema = z.record(z.string(), z.unknown());
const DerivationSchema = z
  .object({
    personaRevisionIds: z.array(z.string().min(1).max(256)).max(128),
    behaviorRevisionIds: z.array(z.string().min(1).max(256)).max(128),
    designEntityIds: z.array(z.string().min(1).max(256)).max(128),
    riskClassifications: z.array(z.string().min(1).max(128)).min(1).max(32),
  })
  .strict();

export const GovernanceFragmentSpecSchema = z
  .object({
    fragmentId: FragmentId,
    version: Version,
    dependsOn: z.array(FragmentId).max(32),
    derivation: DerivationSchema,
    requiredPolicy: PolicyLayersSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.dependsOn).size !== value.dependsOn.length) {
      context.addIssue({ code: "custom", message: "fragment dependencies must be unique" });
    }
    if (value.dependsOn.includes(value.fragmentId)) {
      context.addIssue({ code: "custom", message: "fragment cannot depend on itself" });
    }
  });
export type GovernanceFragmentSpec = z.infer<typeof GovernanceFragmentSpecSchema>;

export const GovernanceFragmentConfigSchema = z
  .object({
    apiVersion: z.literal("tanren.dev/governance-fragments/v1"),
    schemaVersion: z.literal(1),
    fragments: z.array(GovernanceFragmentSpecSchema).min(1).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.fragments.map((fragment) => fragment.fragmentId);
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "fragment ids must be unique" });
    if (value.fragments.some((fragment) => fragment.fragmentId === "base")) {
      context.addIssue({ code: "custom", message: "base is mandatory and supplied by the kernel" });
    }
  });
export type GovernanceFragmentConfig = z.infer<typeof GovernanceFragmentConfigSchema>;

const ConformanceSchema = z
  .object({
    positive: z.array(PolicyAstSchema).min(1).max(16),
    negative: z.array(z.unknown()).min(1).max(16),
  })
  .strict();
const SnapshotSchema = z
  .object({
    scenarioId: z.string().min(1).max(128),
    policy: PolicyAstSchema,
    expectedPolicyHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  })
  .strict();

/** Declarative F2 output. There is deliberately no source-code or expression field. */
export const GovernanceFragmentDraftSchema = z
  .object({
    spec: GovernanceFragmentSpecSchema,
    policy: PolicyLayersSchema,
    conformance: ConformanceSchema,
    simulatorSnapshots: z.array(SnapshotSchema).min(1).max(16),
    uiFormSchema: JsonSchema,
    compatibility: z.literal("tanren.dev/governance/v2"),
  })
  .strict();
export type GovernanceFragmentDraft = z.infer<typeof GovernanceFragmentDraftSchema>;

export interface ValidatedGovernanceFragment {
  readonly draft: GovernanceFragmentDraft;
  readonly fragmentDigest: string;
}

export const GovernanceFragmentSnapshotEntrySchema = z
  .object({ fragmentId: FragmentId, version: Version, fragmentDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u) })
  .strict();
export type GovernanceFragmentSnapshotEntry = z.infer<typeof GovernanceFragmentSnapshotEntrySchema>;

export class GovernanceFragmentValidationError extends Error {
  constructor(readonly reason: string) {
    super(`governance fragment validation failed: ${reason}`);
    this.name = "GovernanceFragmentValidationError";
  }
}

export class GovernanceFragmentCompositionError extends Error {
  constructor(readonly reason: string) {
    super(`governance fragment composition failed: ${reason}`);
    this.name = "GovernanceFragmentCompositionError";
  }
}

export const BASE_GOVERNANCE_FRAGMENT: ValidatedGovernanceFragment = validateGovernanceFragment({
  spec: {
    fragmentId: "base",
    version: "1.0.0",
    dependsOn: [],
    derivation: {
      personaRevisionIds: [],
      behaviorRevisionIds: [],
      designEntityIds: [],
      riskClassifications: ["platform-baseline"],
    },
    requiredPolicy: {
      core: {
        rules: [
          { key: "audit.block_at", value: "P3" },
          { key: "review.require_forge_publication", value: true },
        ],
      },
      org: { rules: [] },
      tier: { rules: [] },
      binding: { rules: [] },
    },
  },
  policy: {
    core: {
      rules: [
        { key: "audit.block_at", value: "P3" },
        { key: "review.require_forge_publication", value: true },
      ],
    },
    org: { rules: [] },
    tier: { rules: [] },
    binding: { rules: [] },
  },
  conformance: {
    positive: [basePolicy()],
    negative: [{ apiVersion: "wrong" }],
  },
  simulatorSnapshots: [{ scenarioId: "base", policy: basePolicy(), expectedPolicyHash: compiledHash(basePolicy()) }],
  uiFormSchema: { type: "object", title: "Tanren governance baseline" },
  compatibility: "tanren.dev/governance/v2",
});

export function validateGovernanceFragment(input: unknown): ValidatedGovernanceFragment {
  let draft: GovernanceFragmentDraft;
  try {
    draft = GovernanceFragmentDraftSchema.parse(input);
  } catch (error) {
    throw new GovernanceFragmentValidationError(error instanceof Error ? error.message : String(error));
  }
  if (canonicalJson(draft.spec.requiredPolicy) !== canonicalJson(draft.policy)) {
    throw new GovernanceFragmentValidationError("draft policy does not satisfy its requested declarative policy");
  }
  assertCompiles(policyFromLayers(draft.policy), "fragment policy");
  for (const policy of draft.conformance.positive) assertCompiles(policy, "positive conformance vector");
  for (const negative of draft.conformance.negative) {
    let parsed: PolicyAst;
    try {
      parsed = PolicyAstSchema.parse(negative);
    } catch (error) {
      if (error instanceof z.ZodError) continue;
      throw new GovernanceFragmentValidationError(error instanceof Error ? error.message : String(error));
    }
    if (compilePolicy(parsed).status === "compiled") {
      throw new GovernanceFragmentValidationError("negative conformance vector compiled successfully");
    }
  }
  for (const snapshot of draft.simulatorSnapshots) {
    if (compiledHash(snapshot.policy) !== snapshot.expectedPolicyHash) {
      throw new GovernanceFragmentValidationError(
        `simulator snapshot ${snapshot.scenarioId} has an incorrect policy hash`,
      );
    }
  }
  return { draft, fragmentDigest: digest(draft) };
}

export function composeGovernancePolicy(fragments: readonly ValidatedGovernanceFragment[]): {
  readonly policy: PolicyAst;
  readonly snapshot: readonly GovernanceFragmentSnapshotEntry[];
} {
  const ordered = orderFragments(fragments);
  if (
    !ordered.some((fragment) => fragment.draft.spec.fragmentId === "base" && fragment.draft.spec.version === "1.0.0")
  ) {
    throw new GovernanceFragmentCompositionError("mandatory base@1.0.0 fragment is absent");
  }
  const policy: PolicyAst = {
    apiVersion: "tanren.dev/governance/v2",
    schemaVersion: 1,
    core: { rules: ordered.flatMap((fragment) => fragment.draft.policy.core.rules) },
    org: { rules: ordered.flatMap((fragment) => fragment.draft.policy.org.rules) },
    tier: { rules: ordered.flatMap((fragment) => fragment.draft.policy.tier.rules) },
    binding: { rules: ordered.flatMap((fragment) => fragment.draft.policy.binding.rules) },
  };
  assertCompiles(policy, "composed governance policy");
  return {
    policy,
    snapshot: ordered.map((fragment) => ({
      fragmentId: fragment.draft.spec.fragmentId,
      version: fragment.draft.spec.version,
      fragmentDigest: fragment.fragmentDigest,
    })),
  };
}

export function diffGovernanceFragmentSnapshots(
  previous: readonly GovernanceFragmentSnapshotEntry[],
  next: readonly GovernanceFragmentSnapshotEntry[],
): { readonly added: readonly string[]; readonly removed: readonly string[]; readonly changed: readonly string[] } {
  const prior = new Map(previous.map((entry) => [entry.fragmentId, entry]));
  const current = new Map(next.map((entry) => [entry.fragmentId, entry]));
  return {
    added: [...current.keys()].filter((id) => !prior.has(id)).sort(),
    removed: [...prior.keys()].filter((id) => !current.has(id)).sort(),
    changed: [...current.entries()]
      .filter(([id, entry]) => {
        const old = prior.get(id);
        return old !== undefined && (old.version !== entry.version || old.fragmentDigest !== entry.fragmentDigest);
      })
      .map(([id]) => id)
      .sort(),
  };
}

export function policyFromLayers(layers: z.infer<typeof PolicyLayersSchema>): PolicyAst {
  return { apiVersion: "tanren.dev/governance/v2", schemaVersion: 1, ...layers };
}

function orderFragments(fragments: readonly ValidatedGovernanceFragment[]): ValidatedGovernanceFragment[] {
  const byId = new Map<string, ValidatedGovernanceFragment>();
  for (const fragment of fragments) {
    const key = fragment.draft.spec.fragmentId;
    if (byId.has(key)) throw new GovernanceFragmentCompositionError(`duplicate fragment id: ${key}`);
    byId.set(key, fragment);
  }
  const ordered: ValidatedGovernanceFragment[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new GovernanceFragmentCompositionError(`fragment dependency cycle at ${id}`);
    const fragment = byId.get(id);
    if (fragment === undefined) throw new GovernanceFragmentCompositionError(`unresolved fragment dependency: ${id}`);
    visiting.add(id);
    for (const dependency of [...fragment.draft.spec.dependsOn].sort()) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(fragment);
  };
  for (const id of [...byId.keys()].sort()) visit(id);
  return ordered;
}

function assertCompiles(policy: PolicyAst, subject: string): void {
  const result = compilePolicy(policy);
  if (result.status !== "compiled") throw new GovernanceFragmentValidationError(`${subject} is contradictory`);
}

function compiledHash(policy: PolicyAst): string {
  const result = compilePolicy(policy);
  if (result.status !== "compiled") throw new GovernanceFragmentValidationError("base policy is contradictory");
  return result.policyHash;
}

function basePolicy(): PolicyAst {
  return policyFromLayers({
    core: {
      rules: [
        { key: "audit.block_at", value: "P3" },
        { key: "review.require_forge_publication", value: true },
      ],
    },
    org: { rules: [] },
    tier: { rules: [] },
    binding: { rules: [] },
  });
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
