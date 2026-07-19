// rv-24 — `tanren proof verify <bundle>`: an OFFLINE verifier for an exported
// `tanren-proof-bundle.v1` file. It reads the bundle from disk, recomputes the integrity
// hash-chain from the bundle's own contents (never phoning home, never trusting a stored
// hash), re-checks the domain invariants, and self-verifies each embedded resolution
// proof. Prints the JSON verdict and exits non-zero when the bundle is invalid, so the
// proof is portable and independently checkable — not trust-the-server.

import { readFile } from "node:fs/promises";
import { optional, parseArgs } from "../args.js";
import { verifyBundleDocument, type BundleVerifyResult } from "./verifyBundle.js";

/** Parse + verify a bundle file; returns the structured result (no process exit). */
export async function verifyBundleFile(path: string): Promise<BundleVerifyResult> {
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      valid: false,
      structuralError: `bundle is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      divergedAt: null,
      storedBundleHash: null,
      recomputedBundleHash: null,
      invariantViolations: [],
      resolutionProofs: [],
    };
  }
  return verifyBundleDocument(parsed);
}

export async function proofVerify(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const path = optional(args, "bundle") ?? args._[0];
  if (path === undefined) {
    throw new Error("usage: tanren proof verify <bundle.json> (or --bundle <path>)");
  }
  const result = await verifyBundleFile(path);
  console.log(JSON.stringify({ bundle: path, ...result }, null, 2));
  if (!result.valid) process.exit(1);
}
