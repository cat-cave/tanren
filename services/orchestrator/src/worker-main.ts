// Plane-split P1: the standalone run-executor worker entrypoint — the DATA
// PLANE container. It boots ONLY the worker loop in its own process: builds the
// runtime (`tanren_app`) + system (`tanren_system`) pools exactly like the API,
// claims jobs from `job_queue` (unchanged DB-CAS), and runs the
// plan→write→check→audit loop. No HTTP server. The control-plane API
// (`main.ts`) no longer runs the worker in-process by default; this container is
// the data plane.
//
// P1 is a PROCESS-BOUNDARY change only — no trust change. The worker still holds
// the same DB + Vault access the in-process worker did and claims directly from
// `job_queue`. P2 adds mTLS + routes the claim/writes through a control-plane
// API (shrinking the data plane's DB surface); P3 de-privileges to per-run
// scoped credentials. See docs/roadmap/saas-rls-and-plane-split-plan.md.
//
// Does NOT migrate: the API owns the migrate step (this container `depends_on`
// it in compose). SIGTERM/SIGINT graceful drain is installed by
// `startRunWorker` (inside `bootRunWorker`).

import { bootRunWorker } from "./engine/worker/index.js";

if (import.meta.url === `file://${process.argv[1]}`) {
  await bootRunWorker();
  console.log("run-executor worker started (standalone data plane)");
}
