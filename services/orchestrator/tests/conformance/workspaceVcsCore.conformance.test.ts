// Drives the WorkspaceVcsCore conformance suite (tanren-owns-the-engine.md §2)
// against the trivial in-memory reference fake, so the FIRST-CLASS-conflict
// behaviors are executable in Wave 0. Wave 1 adds a sibling driver pointing the
// SAME suite at the real jj impl (and the git fallback).

import { InMemoryWorkspaceVcsCore } from "./fakes/inMemoryWorkspaceVcsCore.js";
import { describeWorkspaceVcsCoreConformance } from "./workspaceVcsCoreConformance.js";

describeWorkspaceVcsCoreConformance("InMemoryWorkspaceVcsCore (reference fake)", {
  make: () => new InMemoryWorkspaceVcsCore(),
});
