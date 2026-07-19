import { z } from "zod";
import { renderAnswererJsonSchema } from "../../answerers/schemas/index.js";
import { createAuthoringKernel } from "../../authoring/authoringKernelRunner.js";
import type {
  AuthoringAuthorer,
  AuthoringEvents,
  AuthoringFamilyBinding,
  AuthoringKernelResult,
} from "../../contracts/authoringKernel.js";
import type { EventStore } from "../../eventStore.js";
import {
  GovernanceFragmentAuthoringAttemptPayload,
  GovernanceFragmentAuthoringFailedPayload,
  GovernanceFragmentAuthoringStartedPayload,
  GovernanceFragmentAuthoringSucceededPayload,
} from "../../events/schemas/governanceVocabulary.js";
import type { AnswererAdapter } from "../../providers/types.js";
import {
  BASE_GOVERNANCE_FRAGMENT,
  GovernanceFragmentConfigSchema,
  GovernanceFragmentDraftSchema,
  GovernanceFragmentValidationError,
  canonicalJson,
  composeGovernancePolicy,
  diffGovernanceFragmentSnapshots,
  validateGovernanceFragment,
  type GovernanceFragmentConfig,
  type GovernanceFragmentDraft,
  type GovernanceFragmentSpec,
  type GovernanceFragmentSnapshotEntry,
  type ValidatedGovernanceFragment,
} from "./model.js";
import { persistedId, type GovernanceFragmentPersistenceStore } from "./store.js";

const ContextSchema = z
  .object({ orgId: z.string().min(1), projectId: z.string().min(1), createdBy: z.string().min(1) })
  .strict();
type Context = z.infer<typeof ContextSchema>;
type FragmentEventStore = Pick<EventStore, "append">;

export class GovernanceFragmentAuthoringFailedError extends Error {
  constructor(
    readonly failedIds: readonly string[],
    readonly failureReasons: Readonly<Record<string, string>> = {},
  ) {
    super(`governance fragment authoring failed for: ${failedIds.join(", ") || "<none>"}`);
    this.name = "GovernanceFragmentAuthoringFailedError";
  }
}

export function wrapProviderGovernanceFragmentAuthorer(
  adapter: AnswererAdapter<GovernanceFragmentDraft>,
): AuthoringAuthorer<GovernanceFragmentSpec, GovernanceFragmentDraft> {
  const jsonSchema = renderAnswererJsonSchema(GovernanceFragmentDraftSchema);
  return {
    async author(input): Promise<GovernanceFragmentDraft> {
      const output = await adapter.runAnswerer({
        prompt: governanceFragmentAuthoringPrompt(input.spec, input.previousAttempt?.rejection),
        outputSchema: {
          name: "tanren.governance_fragment.v1",
          jsonSchema,
          parse: (value): GovernanceFragmentDraft => GovernanceFragmentDraftSchema.parse(value),
        },
      });
      return GovernanceFragmentDraftSchema.parse(output);
    },
  };
}

