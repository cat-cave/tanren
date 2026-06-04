// The provider-backed audit Answerer (the real LLM seam for scheduled audits).
//
// Adapts an `AnswererAdapter` (Claude/Codex, resolved via the Forge allocating
// adapter) into the `AuditAnswerer` seam. Each `audit` is one structured
// provider call over the read-only repo index returning an `AuditPassReport` —
// the owner's standing code-critique ("find the bugs, weak spots, missing tests,
// slow/fragile areas worth fixing") run on a cadence. Production wires this
// through the scheduler's pass runner; tests inject a fake so no test hits a
// provider. This is the analogue of the brownfield recon answerer: a read-only
// model pass over the indexed repo, but it surfaces ACTIONABLE findings instead
// of reconstructing chapters.

import { renderAnswererJsonSchema } from "../../answerers/schemas/index.js";
import type { AnswererAdapter } from "../../providers/types.js";
import { buildAuditPrompt } from "./prompt.js";
import { AuditPassReport, type AuditAnswerer, type AuditAnswererContext } from "./types.js";

const SCHEMA_NAME = "tanren.scheduled_audit.v1";

export interface WrapProviderAuditAnswererOptions {
  // Bounds each provider call. Defaults to 180s — an audit reads a whole repo
  // index and reasons over it, the same budget the recon answerer takes.
  timeoutMs?: number;
}

export function wrapProviderAuditAnswerer(
  adapter: AnswererAdapter<AuditPassReport>,
  options: WrapProviderAuditAnswererOptions = {},
): AuditAnswerer {
  const jsonSchema = renderAnswererJsonSchema(AuditPassReport);
  return {
    async audit(context: AuditAnswererContext): Promise<AuditPassReport> {
      return adapter.runAnswerer({
        prompt: buildAuditPrompt(context),
        timeoutMs: options.timeoutMs ?? 180_000,
        outputSchema: {
          name: SCHEMA_NAME,
          jsonSchema,
          parse: (value) => AuditPassReport.parse(value),
        },
      });
    },
  };
}
