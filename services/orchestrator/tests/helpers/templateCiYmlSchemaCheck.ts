// Shared CiConfigV1 parse check for the template-fragment harnesses (task #80 —
// apex v62 halt regression). Both `templateFragmentIsolation.test.ts` (assertion
// (f)) and `templateFragmentMatrixCoverage.test.ts` (assertion #7) need the same
// "the composed `.tanren/ci.yml` parses against the runtime gate's schema" check;
// extracting it here avoids duplicating the wording + keeps both harnesses under
// the per-file max-lines lint.

import { resolveCiConfig } from "../../src/engine/ci/resolve.js";
import type { VirtualFileSystem } from "../../src/engine/templates/index.js";

/** Parse the composed `.tanren/ci.yml` against `CiConfigV1` — the exact parse the
 * runtime gate runs (workflow/gate/resolveGateConfig.ts → ci/resolve.ts). A
 * fragment that emits an unparseable shape fails the test instead of escaping into
 * a live run as the apex v62 halt did. Throws an `Error` whose message names the
 * caller's `label` (test combo slug, fragment id) so the failure points at the
 * specific entry that broke. */
export function assertComposedCiYmlParsesAsCiConfigV1(label: string, vfs: VirtualFileSystem): void {
  try {
    resolveCiConfig(vfs.read(".tanren/ci.yml"));
  } catch (cause) {
    throw new Error(
      `"${label}" composed .tanren/ci.yml that FAILED CiConfigV1.safeParse — ` +
        `the runtime gate would reject this at the tanren-ci-config validate step ` +
        `(apex v62 halt class). Error: ${String(cause)}`,
      { cause },
    );
  }
}
