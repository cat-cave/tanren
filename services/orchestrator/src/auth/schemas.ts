import { z } from "zod";

export const OrgKindSchema = z.enum(["github_org", "github_user", "oidc"]);
export type OrgKind = z.infer<typeof OrgKindSchema>;

export const IdentityProviderIdSchema = z.enum(["github_oauth", "oidc", "local_dev"]);
export type IdentityProviderId = z.infer<typeof IdentityProviderIdSchema>;

export const OrgMemberRoleSchema = z.enum(["admin", "member"]);
export type OrgMemberRole = z.infer<typeof OrgMemberRoleSchema>;

export const ProjectMemberRoleSchema = z.enum(["admin", "member"]);
export type ProjectMemberRole = z.infer<typeof ProjectMemberRoleSchema>;

export const TokenScopeSchema = z.enum(["read", "write", "admin"]);
export type TokenScope = z.infer<typeof TokenScopeSchema>;

export const ActorScopeSchema = z.enum([
  "platform:admin",
  "org:admin",
  "org:member",
  "project:admin",
  "project:member"
]);
export type ActorScope = z.infer<typeof ActorScopeSchema>;

export const OrgSchema = z.object({
  id: z.string().min(1),
  kind: OrgKindSchema,
  externalId: z.string().min(1),
  login: z.string().min(1),
  displayName: z.string().min(1),
  createdAt: z.date(),
  updatedAt: z.date()
});
export type Org = z.infer<typeof OrgSchema>;

export const UserSchema = z.object({
  id: z.string().min(1),
  provider: IdentityProviderIdSchema,
  providerSubject: z.string().min(1),
  login: z.string().nullable(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date()
});
export type User = z.infer<typeof UserSchema>;

export const SessionSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  csrfToken: z.string().min(1),
  expiresAt: z.date(),
  createdAt: z.date(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable()
});
export type Session = z.infer<typeof SessionSchema>;

export const ApiTokenSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  name: z.string().min(1),
  tokenHash: z.string().min(1),
  scopes: z.array(TokenScopeSchema),
  expiresAt: z.date().nullable(),
  lastUsedAt: z.date().nullable(),
  createdAt: z.date()
});
export type ApiToken = z.infer<typeof ApiTokenSchema>;

export const ActorContextSchema = z.object({
  userId: z.string().min(1),
  orgId: z.string().min(1).nullable(),
  projectId: z.string().min(1).nullable(),
  scopes: z.array(ActorScopeSchema),
  source: z.enum(["session", "api_token", "local_dev"])
});
export type ActorContext = z.infer<typeof ActorContextSchema>;

export const IdentityOrgClaimSchema = z.object({
  externalId: z.string().min(1),
  login: z.string().min(1),
  displayName: z.string().min(1),
  kind: OrgKindSchema.default("github_org")
});
export type IdentityOrgClaim = z.infer<typeof IdentityOrgClaimSchema>;

export const IdentityClaimsSchema = z.object({
  providerSubject: z.string().min(1),
  login: z.string().min(1).nullable(),
  email: z.string().min(1).nullable(),
  displayName: z.string().min(1).nullable(),
  orgs: z.array(IdentityOrgClaimSchema).default([])
});
export type IdentityClaims = z.infer<typeof IdentityClaimsSchema>;
