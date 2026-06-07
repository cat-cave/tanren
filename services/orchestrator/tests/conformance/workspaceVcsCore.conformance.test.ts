// Drives the WorkspaceVcsCore conformance suite (tanren-owns-the-engine.md §2)
// against the trivial in-memory reference fake, so the FIRST-CLASS-conflict
// behaviors are executable without jj installed. The sibling
// `workspaceVcsCore.jj.conformance.test.ts` points the SAME suite at the real jj impl
// (the sole production backend).

import { InMemoryWorkspaceVcsCore } from "./fakes/inMemoryWorkspaceVcsCore.js";
import { describeWorkspaceVcsCoreConformance } from "./workspaceVcsCoreConformance.js";

describeWorkspaceVcsCoreConformance("InMemoryWorkspaceVcsCore (reference fake)", {
  make: () => new InMemoryWorkspaceVcsCore(),
});
