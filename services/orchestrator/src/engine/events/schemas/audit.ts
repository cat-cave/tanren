import { z } from "zod";

// AUDIT-EVIDENCE BASELINE (tanren-direction.md § "Audit And Compliance Baseline").
//
// The doctrine requires every GOVERNING delivery decision — a gate verdict, a
// deploy, a merge — to carry enough evidence for an enterprise audit WITHOUT an
// external workflow engine: who initiated it, who (if anyone) approved it, and
// under WHICH versioned governance policy the decision was made. These are the
// fields the event store (the central typed audit path) was missing; this module
// is the single shared shape so every governing event teaches the SAME audit model
// rather than re-deriving it per event.
//
// SECURITY BASELINE (a hard rule, itself part of the security doctrine): every
// field here is NON-SECRET — an actor is a KIND + an opaque id/label, never a
// credential; a policy version is a small integer. No secret value ever enters an
// event payload, so this envelope is safe to surface to any project member and is
// tagged `public` in the sensitivity table.

// AuditActor — a generic, role-neutral identification of WHO drove a governed
// action, for the audit trail. `kind` distinguishes a HUMAN operator from a
// SERVICE actor (the autonomous engine), which is the enterprise-audit question
// "was this human-initiated or machine-initiated?". `id` is the opaque actor
// handle (a user id for a human, a service/agent name for a machine) — never a
// secret, never a credential ref. `label` is an optional human-readable display
// name. Mirrors the engine's `ActorRef` (state/actor.ts) but is the EVENT-payload
// projection: a frozen, secret-free shape the event schema owns independently of
// the runtime actor type.
export const AuditActor = z
  .object({
    /** human = an operator/user; service = the autonomous engine / an automated role. */
    kind: z.enum(["human", "service"]),
    /** The opaque actor handle (user id / service name). NEVER a secret or credential. */
    id: z.string().min(1).optional(),
    /** Optional human-readable display label (e.g. a username). NEVER a secret. */
    label: z.string().min(1).optional(),
  })
  .strict();
export type AuditActor = z.infer<typeof AuditActor>;

// AuditEnvelope — the shared evidence fields a governing event (gate/deploy/merge)
// carries so the audit trail records the actor + governance policy version behind
// each decision. Every field is OPTIONAL on the schema (a fixture/scaffold emit, or
// a historical event, validates without it) but the live governing emit sites ALWAYS
// populate `policyVersion` + `initiatingActor`; `approvingActor` is present only when
// a human verdict actually gated the action (a human-review merge), absent for the
// autonomous tiers (recording the honest "no human approver" state, not a stub).
export const AuditEnvelope = z
  .object({
    /**
     * The versioned governance policy in effect for this decision — the project
     * config version that defines its gate/merge/deploy governance (posture,
     * review policy, merge integration). A monotonically-incrementing integer; an
     * auditor reads it to know WHICH policy revision the decision was judged under.
     */
    policyVersion: z.number().int().nonnegative().optional(),
    /** WHO initiated the action (human operator | the autonomous service). */
    initiatingActor: AuditActor.optional(),
    /**
     * WHO approved the action, when an explicit approval gated it (a human reviewer
     * on the human-review tier). Absent ⇒ no separate approver (the autonomous /
     * auto-review tiers) — an honest empty state, never a placeholder actor.
     */
    approvingActor: AuditActor.optional(),
  })
  .strict();
export type AuditEnvelope = z.infer<typeof AuditEnvelope>;

// The flattened sensitivity-rule paths for the audit envelope, reused by each
// governing event's rule block so the actor/policy fields are tagged identically
// (and exactly once per event) wherever the envelope is embedded. Every path is
// `public`: the envelope is non-secret by construction (the security baseline).
export function auditEnvelopeSensitivityPaths(): ReadonlyArray<[string, "public"]> {
  return [
    ["policyVersion", "public"],
    ["initiatingActor.kind", "public"],
    ["initiatingActor.id", "public"],
    ["initiatingActor.label", "public"],
    ["approvingActor.kind", "public"],
    ["approvingActor.id", "public"],
    ["approvingActor.label", "public"],
  ];
}

// Project the engine's runtime `ActorRef` onto the frozen `AuditActor` event shape.
// The runtime taxonomy is finer-grained (writer / answerer / ci_poller
// / ...); for the audit trail the only durable distinction is human-vs-service, so
// every non-`operator` kind projects to `service` and `operator` projects to `human`.
// `id`/`label` carry through verbatim (they are already non-secret handles).
export function auditActorFromRef(ref: { kind: string; id?: string; label?: string }): AuditActor {
  return {
    kind: ref.kind === "operator" ? "human" : "service",
    ...(ref.id === undefined ? {} : { id: ref.id }),
    ...(ref.label === undefined ? {} : { label: ref.label }),
  };
}

// The canonical SERVICE actor for the autonomous engine — the initiating actor on
// every event the DagWalker / workers drive with no human in the loop. A named
// constant so every autonomous governing emit records the SAME service identity
// rather than an ad-hoc literal.
export const serviceAuditActor: AuditActor = { kind: "service", id: "tanren-engine" };
