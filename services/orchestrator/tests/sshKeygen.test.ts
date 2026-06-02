import { utils as sshUtils } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildKnownHostKeyCloudInit,
  generateEd25519KeyPair,
  hostKeyFingerprintFromPublicKey,
} from "../src/engine/ssh/keygen.js";
import { hostKeyFingerprintMatches, sshSha256Fingerprint } from "../src/engine/ssh/fingerprint.js";

// A real well-formed ed25519 keypair captured once (via the real generator with
// the spy not yet installed) so the retry tests have a known-GOOD value to feed
// back after the simulated malformed ones.
const GOOD = sshUtils.generateKeyPairSync("ed25519");
// A malformed public key: `parseKey` rejects it, exactly as the ssh2 length-
// prefix bug's output does, so the generator's round-trip validation fails.
const MALFORMED = { public: "ssh-ed25519 not-base64!!!", private: GOOD.private };

describe("ssh keygen", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates a real ed25519 OpenSSH keypair", () => {
    const { privateKey, publicKey } = generateEd25519KeyPair();
    expect(privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(publicKey.startsWith("ssh-ed25519 ")).toBe(true);
    // Distinct keys each call (per-run de-privileging).
    expect(generateEd25519KeyPair().publicKey).not.toBe(publicKey);
  });

  it("computes the SAME host-key fingerprint the ssh2 hostVerifier will see", () => {
    const { publicKey } = generateEd25519KeyPair();
    const pinned = hostKeyFingerprintFromPublicKey(publicKey);
    // ssh2's hostVerifier is handed `sha256(getPublicSSH())`; reproduce it and
    // confirm the pinned value matches — this is the basis for verification.
    const parsed = sshUtils.parseKey(publicKey);
    if (parsed instanceof Error) {
      throw parsed;
    }
    // ssh2 hands the verifier `sshSha256Fingerprint(getPublicSSH())`; the pinned
    // value is derived the same way, so verification matches.
    const verifierInput = sshSha256Fingerprint(parsed.getPublicSSH());
    expect(hostKeyFingerprintMatches(verifierInput, pinned)).toBe(true);
  });

  it("rejects a fingerprint derived from a DIFFERENT host key (no false match)", () => {
    const a = hostKeyFingerprintFromPublicKey(generateEd25519KeyPair().publicKey);
    const b = hostKeyFingerprintFromPublicKey(generateEd25519KeyPair().publicKey);
    expect(a).not.toBe(b);
    expect(hostKeyFingerprintMatches(a, b)).toBe(false);
  });

  it("throws on an unparseable public key rather than pinning a bogus value", () => {
    expect(() => hostKeyFingerprintFromPublicKey("not-a-key")).toThrow(/could not parse host public key/u);
  });

  it("builds a cloud-init that installs the host key and restarts sshd", () => {
    const { privateKey } = generateEd25519KeyPair();
    const cloudInit = buildKnownHostKeyCloudInit(privateKey);
    expect(cloudInit.startsWith("#cloud-config")).toBe(true);
    expect(cloudInit).toContain("/etc/ssh/ssh_host_ed25519_key");
    expect(cloudInit).toContain("systemctl restart ssh");
    // The private key body is indented under the YAML block scalar.
    expect(cloudInit).toContain("      -----BEGIN OPENSSH PRIVATE KEY-----");
  });

  it("merges operator-supplied extra write_files into the host-key cloud-init", () => {
    const { privateKey } = generateEd25519KeyPair();
    const extra = "  - path: /etc/tanren/marker\n    content: hello";
    const cloudInit = buildKnownHostKeyCloudInit(privateKey, extra);
    expect(cloudInit).toContain("/etc/tanren/marker");
    expect(cloudInit).toContain("/etc/ssh/ssh_host_ed25519_key");
  });

  // Root-cause regression: ssh2@1.17.0 intermittently emits a malformed public
  // key. The generator must VALIDATE the parse→getPublicSSH round-trip and
  // REGENERATE, so a transient bad key is recovered and never escapes.
  it("retries past a transient malformed key and returns a well-formed one", () => {
    const spy = vi
      .spyOn(sshUtils, "generateKeyPairSync")
      .mockReturnValueOnce(MALFORMED as never)
      .mockReturnValueOnce(MALFORMED as never)
      .mockReturnValueOnce(GOOD as never);

    const { publicKey } = generateEd25519KeyPair();

    // Two bad attempts, then the good one.
    expect(spy).toHaveBeenCalledTimes(3);
    expect(publicKey).toBe(GOOD.public);
    // The returned key round-trips (the fingerprint + Hetzner upload depend on it).
    expect(() => hostKeyFingerprintFromPublicKey(publicKey)).not.toThrow();
  });

  it("throws a clear error if every attempt is malformed (retry exhausted)", () => {
    const spy = vi.spyOn(sshUtils, "generateKeyPairSync").mockReturnValue(MALFORMED as never);
    expect(() => generateEd25519KeyPair()).toThrow(/failed to generate a well-formed ed25519 keypair/u);
    // Bounded retry — it does not spin forever.
    expect(spy.mock.calls.length).toBe(8);
  });

  // The real ssh2 bug is a key where `parseKey` SUCCEEDS but the subsequent
  // `getPublicSSH()` re-encode throws (the broken length prefix surfaces there).
  // The generator's round-trip validation must catch THAT branch too.
  it("regenerates when parseKey succeeds but getPublicSSH() throws", () => {
    vi.spyOn(sshUtils, "generateKeyPairSync")
      .mockReturnValueOnce({ public: "bug", private: GOOD.private } as never)
      .mockReturnValueOnce(GOOD as never);
    // First returned key: parseKey "succeeds" but getPublicSSH throws.
    const parseSpy = vi.spyOn(sshUtils, "parseKey");
    parseSpy.mockImplementationOnce(
      () =>
        ({
          getPublicSSH: () => {
            throw new Error("Malformed OpenSSH public key");
          },
        }) as never,
    );
    // Subsequent calls (validation of GOOD, plus the test's own assertion) use
    // the real parser.
    const { publicKey } = generateEd25519KeyPair();
    expect(publicKey).toBe(GOOD.public);
  });
});
