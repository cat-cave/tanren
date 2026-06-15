// Global test setup (vitest `setupFiles`).
//
// `runWithSystemScope` now FAILS LOUD when no system pool is configured — the
// system-vs-tenant split must never silently collapse onto the tenant runtime
// pool (db/src/orgScope.ts). Most unit tests drive a system-scoped path against an
// in-memory fake pool that ignores RLS, where the BYPASSRLS-vs-app distinction is
// moot. We opt the whole unit suite into "use the passed pool for system scope"
// ONCE here (never in production wiring). RLS integration tests that exercise the
// real split inject a real BYPASSRLS pool via `setSystemPool` (which takes
// precedence), and the fail-loud unit test toggles the opt-in off around itself.
//
// `resetSystemPool` runs per FILE (`afterAll`), not per test: the common RLS
// integration pattern injects a real BYPASSRLS pool ONCE in the file's `beforeAll`,
// and that injection must survive every test in the file (a per-test wipe would
// drop later tests back onto the RLS-denied tenant pool → 403 / zero-row failures).
// The reset still fires at file boundary so a per-file `setSystemPool` injection (or
// the env memo) never leaks across files. A test that deliberately needs a clean
// no-pool state mid-file (e.g. runWithSystemScopeFailClosed.test.ts) drives its own
// `resetSystemPool()` / `allowRuntimePoolAsSystemForTests(false)` explicitly.

import { afterAll, beforeAll, beforeEach } from "vitest";
import { allowRuntimePoolAsSystemForTests, resetSystemPool } from "@tanren/db";
import { sharedMainHeadCache } from "../../services/orchestrator/src/engine/providers/mainHeadCache.js";

beforeAll(() => {
  allowRuntimePoolAsSystemForTests(true);
});

// apex-v35: the GitHub default-branch head cache is a PROCESS-shared singleton (so the
// batch/percolation/post-merge readers in one worker collapse their redundant `main`-head
// reads). In tests many cases reuse the same `owner/name/main` key with DIFFERENT expected
// shas; clear the shared cache before each so a prior case's cached head never leaks into
// the next (matching the systemPool isolation rationale). Production never clears it — the
// short TTL + the landAuthorizedRef CAS guard freshness there.
beforeEach(() => {
  sharedMainHeadCache.clear();
});

afterAll(() => {
  resetSystemPool();
});