export async function resolveGovernanceFragmentConfig(input: {
  readonly config: unknown;
  readonly context: unknown;
  readonly authorer?: AuthoringAuthorer<GovernanceFragmentSpec, GovernanceFragmentDraft>;
  readonly store: GovernanceFragmentPersistenceStore;
  readonly eventStore: FragmentEventStore;
  readonly previousSnapshot?: readonly GovernanceFragmentSnapshotEntry[];
}): Promise<{
  readonly policy: ReturnType<typeof composeGovernancePolicy>["policy"];
  readonly snapshot: readonly GovernanceFragmentSnapshotEntry[];
  readonly snapshotDiff: ReturnType<typeof diffGovernanceFragmentSnapshots>;
}> {
  const context = ContextSchema.parse(input.context);
  const config = GovernanceFragmentConfigSchema.parse(input.config);
  const existing = await input.store.listValidated(context.orgId);
  const byId = new Map(existing.map((fragment) => [persistedId(fragment.draft.spec), fragment]));
  const missing = orderedMissing(config, byId);
  if (missing.length > 0) {
    if (input.authorer === undefined)
      throw new GovernanceFragmentAuthoringFailedError(missing.map((spec) => persistedId(spec)));
    const result = await runGovernanceFragmentAuthoring({
      missing,
      context,
      authorer: input.authorer,
      store: input.store,
      eventStore: input.eventStore,
      present: config.fragments.flatMap((spec) => {
        const fragment = byId.get(persistedId(spec));
        return fragment === undefined ? [] : [fragment];
      }),
    });
    if (result.failedIds.length > 0 || result.validated.length !== missing.length) {
      throw new GovernanceFragmentAuthoringFailedError(result.failedIds, result.failureReasons);
    }
  }
  const available = new Map(
    (await input.store.listValidated(context.orgId)).map((fragment) => [persistedId(fragment.draft.spec), fragment]),
  );
  const selected = config.fragments.map((spec) => {
    const fragment = available.get(persistedId(spec));
    if (fragment === undefined || canonicalJson(fragment.draft.spec) !== canonicalJson(spec)) {
      throw new GovernanceFragmentAuthoringFailedError([persistedId(spec)], {
        [persistedId(spec)]: "fragment_unresolved_or_mismatched",
      });
    }
    return fragment;
  });
  const composed = composeGovernancePolicy([BASE_GOVERNANCE_FRAGMENT, ...selected]);
  return {
    ...composed,
    snapshotDiff: diffGovernanceFragmentSnapshots(input.previousSnapshot ?? [], composed.snapshot),
  };
}

async function runGovernanceFragmentAuthoring(input: {
  readonly missing: readonly GovernanceFragmentSpec[];
  readonly context: Context;
  readonly authorer: AuthoringAuthorer<GovernanceFragmentSpec, GovernanceFragmentDraft>;
  readonly store: GovernanceFragmentPersistenceStore;
  readonly eventStore: FragmentEventStore;
  readonly present: readonly ValidatedGovernanceFragment[];
}): Promise<AuthoringKernelResult<ValidatedGovernanceFragment>> {
  const binding: AuthoringFamilyBinding<
    GovernanceFragmentSpec,
    GovernanceFragmentDraft,
    ValidatedGovernanceFragment,
    GovernanceFragmentEvent
  > = {
    familyId: "gv-10",
    unitId: persistedId,
    authorer: input.authorer,
    validator: {
      async validate({ draft }) {
        try {
          return { kind: "valid", validated: validateFragment(draft) };
        } catch (error) {
          return { kind: "rejected", rejection: error instanceof Error ? error.message : String(error) };
        }
      },
    },
    persistence: {
      createValidated: ({ validated }) => input.store.createValidated({ ...input.context, fragment: validated }),
      deleteById: (id) => input.store.deleteById(input.context.orgId, id),
    },
    batchCompose: {
      async compose({ authored }) {
        try {
          composeGovernancePolicy([
            BASE_GOVERNANCE_FRAGMENT,
            ...input.present,
            ...authored.map((entry) => entry.validated),
          ]);
          return { kind: "passed" };
        } catch (error) {
          return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
        }
      },
    },
    signatures: { canonicalize: canonicalJson, sanitize: sanitize, preview: canonicalJson },
    events: governanceFragmentEvents(input.context, input.eventStore),
  };
  return createAuthoringKernel<
    GovernanceFragmentSpec,
    GovernanceFragmentDraft,
    ValidatedGovernanceFragment,
    GovernanceFragmentEvent
  >().run({ missing: input.missing, context: input.context }, binding);
}

type GovernanceFragmentEvent =
  | {
      readonly eventType: "governanceFragment.authoring.started";
      readonly payload: z.infer<typeof GovernanceFragmentAuthoringStartedPayload>;
    }
  | {
      readonly eventType: "governanceFragment.authoring.attempt";
      readonly payload: z.infer<typeof GovernanceFragmentAuthoringAttemptPayload>;
    }
  | {
      readonly eventType: "governanceFragment.authoring.succeeded";
      readonly payload: z.infer<typeof GovernanceFragmentAuthoringSucceededPayload>;
    }
  | {
      readonly eventType: "governanceFragment.authoring.failed";
      readonly payload: z.infer<typeof GovernanceFragmentAuthoringFailedPayload>;
    };

