// ds-5 — the versioned wire contract inputs for the design Studio / reuse
// surface. The response SHAPES are built inline from the store's domain types
// (designStudioStore.ts) and carry `version` + scope ids so the dashboard client
// (services/dashboard/src/api/designStudio.ts) can reject a laundered payload;
// this module owns only the surface VERSION + the request-body schema the route
// parses.

import { z } from "zod";

export const DS_STUDIO_SURFACE_VERSION = "v1" as const;

const DesignBindingPinModeSchema = z.enum(["release", "channel"]);

/** The PUT reuse-binding body. Shape validity (release⊕channel) is CHECK-enforced
 * in the DB; the store additionally rejects a non-published / cross-org target. */
export const PutDesignBindingBodySchema = z
  .object({
    designSystemId: z.string().min(1),
    pinMode: DesignBindingPinModeSchema,
    pinnedReleaseId: z.string().min(1).optional(),
    channel: z.string().min(1).optional(),
  })
  .refine(
    (body) =>
      body.pinMode === "release"
        ? body.pinnedReleaseId !== undefined && body.channel === undefined
        : body.channel !== undefined && body.pinnedReleaseId === undefined,
    { message: "a release pin needs pinnedReleaseId only; a channel pin needs channel only" },
  );
