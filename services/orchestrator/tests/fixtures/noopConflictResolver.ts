// TEST FIXTURE ONLY (P8a §8a). The no-op conflict resolver was the TEMPORARY
// production default through; replaced it with the real
// `intentPreservingConflictResolver` and moved this here. It now lives ONLY
// under tests/ — the `no-production-stubs` lint forbids it (or any stub) in
// production src/. Tests that exercise the merge stage WITHOUT a real resolver
// (e.g. asserting the dispatcher's plain merge/queue/handoff paths, where no
// conflict arises) inject this so the required `resolveConflict` hook is
// satisfied with a deterministic "resolves nothing" stand-in.

import type { ConflictResolverHook } from "../../src/engine/workflow/reviewMerge/index.js";

/** A conflict resolver that records nothing and resolves nothing (test seam). */
export const noopConflictResolver: ConflictResolverHook = async () => ({ resolved: false });
