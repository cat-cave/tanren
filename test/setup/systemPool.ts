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
// `resetSystemPool` after each test clears any per-test `setSystemPool` injection
// (and the env memo) so it never leaks across files.

import { afterEach, beforeAll } from "vitest";
import { allowRuntimePoolAsSystemForTests, resetSystemPool } from "@tanren/db";

beforeAll(() => {
  allowRuntimePoolAsSystemForTests(true);
});

afterEach(() => {
  resetSystemPool();
});
