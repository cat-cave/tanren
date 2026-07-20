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
  IntegrationAuthorAttemptPayload,
  IntegrationAuthorFailedPayload,
  IntegrationAuthorStartedPayload,
  IntegrationAuthorSucceededPayload,
} from "../../events/schemas/eventVocabularyW1aIntegrationAuthor.js";
import type { AnswererAdapter } from "../../providers/types.js";
import {
  canonicalJson,
  composeIntegrationDefinitions,
  IntegrationFragmentConfigSchema,
  IntegrationFragmentDraftSchema,
  IntegrationFragmentValidationError,
  persistedId,
  validateIntegrationFragment,
  type IntegrationFragmentConfig,
  type IntegrationFragmentDraft,
  type IntegrationFragmentSnapshotEntry,
  type IntegrationFragmentSpec,
  type ValidatedIntegrationFragment,
} from "./model.js";
import type { IntegrationFragmentPersistenceStore } from "./store.js";

const MISSION_NODE_ID = "in-7" as const;

const ContextSchema = z
  .object({ orgId: z.string().min(1), projectId: z.string().min(1), createdBy: z.string().min(1) })
  .strict();
type Context = z.infer<typeof ContextSchema>;
type FragmentEventStore = Pick<EventStore, "append">;

export class IntegrationFragmentAuthoringFailedError extends Error {
  constructor(
    readonly failedIds: readonly string[],
    readonly failureReasons: Readonly<Record<string, string>> = {},
  ) {
    super(`integration fragment authoring failed for: ${failedIds.join(", ") || "<none>"}`);
    this.name = "IntegrationFragmentAuthoringFailedError";
  }
}

/** Wrap a real Forge answerer as the F2 writer for provider integration definitions. */
export function wrapProviderIntegrationFragmentAuthorer(
  adapter: AnswererAdapter<IntegrationFragmentDraft>,
): AuthoringAuthorer<IntegrationFragmentSpec, IntegrationFragmentDraft> {
  const jsonSchema = renderAnswererJsonSchema(IntegrationFragmentDraftSchema);
  return {
    async author(input): Promise<IntegrationFragmentDraft> {
      const output = await adapter.runAnswerer({
        prompt: integrationFragmentAuthoringPrompt(input.spec, input.previousAttempt?.rejection),
        outputSchema: {
          name: "tanren.integration_fragment.v1",
          jsonSchema,
          parse: (value): IntegrationFragmentDraft => IntegrationFragmentDraftSchema.parse(value),
        },
      });
      return IntegrationFragmentDraftSchema.parse(output);
    },
  };
}

/**
 * The production integration derivation seam: resolve the provider-specific
 * integration DEFINITIONS a project's requirement config needs from the org
 * registry; a missing definition spawns the F2 authoring DAG (writer→validate,
 * fixed-point convergent, the shared SP-2 kernel) or — with no authorer, or on a
 * non-converging / batch-rejected authoring — HALTS LOUD with a typed error.
 * Returns the composed, coherent augmented definition set.
 */
export async function resolveIntegrationFragments(input: {
  readonly config: unknown;
  readonly context: unknown;
  readonly authorer?: AuthoringAuthorer<IntegrationFragmentSpec, IntegrationFragmentDraft>;
  readonly store: IntegrationFragmentPersistenceStore;
  readonly eventStore: FragmentEventStore;
}): Promise<{
  readonly definitions: readonly ValidatedIntegrationFragment[];
  readonly snapshot: readonly IntegrationFragmentSnapshotEntry[];
}> {
  const context = ContextSchema.parse(input.context);
  const config = IntegrationFragmentConfigSchema.parse(input.config);
  const existing = await input.store.listValidated(context.orgId);
  const byId = new Map(existing.map((fragment) => [persistedId(fragment.draft.spec), fragment]));
  const missing = orderedMissing(config, byId);

  if (missing.length > 0) {
    if (input.authorer === undefined) {
      throw new IntegrationFragmentAuthoringFailedError(missing.map((spec) => persistedId(spec)));
    }
    const result = await runIntegrationFragmentAuthoring({
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
      throw new IntegrationFragmentAuthoringFailedError(result.failedIds, result.failureReasons);
    }
  }

  const available = new Map(
    (await input.store.listValidated(context.orgId)).map((fragment) => [persistedId(fragment.draft.spec), fragment]),
  );
  const selected = config.fragments.map((spec) => {
    const fragment = available.get(persistedId(spec));
    if (fragment === undefined || canonicalJson(fragment.draft.spec) !== canonicalJson(spec)) {
      throw new IntegrationFragmentAuthoringFailedError([persistedId(spec)], {
        [persistedId(spec)]: "fragment_unresolved_or_mismatched",
      });
    }
    return fragment;
  });
  return composeIntegrationDefinitions(selected);
}

async function runIntegrationFragmentAuthoring(input: {
  readonly missing: readonly IntegrationFragmentSpec[];
  readonly context: Context;
  readonly authorer: AuthoringAuthorer<IntegrationFragmentSpec, IntegrationFragmentDraft>;
  readonly store: IntegrationFragmentPersistenceStore;
  readonly eventStore: FragmentEventStore;
  readonly present: readonly ValidatedIntegrationFragment[];
}): Promise<AuthoringKernelResult<ValidatedIntegrationFragment>> {
  const binding: AuthoringFamilyBinding<
    IntegrationFragmentSpec,
    IntegrationFragmentDraft,
    ValidatedIntegrationFragment,
    IntegrationAuthorEvent
  > = {
    familyId: "in-7",
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
          composeIntegrationDefinitions([...input.present, ...authored.map((entry) => entry.validated)]);
          return { kind: "passed" };
        } catch (error) {
          return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
        }
      },
    },
    signatures: { canonicalize: canonicalJson, sanitize, preview: canonicalJson },
    events: integrationFragmentEvents(input.context, input.eventStore),
  };
  return createAuthoringKernel<
    IntegrationFragmentSpec,
    IntegrationFragmentDraft,
    ValidatedIntegrationFragment,
    IntegrationAuthorEvent
  >().run({ missing: input.missing, context: input.context }, binding);
}