function governanceFragmentEvents(
  context: Context,
  eventStore: FragmentEventStore,
): AuthoringEvents<
  GovernanceFragmentSpec,
  GovernanceFragmentDraft,
  ValidatedGovernanceFragment,
  GovernanceFragmentEvent
> {
  return {
    factory: {
      build: ({ lifecycle }): GovernanceFragmentEvent => {
        const fragmentId =
          lifecycle.point === "started"
            ? lifecycle.spec.fragmentId
            : (lifecycle.unitId.split("@")[0] ?? lifecycle.unitId);
        switch (lifecycle.point) {
          case "started":
            return {
              eventType: "governanceFragment.authoring.started",
              payload: GovernanceFragmentAuthoringStartedPayload.parse({ fragmentId, version: lifecycle.spec.version }),
            };
          case "attempt":
            return {
              eventType: "governanceFragment.authoring.attempt",
              payload: GovernanceFragmentAuthoringAttemptPayload.parse({
                fragmentId,
                attempt: lifecycle.attempt,
                signature: lifecycle.canonicalSignature.slice(0, 256),
                rejection: lifecycle.rejection.slice(0, 256) || null,
              }),
            };
          case "succeeded":
            return {
              eventType: "governanceFragment.authoring.succeeded",
              payload: GovernanceFragmentAuthoringSucceededPayload.parse({
                fragmentId,
                version: lifecycle.validated.draft.spec.version,
                fragmentDigest: lifecycle.validated.fragmentDigest,
              }),
            };
          case "failed":
            return {
              eventType: "governanceFragment.authoring.failed",
              payload: GovernanceFragmentAuthoringFailedPayload.parse({
                fragmentId,
                attempts: lifecycle.attempts,
                reason: lifecycle.reason.slice(0, 256),
              }),
            };
          default: {
            const exhaustive: never = lifecycle;
            throw new Error(`unreachable governance fragment lifecycle: ${JSON.stringify(exhaustive)}`);
          }
        }
      },
    },
    sink: {
      async emit(event): Promise<void> {
        await eventStore.append({
          orgId: context.orgId,
          projectId: context.projectId,
          eventType: event.eventType,
          payload: event.payload,
        });
      },
    },
  };
}

function orderedMissing(
  config: GovernanceFragmentConfig,
  present: ReadonlyMap<string, ValidatedGovernanceFragment>,
): GovernanceFragmentSpec[] {
  const specs = new Map(config.fragments.map((spec) => [spec.fragmentId, spec]));
  const ordered: GovernanceFragmentSpec[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new GovernanceFragmentAuthoringFailedError([id], { [id]: "dependency_cycle" });
    const spec = specs.get(id);
    if (spec === undefined) throw new GovernanceFragmentAuthoringFailedError([id], { [id]: "dependency_not_selected" });
    visiting.add(id);
    for (const dependency of [...spec.dependsOn].sort()) {
      if (dependency !== "base") visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
    if (!present.has(persistedId(spec))) ordered.push(spec);
  };
  for (const id of [...specs.keys()].sort()) visit(id);
  return ordered;
}

function validateFragment(draft: GovernanceFragmentDraft): ValidatedGovernanceFragment {
  try {
    return validateGovernanceFragment(draft);
  } catch (error) {
    if (error instanceof GovernanceFragmentValidationError) throw error;
    throw new GovernanceFragmentValidationError(error instanceof Error ? error.message : String(error));
  }
}

function sanitize(value: string): string {
  return value.replaceAll(/[0-9a-f]{8,}/giu, "<id>").slice(0, 256);
}

function governanceFragmentAuthoringPrompt(spec: GovernanceFragmentSpec, previousRejection?: string): string {
  return [
    "Author one declarative Tanren governance fragment. Return only the required JSON object.",
    "Do not generate TypeScript, JavaScript, expressions, commands, or arbitrary enforcement primitives.",
    "The fragment policy must exactly equal requiredPolicy. Include a UI JSON schema, positive and negative conformance vectors, and simulator snapshots whose hashes are deterministic compiler hashes.",
    `Specification: ${canonicalJson(spec)}`,
    ...(previousRejection === undefined ? [] : [`Previous validation rejection: ${previousRejection}`]),
  ].join("\n");
}
