// The NO-MATCH AUTO-TRIGGER hook (docs/roadmap/templating-system.md §3 — the "no
// match → trigger template creation" decision). Forge's ARCHITECTURE step queries
// the registry by capabilities BEFORE deriving scaffold specs; when no validated
// template matches, it falls to creation (§2). This module is that hook: given a
// capability query + a creation request, it checks the registry for a validated
// match and, finding none, runs the creation meta-flow.
//
// It is a thin composition over the registry query (`TemplateStore.listByCapabilities`,
// wave 1) + `createTemplate` (this wave) — selection (a later wave) calls it as
// the "would-create" branch. Kept separate from `createTemplate` so the
// orchestration core has no selection-query dependency, and so selection can call
// EITHER the query (to seed) OR this hook (to create) without circular wiring.

import { TemplateStore, type Template, type TemplateCapabilityQuery } from "../../repositories/templates.js";
import { isProofFresh } from "../../forge/interview/templateSelection.js";
import { createTemplate, type CreateTemplateDeps, type CreateTemplateResult } from "./createTemplate.js";
import type { TemplateCreationRequest } from "./research.js";

// The decision the hook returns: either an existing validated template was found
// (selection seeds from it — `created: false`), or none was, so creation ran and
// produced one (`created: true`). Either way the caller gets a usable template.
export type NoMatchDecision = { created: false; template: Template } | { created: true; result: CreateTemplateResult };

// Build the capability query the no-match check uses from the creation request —
// the SAME capability vocabulary the registry filters on. Restricted to the
// VALIDATED tiers (`validated`/`official`): a `draft`/`degraded` template is not a
// usable match (selection only seeds from a proven template), so its presence must
// still trigger creation. Channel is matched when the request pins one.
function queryFor(request: TemplateCreationRequest): TemplateCapabilityQuery {
  return {
    runtime: request.runtime,
    packageManager: request.packageManager,
    ...(request.framework === undefined ? {} : { framework: request.framework }),
    ...(request.deployTarget === undefined ? {} : { deployTarget: request.deployTarget }),
    ...(request.channel === undefined ? {} : { channel: request.channel }),
    statuses: ["validated", "official"],
  };
}

// The no-match auto-trigger. Query the registry for a VALIDATED template matching
// the request's capabilities; if one with a FRESH proof exists, return it (selection
// seeds — no creation). If NONE matches (or every match is STALE), run the creation
// meta-flow and return the new template. Org-scoped: the query + the creation both run
// under `deps.actor`'s org scope (RLS bounds the query to the org's own + the official
// catalogue).
//
// PROOF-FRESHNESS PARITY with `selectTemplate` (templateSelection.ts): the registry
// `statuses` filter alone does NOT enforce the 30-day freshness re-check, so a
// `validated`-status template whose proof has gone STALE (>30 days) would otherwise be
// re-seeded here — exactly the stale seed `selectTemplate` rejects at its decision
// boundary. We apply `isProofFresh` so a stale match falls THROUGH to creation (which
// publishes a fresh proof), never seeds. `deps.now()` is the SAME clock the rest of the
// creation flow uses (deterministic in tests).
//
// A creation that FAILS validation propagates LOUD (TemplateValidationFailedError
// from `createTemplate`) — the no-match path never returns a degraded template.
export async function maybeCreateTemplateForNoMatch(
  deps: CreateTemplateDeps,
  request: TemplateCreationRequest,
): Promise<NoMatchDecision> {
  const now = deps.now().getTime();
  const matches = await TemplateStore.listByCapabilities(deps.pool, queryFor(request), { kind: "operator" });
  const existing = matches.find((t) => isProofFresh(t.manifest.validationProof, now));
  if (existing !== undefined) {
    return { created: false, template: existing };
  }
  const result = await createTemplate(deps, request);
  return { created: true, result };
}
