import { utils as sshUtils } from "ssh2";
import { sshSha256Fingerprint } from "./fingerprint.js";

/**
 * An ephemeral SSH keypair Tanren generates for a single allocation. The
 * `privateKey` is OpenSSH-format PEM (never logged / never written to config —
 * it goes straight into the secret manager); `publicKey` is the single-line
 * `ssh-<type> AAAA...` authorized-keys form that gets uploaded to the cloud
 * provider's key store and/or baked as a known host key.
 */
export interface EphemeralKeyPair {
  privateKey: string;
  publicKey: string;
}

/**
 * Generates a fresh ed25519 keypair. ed25519 is small, fast, and universally
 * accepted by the cloud providers' SSH-key APIs and by sshd as a host key.
 *
 * Injectable so allocators take it as a constructor dependency and tests can
 * supply a deterministic fake — the real generator is non-deterministic by
 * design (every allocation gets a unique key).
 */
export type KeyPairGenerator = () => EphemeralKeyPair;

/** Production keypair generator backed by ssh2's native keygen. */
export const generateEd25519KeyPair: KeyPairGenerator = () => {
  const { private: privateKey, public: publicKey } = sshUtils.generateKeyPairSync("ed25519");
  return { privateKey, publicKey };
};

/**
 * Computes the SHA256 host-key fingerprint that the SSH substrate's
 * `hostVerifier` will see for a server whose host key is `publicKey` (the
 * single-line `ssh-<type> AAAA...` form). This lets an allocator that injects a
 * known host key at create time pin the EXACT fingerprint locally — no
 * pre-known fingerprint config, no TOFU. Throws if the public key can't be
 * parsed (a programming error — the key we generated must parse).
 */
export function hostKeyFingerprintFromPublicKey(publicKey: string): string {
  const parsed = sshUtils.parseKey(publicKey);
  if (parsed instanceof Error) {
    throw new TypeError(`could not parse host public key to pin its fingerprint: ${parsed.message}`);
  }
  // ssh2's hostVerifier hashes the raw public-SSH wire blob; match that exactly
  // so the pinned value equals what verification will compare against.
  return sshSha256Fingerprint(parsed.getPublicSSH());
}

/**
 * Builds a cloud-init `#cloud-config` document that installs `hostPrivateKey`
 * as the server's ed25519 host key and restarts sshd so the server presents it
 * on the very first connection. The matching public key's fingerprint is what
 * the allocator pins — so the host key the server presents is deterministic and
 * verifiable without any pre-known fingerprint and without TOFU.
 *
 * The host private key is written with `0600` perms by sshd convention; it is
 * cloud-init user-data (which is itself sensitive) and is never logged. An
 * optional `extraUserData` block (the operator's own cloud-init body, minus its
 * `#cloud-config` header) is merged in so this composes with existing bootstrap.
 */
export function buildKnownHostKeyCloudInit(hostPrivateKey: string, extraWriteFiles?: string): string {
  // Indent the PEM under YAML block scalar (`|`) so multi-line content is valid.
  const indentedKey = hostPrivateKey
    .replace(/\r?\n$/u, "")
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");
  const lines = [
    "#cloud-config",
    "write_files:",
    "  - path: /etc/ssh/ssh_host_ed25519_key",
    "    permissions: '0600'",
    "    owner: root:root",
    "    content: |",
    indentedKey,
  ];
  if (extraWriteFiles !== undefined && extraWriteFiles.trim() !== "") {
    lines.push(extraWriteFiles.replace(/\r?\n$/u, ""));
  }
  // Regenerate the matching public key from the private key, then restart sshd
  // so it loads the injected host key before the runner ever connects.
  lines.push(
    "runcmd:",
    "  - rm -f /etc/ssh/ssh_host_ed25519_key.pub",
    "  - ssh-keygen -y -f /etc/ssh/ssh_host_ed25519_key > /etc/ssh/ssh_host_ed25519_key.pub",
    "  - systemctl restart ssh || systemctl restart sshd",
  );
  return `${lines.join("\n")}\n`;
}