type IntegrationAuthorEvent =
  | {
      readonly eventType: "integration.author.started";
      readonly payload: z.infer<typeof IntegrationAuthorStartedPayload>;
    }
  | {
      readonly eventType: "integration.author.attempt";
      readonly payload: z.infer<typeof IntegrationAuthorAttemptPayload>;
    }
  | {
      readonly eventType: "integration.author.succeeded";
      readonly payload: z.infer<typeof IntegrationAuthorSucceededPayload>;
    }
  | {
      readonly eventType: "integration.author.failed";
      readonly payload: z.infer<typeof IntegrationAuthorFailedPayload>;
    };

function integrationFragmentEvents(
  context: Context,
  eventStore: FragmentEventStore,
): AuthoringEvents<
  IntegrationFragmentSpec,
  IntegrationFragmentDraft,
  ValidatedIntegrationFragment,
  IntegrationAuthorEvent
> {
  return {
    factory: {
      build: ({ lifecycle }): IntegrationAuthorEvent => {
        const identity = { missionNodeId: MISSION_NODE_ID, unitId: lifecycle.unitId } as const;
        switch (lifecycle.point) {
          case "started":
            return {
              eventType: "integration.author.started",
              payload: IntegrationAuthorStartedPayload.parse(identity),
            };
          case "attempt":
            return {
              eventType: "integration.author.attempt",
              payload: IntegrationAuthorAttemptPayload.parse({
                ...identity,
                attempt: lifecycle.attempt,
                // The kernel truncates to 500 + an ellipsis (501 chars); the frozen
                // W1-A payload bounds bodyPreview to 500, so bound it here.
                bodyPreview: lifecycle.bodyPreview.slice(0, 500),
                canonicalSignature: boundedSignature(lifecycle.canonicalSignature),
                rejection: lifecycle.rejection.slice(0, 2_000),
                decision: lifecycle.decision,
              }),
            };
          case "succeeded":
            return {
              eventType: "integration.author.succeeded",
              payload: IntegrationAuthorSucceededPayload.parse({ ...identity, attempts: lifecycle.attempts }),
            };
          case "failed":
            return {
              eventType: "integration.author.failed",
              payload: IntegrationAuthorFailedPayload.parse({
                ...identity,
                reason: lifecycle.reason.slice(0, 2_000) || "integration fragment authoring failed",
                attempts: lifecycle.attempts,
              }),
            };
          default: {
            const exhaustive: never = lifecycle;
            throw new Error(`unreachable integration author lifecycle: ${JSON.stringify(exhaustive)}`);
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

/** Missing = a config spec with no matching validated registry row. */
function orderedMissing(
  config: IntegrationFragmentConfig,
  present: ReadonlyMap<string, ValidatedIntegrationFragment>,
): IntegrationFragmentSpec[] {
  return config.fragments
    .filter((spec) => !present.has(persistedId(spec)))
    .sort((left, right) => (persistedId(left) < persistedId(right) ? -1 : 1));
}

function validateFragment(draft: IntegrationFragmentDraft): ValidatedIntegrationFragment {
  try {
    return validateIntegrationFragment(draft);
  } catch (error) {
    if (error instanceof IntegrationFragmentValidationError) throw error;
    throw new IntegrationFragmentValidationError(error instanceof Error ? error.message : String(error));
  }
}

/** Non-empty, ≤256-char convergence signature (the W1-A payload bound). */
function boundedSignature(signature: string): string {
  const trimmed = signature.slice(0, 256);
  return trimmed.length === 0 ? "<empty>" : trimmed;
}

function sanitize(value: string): string {
  return value.replaceAll(/[0-9a-f]{8,}/giu, "<id>").slice(0, 256);
}

function integrationFragmentAuthoringPrompt(spec: IntegrationFragmentSpec, previousRejection?: string): string {
  return [
    "Author one declarative Tanren provider integration definition. Return only the required JSON object.",
    "Do not generate TypeScript, JavaScript, expressions, commands, secrets, or arbitrary enforcement primitives.",
    "The definition must describe the binding outputs the integration produces (each binding-output kind's plane must match the definition plane), the supported operations, and a pre-merge/post-deploy validation plan. Live provider calls are forbidden in the merge gate.",
    `Specification: ${canonicalJson(spec)}`,
    ...(previousRejection === undefined ? [] : [`Previous validation rejection: ${previousRejection}`]),
  ].join("\n");
}
