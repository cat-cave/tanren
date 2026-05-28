// P2A-0015: `just acceptance-medium` — medium-tier acceptance gate.
//
// Per the P2A-0015 spec: the medium tier exercises Phase 2A's planner
// feedback loops (≥ 2 subtasks + at least one checker-rejection loop) and
// asserts the planner cost record landed alongside writer/check/audit.
//
// SHIP STATUS: stub-with-validation. The medium fixture repo content under
// `fixtures/acceptance-medium/` is committed, and the env-validation +
// assertion pipeline is wired through `common.ts`. The remaining piece is
// the live runner against a pre-created `cat-cave/tanren-fixture-medium`
// GitHub repo that the operator must initialize first (see
// docs/operator-guide/acceptance.md). Until that operator-setup step is
// documented and lived-proved, this command validates the env, prints the
// pending notice, and exits 0 so `just acceptance` doesn't block local
// release work.
//
// The pending behavior is intentional: the easy tier is the v0 release
// gate per the spec ("The easy tier MUST work end-to-end though"); medium
// arrives in a follow-up commit that wires the live live planner-loop
// path. The dry-run smoke test in `phase2AcceptanceMedium.test.ts`
// exercises the persisted-state assertions against synthetic data so the
// criteria are gated by CI even while the live runner is pending.

import { exit } from "node:process";
import { AcceptanceEnvError, loadAcceptanceEnv } from "./common.js";

const PENDING_MESSAGE = [
  "tanren acceptance-medium: fixture-medium live runner pending",
  "",
  "The medium-tier live runner depends on operator-setup of a fresh",
  "cat-cave/tanren-fixture-medium GitHub repo (the empty initial commit +",
  "src/status.ts, tests/status.test.ts, README.md, package.json scaffold).",
  "See docs/operator-guide/acceptance.md for the setup steps.",
  "",
  "Until the live runner ships, this command:",
  "  - validates the acceptance env vars (so `just acceptance` fails fast",
  "    when credentials are missing)",
  "  - prints this notice",
  "  - exits 0 so the gate does not block local release work",
  "",
  "The persisted-state assertions (≥ 2 write tasks, ≥ 1 planner.rerequested",
  "event, planner+writer+checker+auditor cost records) live in",
  "scripts/acceptance/common.ts and are gated in CI by",
  "services/orchestrator/tests/phase2AcceptanceMedium.test.ts which runs",
  "against synthetic completed-run data."
].join("\n");

async function main(): Promise<void> {
  // Env validation runs even in pending mode so `just acceptance` fails
  // fast at the medium step when the operator forgot a credential — the
  // operator gets the same error they would for the easy tier.
  loadAcceptanceEnv();
  process.stdout.write(`${PENDING_MESSAGE}\n`);
}

main().catch((error) => {
  if (error instanceof AcceptanceEnvError) {
    process.stderr.write(`acceptance-medium env error: ${error.message}\n`);
    exit(2);
  }
  process.stderr.write(`acceptance-medium crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  exit(3);
});
