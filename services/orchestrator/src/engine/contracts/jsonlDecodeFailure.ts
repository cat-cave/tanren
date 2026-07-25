import { z } from "zod";
export const JsonlObjectParseFailureSchema = z
  .object({
    lineNumber: z.number().int().positive(),
    reason: z.enum(["invalid_json", "non_object", "line_too_large", "event_limit_exceeded"]),
  })
  .strict();
export const JsonlObjectDecodeFailureSchema = z
  .object({
    kind: z.literal("jsonl_object_decode_failed"),
    failures: z.array(JsonlObjectParseFailureSchema).min(1),
  })
  .strict();
export type JsonlObjectParseFailure = z.infer<typeof JsonlObjectParseFailureSchema>;
export type JsonlObjectDecodeFailure = z.infer<typeof JsonlObjectDecodeFailureSchema>;
export function projectPublicJsonlObjectDecodeFailure(failure: JsonlObjectDecodeFailure): JsonlObjectDecodeFailure {
  return JsonlObjectDecodeFailureSchema.parse({
    kind: failure.kind,
    failures: failure.failures.map(({ lineNumber, reason }) => ({ lineNumber, reason })),
  });
}
