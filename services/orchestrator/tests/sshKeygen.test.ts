import { utils as sshUtils } from "ssh2";
import { describe, expect, it } from "vitest";
import {
  buildKnownHostKeyCloudInit,
  generateEd25519KeyPair,
  hostKeyFingerprintFromPublicKey,
} from "../src/engine/ssh/keygen.js";
import { hostKeyFingerprintMatches, sshSha256Fingerprint } from "../src/engine/ssh/fingerprint.js";

describe("ssh keygen", () => {
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
});
