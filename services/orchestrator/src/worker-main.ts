// The standalone run-executor worker entrypoint — the DATA
// PLANE container. It boots ONLY the worker loop in its own process: builds the
// runtime (`tanren_app`) + system (`tanren_system`) pools exactly like the API,
// claims jobs from `job_queue` (unchanged DB-CAS), and runs the
// plan→write→check→audit loop. No HTTP server. The control-plane API
// (`main.ts`) no longer runs the worker in-process by default; this container is
// the data plane.
//
// The split is configurable in layers: a bare process boundary (the worker
// holds the same DB + Vault access and claims directly from `job_queue`); mTLS
// routing of the claim + writes through a control-plane API (shrinking the data
// plane's DB surface); and per-run scoped credentials (the full de-privilege).
// See ROADMAP.md.
//
// Does NOT migrate: the API owns the migrate step (this container `depends_on`
// it in compose). SIGTERM/SIGINT graceful drain is installed by
// `startRunWorker` (inside `bootRunWorker`).

import { bootRunWorker } from "./engine/worker/index.js";
import { createLogger } from "./engine/observability/logger.js";

const log = createLogger("run-worker");

if (import.meta.url === `file://${process.argv[1]}`) {
  // `"standalone"` mode: the de-privileged data plane MUST claim + write over the
  // mTLS control plane. bootRunWorker fails loud if the mTLS claim endpoint /
  // remote-writes config is absent — never a silent revert to the direct DB path.
  await bootRunWorker("standalone");
  log.info("run-executor worker started (standalone data plane)");
}
