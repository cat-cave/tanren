// Per-implementation invocations of the VaultTokenMinter conformance suite. Both
// the real VaultRunTokenMinter (driven by an in-memory recording Vault fetch) and
// the in-memory FakeVaultTokenMinter are run through the SAME behavior spec, so
// the contract — not one implementation — is validated. A future minter (e.g. a
// Rust impl via its test shim) gets coverage by adding one harness here.
import { VaultRunTokenMinter } from "../../src/engine/contracts/vaultTokenMinterImpl.js";
import type { VaultTokenMinter } from "../../src/engine/contracts/vaultTokenMinter.js";
import { FakeVaultTokenMinter } from "./fakes/fakeVaultTokenMinter.js";
import { vaultTokenFetch } from "./fakes/vaultTokenFetch.js";
import { describeVaultTokenMinterConformance } from "./vaultTokenMinterConformance.js";

describeVaultTokenMinterConformance("FakeVaultTokenMinter", {
  make: (): VaultTokenMinter => new FakeVaultTokenMinter(),
});

describeVaultTokenMinterConformance("VaultRunTokenMinter (mocked Vault)", {
  make: (): VaultTokenMinter =>
    new VaultRunTokenMinter({
      addr: "http://vault:8200",
      token: "broad-test-token",
      fetchImpl: vaultTokenFetch().fetch,
    }),
});
