// Credential-owner fixtures for the enforced-RLS run-lifecycle integration test.
// Keep ref construction, secret seeding, and org-scoped hydration together so the
// lifecycle test exercises the production boundaries without exceeding the test
// suite's dependency cap.

import type { Pool } from "pg";
import { runWithOrgScope } from "@tanren/db";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { storeGithubToken } from "../src/engine/credentials/githubToken.js";
import { deriveCredentialRef } from "../src/engine/credentials/refNamespace.js";
import { loadRunExecutionContext, type RunExecutionContext } from "../src/engine/worker/runExecutionContext.js";

export function lifecycleGithubCredentialRef(ownerId: string): string {
  return deriveCredentialRef({ kind: "github_token", scope: "org", ownerId, name: "dev" });
}

export async function seededLifecycleGithubSecrets(ref: string): Promise<FakeSecretStore> {
  const secrets = new FakeSecretStore();
  await storeGithubToken(secrets, { ref, token: "ghp_lifecycleToken" });
  return secrets;
}

export function loadLifecycleRunExecutionContext(
  pool: Pool,
  input: { orgId: string; runId: string; identitySecretRef: string },
): Promise<RunExecutionContext> {
  return runWithOrgScope(pool, input.orgId, (client) =>
    loadRunExecutionContext(client, {
      runId: input.runId,
      identitySecretRef: input.identitySecretRef,
    }),
  );
}
