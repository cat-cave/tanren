import { z } from "zod";
// Hard cap on the number of JSONL event lines the shared decoder scans before it
// stops and records a single `event_limit_exceeded` marker (see
// `decodeJsonlObjectEvents` in providers/findTokenUsage.ts). Defined here — the
// lowest contract layer — so the decoder AND every public failure schema/contract
// share one synchronized source (no magic-number drift).
export const MAX_JSONL_OBJECT_EVENTS = 50_000;
// The decoder emits at most one failure per scanned event plus that single
// overflow marker, so a well-formed decode-failure payload never exceeds this. The
// public contracts enforce it as an upper bound so a hand-crafted/replayed payload
// cannot carry an arbitrarily large `failures` array past the schema boundary.
export const MAX_JSONL_DECODE_FAILURES = MAX_JSONL_OBJECT_EVENTS + 1;
export const JsonlObjectParseFailureSchema = z
  .object({
    lineNumber: z.number().int().positive(),
    reason: z.enum(["invalid_json", "non_object", "line_too_large", "event_limit_exceeded"]),
  })
  .strict();
export const JsonlObjectDecodeFailureSchema = z
  .object({
    kind: z.literal("jsonl_object_decode_failed"),
    failures: z.array(JsonlObjectParseFailureSchema).min(1).max(MAX_JSONL_DECODE_FAILURES),
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
