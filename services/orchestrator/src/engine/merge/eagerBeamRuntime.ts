import type pg from "pg";
import type { Allocator } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { GithubAppTokenMinter, GitHubHttpClient } from "../providers/github.js";

/** Runtime seams shared by EAGER fact gathering, workspace construction, and proof staging. */
export interface EagerBeamRuntimeDeps {
  readonly pool: pg.Pool;
  readonly secrets: SecretStore;
  readonly githubHttp: GitHubHttpClient;
  readonly allocator: Allocator;
  readonly ssh: CommandSubstrate;
  readonly identitySecretRef: string;
  readonly githubAppMinter?: GithubAppTokenMinter;
}
