// A TEST FIXTURE (tests/ only) IntegrationProvisioner shaped like the Sentry
// provisioner: provision writes a DSN VALUE into the injected SecretStore and the
// artifact carries only its REF (never the value) + an inbox_source, so the engine
// test can assert the secret-ref-only discipline + the inbox-source persistence.
// Records its create/bind calls for the test to inspect. Never reaches a
// production src/ path.

import type { SecretStore } from "../../src/engine/contracts/secretStore.js";
import type {
  CapabilityId,
  ExistingResource,
  IntegrationProvisioner,
  OrgGrant,
  ProjectContext,
  ProvisionedArtifact,
} from "../../src/engine/contracts/integrationProvisioner.js";

export class FakeSentryProvisioner implements IntegrationProvisioner {
  existing: ExistingResource[] = [];
  readonly created: string[] = [];
  readonly bound: string[] = [];

  constructor(private readonly secrets: SecretStore) {}

  capability(): CapabilityId[] {
    return ["errors"];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async discover(_grant: OrgGrant): Promise<ExistingResource[]> {
    return [...this.existing];
  }

  async provision(_grant: OrgGrant, projectCtx: ProjectContext): Promise<ProvisionedArtifact> {
    const slug = projectCtx.name ?? projectCtx.projectId;
    this.created.push(slug);
    return this.artifactFor(slug, projectCtx);
  }

  async bind(_grant: OrgGrant, existingResourceId: string, projectCtx: ProjectContext): Promise<ProvisionedArtifact> {
    this.bound.push(existingResourceId);
    return this.artifactFor(existingResourceId, projectCtx);
  }

  private async artifactFor(slug: string, projectCtx: ProjectContext): Promise<ProvisionedArtifact> {
    const ref = `org/${projectCtx.orgId}/sentry/${slug}/dsn`;
    // The DSN VALUE lives ONLY in the secret store — never the artifact.
    await this.secrets.put({ ref, value: `https://public@o0.ingest.sentry.io/${slug}` });
    return {
      projectConfig: { sentryProjectSlug: slug },
      secretRefs: { SENTRY_DSN: ref },
      // `errors` mirrors the real SentryProvisioner: the DB-allowed (kind CHECK) +
      // connector-registered kind for Sentry intake (a "sentry" kind violates both).
      inboxSource: { kind: "errors", config: { org: "acme", project: slug } },
    };
  }
}
