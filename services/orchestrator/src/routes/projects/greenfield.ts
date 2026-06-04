// GREENFIELD: the project-create path that needs NO existing repo. An end user
// posts `{ name, owner, greenfield: true, private?, defaultBranch?, description? }`
// (no repoUrl) and Tanren creates a brand-new GitHub repo under the org's GitHub
// App grant via the `VcsProvider.createRepository` seam, then binds a new project
// to the real new repoUrl. Extracted from `index.ts` so that file stays under the
// per-file line cap. Org-scoping is preserved: the token resolves against THIS
// org's App installation/credentials, and `createProject` persists the row under
// the org actor's RLS scope.

import type { Context } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import {
  RepositoryAlreadyExistsError,
  RepositoryCreationForbiddenError,
  type VcsProvider,
} from "../../engine/contracts/vcsProvider.js";
import {
  loadOrgDefaultGithubCredentialRef,
  loadOrgGithubAppInstallation,
} from "../../engine/credentials/orgGithubApp.js";
import type { GithubAppTokenMinter } from "../../engine/providers/githubAppTokenMinter.js";
import { ensureIssuesInboxSource } from "../../engine/forge/inbox/index.js";
import { createProject } from "../../engine/workflow/projectSpec.js";
import type { ActorContextEnv } from "../../middleware/auth.js";

/**
 * The greenfield create body: NO repoUrl. `owner` is the GitHub org/user login
 * that will OWN the new repo (the account the org's App is installed on).
 * `greenfield: true` is the explicit opt-in marker. `private` defaults to true
 * (greenfield products start private). `defaultBranch` (when given) is recorded
 * on the project row; the repo's own default branch is whatever `auto_init`
 * seeds. `runnerImage`/`allocator` are the usual optional project overrides.
 */
export const GreenfieldCreateSchema = z
  .object({
    name: z.string().min(1),
    owner: z.string().min(1),
    greenfield: z.literal(true),
    private: z.boolean().optional(),
    description: z.string().min(1).optional(),
    defaultBranch: z.string().min(1).optional(),
    runnerImage: z.string().min(1).optional(),
    allocator: z.string().min(1).optional(),
  })
  .strict();

export type GreenfieldCreateInput = z.infer<typeof GreenfieldCreateSchema>;

export interface GreenfieldCreateDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  githubAppMinter?: GithubAppTokenMinter;
  orgId: string;
  actor: ActorContext;
  input: GreenfieldCreateInput;
}

/**
 * Resolve the org's GitHub token (App-first, static fallback — the same policy
 * the brownfield link route uses), create the repo, then create the project
 * bound to the real new repoUrl. The typed repo-create errors map to clean
 * 409/403 responses; the token never appears in a response or a log.
 */
export async function handleGreenfieldCreate(
  c: Context<ActorContextEnv>,
  deps: GreenfieldCreateDeps,
): Promise<Response> {
  const { pool, secrets, vcsProvider, orgId, actor, input } = deps;

  let token;
  try {
    const installation = await loadOrgGithubAppInstallation(pool, orgId);
    const staticRef = await loadOrgDefaultGithubCredentialRef(pool, orgId);
    token = await vcsProvider.resolveToken({
      secrets,
      ...(installation === undefined ? {} : { installation }),
      ...(staticRef === undefined ? {} : { staticRef }),
      ...(deps.githubAppMinter === undefined ? {} : { minter: deps.githubAppMinter }),
    });
  } catch {
    // No App installation + no default credential ⇒ the org has no GitHub grant
    // to create a repo under. Same mapping the brownfield route uses.
    return c.json({ error: "github_credential_missing" }, 400);
  }

  let created;
  try {
    created = await vcsProvider.createRepository(
      {
        owner: input.owner,
        name: input.name,
        private: input.private ?? true,
        autoInit: true,
        ...(input.description === undefined ? {} : { description: input.description }),
      },
      token,
    );
  } catch (error) {
    if (error instanceof RepositoryAlreadyExistsError) {
      return c.json({ error: "repository_already_exists", owner: error.owner, name: error.repoName }, 409);
    }
    if (error instanceof RepositoryCreationForbiddenError) {
      // Surface the actionable permission gap as a clean 403 — the App
      // installation must be granted `administration: write` to create repos.
      return c.json(
        {
          error: "repository_creation_forbidden",
          owner: error.owner,
          message: error.message,
          requiredPermission: "administration:write",
        },
        403,
      );
    }
    throw error;
  }

  // Bind a new project to the REAL new repoUrl. createProject persists under the
  // org actor's RLS scope (it self-scopes on the actor's orgId).
  const scopedActor: ActorContext = { ...actor, orgId };
  const project = await createProject(
    pool,
    {
      name: input.name,
      repoUrl: created.repoUrl,
      defaultBranch: input.defaultBranch ?? created.defaultBranch,
      // GREENFIELD MARKER: this project has NO pre-existing repo/lockfile — Tanren
      // authors the toolchain live. Persisted so the run's in-loop deps-ensure uses
      // a NON-FROZEN install (a writer-added devDep without a regenerated lockfile
      // still installs), while brownfield keeps the frozen, lockfile-safe default.
      config: { version: 1, greenfield: true },
      ...(input.runnerImage === undefined ? {} : { runnerImage: input.runnerImage }),
      ...(input.allocator === undefined ? {} : { allocator: input.allocator }),
    },
    scopedActor,
  );

  // L2 (post-merge re-intake): provision the matching `issues` inbox source for the
  // new repo so post-merge auto-issues + user-filed reports are ingested by default.
  // Idempotent.
  const inbox = await ensureIssuesInboxSource({
    pool,
    orgId,
    projectId: project.projectId,
    repoUrl: created.repoUrl,
  });

  return c.json(
    {
      ...project,
      repository: { fullName: created.fullName, repoUrl: created.repoUrl },
      inboxSource: { id: inbox.source.id, created: inbox.created },
    },
    201,
  );
}
