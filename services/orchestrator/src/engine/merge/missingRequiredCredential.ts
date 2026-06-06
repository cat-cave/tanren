import {
  MissingGithubCredentialRefError,
  NoGithubCredentialConfiguredError,
} from "../credentials/githubTokenResolver.js";
import { MissingCredentialError } from "../credentials/resolveCredentials.js";

export function isMissingRequiredCredentialError(error: unknown): boolean {
  if (
    error instanceof MissingGithubCredentialRefError ||
    error instanceof NoGithubCredentialConfiguredError ||
    error instanceof MissingCredentialError
  ) {
    return true;
  }
  if (!(error instanceof Error)) return false;
  return error.message.startsWith("missing GitHub App credential ref:");
}

export function missingRequiredCredentialMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
