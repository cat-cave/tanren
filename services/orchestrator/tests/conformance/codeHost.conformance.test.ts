// Drives the CodeHost conformance suite (tanren-owns-the-engine.md §6) against the
// trivial in-memory reference fake. Wave 1 adds a sibling driver pointing the SAME
// suite at the real GitHub CodeHost impl.

import { InMemoryCodeHost } from "./fakes/inMemoryCodeHost.js";
import { describeCodeHostConformance } from "./codeHostConformance.js";

describeCodeHostConformance("InMemoryCodeHost (reference fake)", {
  make: () => new InMemoryCodeHost(),
  seed: (host, repo, defaultBranch, initialSha) => {
    (host as InMemoryCodeHost).seed(repo, defaultBranch, initialSha);
  },
  seedCommit: (host, repo, sha, parents, author) => {
    (host as InMemoryCodeHost).seedCommit(repo, sha, parents, author);
  },
  seedContent: (host, repo) => {
    (host as InMemoryCodeHost).seedContent(repo);
  },
});
