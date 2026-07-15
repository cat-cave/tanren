/**
 * SP-1 owns immutable persona/behavior revision substrate (migration 0033);
 * content identity is a semantic domainHash key (NOT stored CAS bytes; NO
 * cas_artifacts FK); SP-5/6/7 import from './behaviorRevision.js' (SINGULAR).
 */

import type { CanonicalBody, Digest, DomainTag } from "./cas.js";
import { domainHash } from "./cas.js";

export type RevisionDigest = Digest;

export type BehaviorRevisionId = string & { readonly __brand: "BehaviorRevisionId" };

export type PersonaRevisionId = string & { readonly __brand: "PersonaRevisionId" };

export class MalformedBehaviorRevisionIdError extends Error {
  public override readonly name = "MalformedBehaviorRevisionIdError";

  public constructor(raw: string) {
    super(`Malformed behavior revision id: ${raw}`);
  }
}

export class MalformedPersonaRevisionIdError extends Error {
  public override readonly name = "MalformedPersonaRevisionIdError";

  public constructor(raw: string) {
    super(`Malformed persona revision id: ${raw}`);
  }
}

export function parseBehaviorRevisionId(raw: string): BehaviorRevisionId {
  if (raw === "") {
    throw new MalformedBehaviorRevisionIdError(raw);
  }
  return raw as BehaviorRevisionId;
}

export function parsePersonaRevisionId(raw: string): PersonaRevisionId {
  if (raw === "") {
    throw new MalformedPersonaRevisionIdError(raw);
  }
  return raw as PersonaRevisionId;
}

export const PERSONA_REVISION_TAG = "persona_revision.v1" satisfies DomainTag;
export const BEHAVIOR_REVISION_TAG = "behavior_revision.v1" satisfies DomainTag;

export type PersonaRevisionScope = "org" | "project";

export type RevisionStatus = "active" | "superseded" | "needs_respec";

export interface PersonaRevisionBody {
  readonly [k: string]: CanonicalBody;
  readonly personaId: string;
  readonly scope: PersonaRevisionScope;
  readonly projectId: string | null;
  readonly revisionNumber: number;
  readonly name: string;
  readonly description: string;
  readonly attributes: { readonly [k: string]: CanonicalBody };
  readonly supersedesId: string | null;
  readonly authoringProvenance: { readonly [k: string]: CanonicalBody };
}

/* eslint-disable unicorn/no-thenable */
export interface BehaviorRevisionBody {
  readonly [k: string]: CanonicalBody;
  readonly behaviorId: string;
  readonly personaRevisionId: string;
  readonly projectId: string | null;
  readonly revisionNumber: number;
  readonly title: string;
  readonly given: string;
  readonly when: string;
  readonly then: string;
  readonly acceptance: { readonly [k: string]: CanonicalBody };
  readonly designContractDigest: string | null;
  readonly supersedesId: string | null;
  readonly authoringProvenance: { readonly [k: string]: CanonicalBody };
}
/* eslint-enable unicorn/no-thenable */

export function personaRevisionDigest(body: PersonaRevisionBody): RevisionDigest {
  return domainHash(PERSONA_REVISION_TAG, body);
}

export function behaviorRevisionDigest(body: BehaviorRevisionBody): RevisionDigest {
  return domainHash(BEHAVIOR_REVISION_TAG, body);
}

export interface PersonaRevision {
  readonly id: PersonaRevisionId;
  readonly orgId: string;
  readonly projectId: string | null;
  readonly personaId: string;
  readonly scope: PersonaRevisionScope;
  readonly revisionNumber: number;
  readonly name: string;
  readonly description: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly contentDigest: RevisionDigest;
  readonly authoringProvenance: Readonly<Record<string, unknown>>;
  readonly supersedesId: PersonaRevisionId | null;
  readonly status: RevisionStatus;
  readonly createdAt: string;
}

/* eslint-disable unicorn/no-thenable */
export interface BehaviorRevision {
  readonly id: BehaviorRevisionId;
  readonly orgId: string;
  readonly projectId: string | null;
  readonly behaviorId: string;
  readonly personaRevisionId: PersonaRevisionId;
  readonly revisionNumber: number;
  readonly title: string;
  readonly given: string;
  readonly when: string;
  readonly then: string;
  readonly acceptance: Readonly<Record<string, unknown>>;
  readonly contentDigest: RevisionDigest;
  readonly designContractDigest: RevisionDigest | null;
  readonly authoringProvenance: Readonly<Record<string, unknown>>;
  readonly supersedesId: BehaviorRevisionId | null;
  readonly status: RevisionStatus;
  readonly createdAt: string;
}
/* eslint-enable unicorn/no-thenable */

export interface CreatePersonaRevisionInput {
  readonly orgId: string;
  readonly projectId: string | null;
  readonly personaId: string;
  readonly scope: PersonaRevisionScope;
  readonly name: string;
  readonly description: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly authoringProvenance: Readonly<Record<string, unknown>>;
  readonly supersedesId?: PersonaRevisionId | null;
}

/* eslint-disable unicorn/no-thenable */
export interface CreateBehaviorRevisionInput {
  readonly orgId: string;
  readonly projectId: string | null;
  readonly behaviorId: string;
  readonly personaRevisionId: PersonaRevisionId;
  readonly title: string;
  readonly given: string;
  readonly when: string;
  readonly then: string;
  readonly acceptance: Readonly<Record<string, unknown>>;
  readonly designContractDigest?: RevisionDigest | null;
  readonly authoringProvenance: Readonly<Record<string, unknown>>;
  readonly supersedesId?: BehaviorRevisionId | null;
}
/* eslint-enable unicorn/no-thenable */

export interface PersonaRevisionStore {
  create(input: CreatePersonaRevisionInput): Promise<PersonaRevision>;
  getById(orgId: string, id: PersonaRevisionId): Promise<PersonaRevision | undefined>;
  getActiveForLineage(orgId: string, personaId: string): Promise<PersonaRevision | undefined>;
}

export interface BehaviorRevisionStore {
  create(input: CreateBehaviorRevisionInput): Promise<BehaviorRevision>;
  getById(orgId: string, id: BehaviorRevisionId): Promise<BehaviorRevision | undefined>;
  getActiveForLineage(orgId: string, behaviorId: string): Promise<BehaviorRevision | undefined>;
}
