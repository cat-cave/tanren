// Per-implementation invocations of the CommandSubstrate conformance suite.
// Both the in-memory FakeCommandSubstrate and the real SshCommandSubstrate run
// through the SAME behavior spec. The SSH impl is driven with an empty secret
// store so its `run()` reports a transport failure IN-BAND (missing identity →
// `ssh_failed` on the result) — exactly the failure-as-result contract the seam
// promises. A native-exec backend gets coverage by adding one harness block.
import { FakeCommandSubstrate } from "../../src/engine/contracts/commandSubstrate.js";
import { FakeSecretStore } from "../../src/engine/contracts/secretStore.js";
import { SshCommandSubstrate } from "../../src/engine/ssh/index.js";
import {
  describeCommandSubstrateConformance,
  describeCommandSubstrateFailureConformance,
  fakeSshHandle,
} from "./commandSubstrateConformance.js";

// The fake: always a well-formed success; no failure mode.
describeCommandSubstrateConformance("FakeCommandSubstrate", {
  make: () => new FakeCommandSubstrate(),
  handle: () => fakeSshHandle(),
});

// The real SSH impl. With an EMPTY secret store the identity lookup misses, so
// run() returns an in-band `ssh_failed` result (never a throw) — which is both
// the well-formed-result case AND the failure-in-band case for this impl.
describeCommandSubstrateConformance("SshCommandSubstrate (no identity)", {
  make: () => new SshCommandSubstrate(new FakeSecretStore()),
  handle: () => fakeSshHandle(),
});

describeCommandSubstrateFailureConformance("SshCommandSubstrate (no identity)", {
  makeFailing: () => ({ substrate: new SshCommandSubstrate(new FakeSecretStore()), handle: fakeSshHandle() }),
});
