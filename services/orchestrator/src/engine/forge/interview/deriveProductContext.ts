// fix/f2-prompt-hardening: PROJECT PRODUCT CONTEXT for the F2 writer prompt.
//
// Assemble a semi-structured view of the captured INTENT — the design contract's
// principles + constraints as acceptance criteria, the captured personas +
// behaviors verbatim — so the writer can make DOMAIN-INFORMED defaults inside a
// fragment body (a db fragment for "link shortener with click counts" models
// `links(id, url, clicks)` roughly, not a generic `Item` table). Returns
// `undefined` when the capture surfaced NOTHING useful — the writer prompt then
// omits the product-context section cleanly rather than emitting an empty heading.
//
// Extracted from `derive.ts` so that file stays under the 500-line cap; the
// derive path threads the returned context into `runFragmentAuthoring` where
// `buildFragmentAuthoring` fans it out to every per-fragment writer call.

import type { ProductContext } from "../../templates/index.js";
import type { InterviewCapture } from "./types.js";

export function buildProductContextFromCapture(capture: InterviewCapture): ProductContext | undefined {
  const acceptanceCriteria = collectAcceptanceCriteria(capture);
  const personas = capture.personas.map((p) => ({
    name: p.name,
    description: p.description,
    ...(p.surface === "" ? {} : { surface: p.surface }),
  }));
  const behaviors = capture.behaviors.map((b) => ({
    persona: b.persona,
    title: b.title,
    ...(b.given === "" ? {} : { given: b.given }),
    ...(b.when === "" ? {} : { when: b.when }),
    // eslint-disable-next-line unicorn/no-thenable
    ...(b.then === "" ? {} : { then: b.then }),
  }));

  if (acceptanceCriteria.length === 0 && personas.length === 0 && behaviors.length === 0) return undefined;
  const context: ProductContext = {};
  if (acceptanceCriteria.length > 0) context.acceptanceCriteria = acceptanceCriteria;
  if (personas.length > 0) context.personas = personas;
  if (behaviors.length > 0) context.behaviors = behaviors;
  return context;
}

// Assemble the acceptance-criteria list from the durable design signal (the
// design contract's identity/intent/principles/constraints) plus the captured
// rulesets. Every line is a high-signal handle the writer can ground defaults in.
function collectAcceptanceCriteria(capture: InterviewCapture): string[] {
  const criteria: string[] = [];
  if (capture.designContract !== null) {
    const dc = capture.designContract;
    if (dc.identity !== "") criteria.push(`identity: ${dc.identity}`);
    if (dc.intent !== "") criteria.push(`intent: ${dc.intent}`);
    for (const principle of dc.principles) criteria.push(`principle: ${principle}`);
    for (const constraint of dc.constraints) criteria.push(`constraint: ${constraint}`);
  }
  for (const ruleset of capture.rulesets) criteria.push(`ruleset: ${ruleset}`);
  return criteria;
}
