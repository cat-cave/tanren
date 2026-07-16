/**
 * in-2: AppBindingOutputV1 — typed logical outputs a binding projects into
 * app env / runtime. Values are NEVER secrets; only logical keys + classification
 * + plane-scoped kind. Plane-A control kinds cannot be claimed on product plane.
 */

import { z } from "zod";

/** Control-plane (Tanren operator / Plane-A) binding output kinds. */
export const CONTROL_BINDING_OUTPUT_KINDS = [
  "control.notify.bot_token_ref",
  "control.notify.channel_id",
  "control.notify.webhook_url_ref",
  "control.inbox.source_ref",
  "control.deploy.provider_ref",
] as const;

/** Product-plane (built application) binding output kinds. */
export const PRODUCT_BINDING_OUTPUT_KINDS = [
  "product.messaging.bot_token_ref",
  "product.messaging.channel_id",
  "product.messaging.relay_binding_id",
  "product.messaging.webhook_url_ref",
  "product.errors.dsn_ref",
  "product.auth.client_id",
] as const;

export const ALL_BINDING_OUTPUT_KINDS = [...CONTROL_BINDING_OUTPUT_KINDS, ...PRODUCT_BINDING_OUTPUT_KINDS] as const;

export type ControlBindingOutputKind = (typeof CONTROL_BINDING_OUTPUT_KINDS)[number];
export type ProductBindingOutputKind = (typeof PRODUCT_BINDING_OUTPUT_KINDS)[number];
export type BindingOutputKind = (typeof ALL_BINDING_OUTPUT_KINDS)[number];

export function planeOfBindingKind(kind: BindingOutputKind): "control" | "product" {
  return kind.startsWith("control.") ? "control" : "product";
}

export const AppBindingOutputV1Schema = z
  .object({
    version: z.literal(1),
    kind: z.enum(ALL_BINDING_OUTPUT_KINDS),
    /** Logical env / config key the product or control plane consumes. */
    logicalKey: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Z][A-Z0-9_]*$/u),
    classification: z.enum(["secret_ref", "plain", "handle"]),
    required: z.boolean(),
    /**
     * Optional description for operators. Must not contain credential material.
     */
    description: z.string().max(500).optional(),
  })
  .strict();

export type AppBindingOutputV1 = z.infer<typeof AppBindingOutputV1Schema>;
