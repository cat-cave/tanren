// The `issues` source-kind dispatcher.
//
// The connector map is keyed by `SourceKind`, so a single `issues` slot must
// serve every issue-tracker provider. This dispatcher reads `config.provider`
// and routes to the matching provider connector:
//
//   • `github` (the default when `provider` is absent) → the P3-0022 GitHub
//     Issues connector. Existing GitHub sources carry no `provider` field, so
//     they keep working unchanged.
//   • `linear` → the Linear GraphQL connector.
//   • `jira` → the Jira REST connector.
//
// Reusing the existing `issues` kind means no `SourceKind` enum value and no DB
// CHECK migration is added (the same no-migration move the Sentry connector
// made under `errors`). The factory in routes/inbox/index.ts builds this
// dispatcher with the provider connectors injected.

import { z } from "zod";
import type { IngestedItem, InboxSource, SourceConnector } from "./types.js";

// Just enough of the config to pick a provider; each provider connector
// validates the rest of the shape itself.
const ProviderProbe = z.object({ provider: z.enum(["github", "linear", "jira"]).default("github") }).passthrough();

export interface IssuesConnectorDeps {
  github: SourceConnector;
  linear: SourceConnector;
  jira: SourceConnector;
}

export function createIssuesConnector(deps: IssuesConnectorDeps): SourceConnector {
  return {
    kind: "issues",
    async fetch(source: InboxSource): Promise<IngestedItem[]> {
      const { provider } = ProviderProbe.parse(source.config);
      if (provider === "linear") return deps.linear.fetch(source);
      if (provider === "jira") return deps.jira.fetch(source);
      return deps.github.fetch(source);
    },
  };
}
