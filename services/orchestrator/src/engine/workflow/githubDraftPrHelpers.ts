import { bindOrgGithubCredentialRefs, migrateOrgConfig, type OrgGithubAppInstallation } from "../config/orgConfig.js";
import { bindProjectGithubCredentialRefs, migrateProjectConfig } from "../config/projectConfig.js";

export function readGithubCredentialRef(config: unknown, orgId: string): string | undefined {
  return bindProjectGithubCredentialRefs(migrateProjectConfig(config), orgId).credentials?.githubCredentialRef;
}

export function readGithubInstallation(config: unknown, orgId: string): OrgGithubAppInstallation | undefined {
  if (config === null || config === undefined) return undefined;
  return bindOrgGithubCredentialRefs(migrateOrgConfig(config), orgId).github_app;
}

export function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
