// rv-24 — the OFFLINE proof-bundle verifier. The fixture `proofBundle.valid.json` was
// produced by the orchestrator's `buildProofBundle`, so a passing verify here PINS the
// CLI's independent chain re-implementation to the real builder (any drift breaks the
// recomputed hash). Every check runs against a file on disk — no DB, no network.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyBundleFile } from "../src/commands/proof/index.js";
import { verifyBundleDocument } from "../src/commands/proof/verifyBundle.js";

const HERE = import.meta.dirname;
const FIXTURE = join(HERE, "fixtures", "proofBundle.valid.json");

describe("tanren proof verify — offline bundle verification", () => {
  let dir = "";
  let good: Record<string, unknown>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tanren-proof-"));
    good = JSON.parse(await readFile(FIXTURE, "utf8")) as Record<string, unknown>;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeBundle(name: string, doc: unknown): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, JSON.stringify(doc));
    return path;
  }

  it("verifies a genuine orchestrator-built bundle from disk (pins the CLI recompute to the builder)", async () => {
    const result = await verifyBundleFile(FIXTURE);
    expect(result.valid).toBe(true);
    expect(result.structuralError).toBeNull();
    expect(result.recomputedBundleHash).toBe(result.storedBundleHash);
    expect(result.resolutionProofs.every((c) => c.valid)).toBe(true);
  });

  it("DECISIVE: editing a verdict outcome (chain not rebuilt) → INVALID on disk", async () => {
    const evidence = good["evidence"] as { verdicts: { outcome: string }[] };
    evidence.verdicts[0].outcome = "failed_product";
    const result = await verifyBundleFile(await writeBundle("tampered.json", good));
    expect(result.valid).toBe(false);
    expect(result.divergedAt).toBe("verdicts");
  });

  it("DECISIVE: editing an executed count (chain not rebuilt) → INVALID on disk", async () => {
    const evidence = good["evidence"] as { verdicts: { executedAssertionCount: number }[] };
    evidence.verdicts[0].executedAssertionCount = 1;
    const result = await verifyBundleFile(await writeBundle("tampered-count.json", good));
    expect(result.valid).toBe(false);
    expect(result.divergedAt).toBe("verdicts");
  });

  it("does NOT trust a stored valid claim — swapping the top bundleHash is caught", async () => {
    good["bundleHash"] = `sha256:${"e".repeat(64)}`;
    const result = await verifyBundleFile(await writeBundle("bad-hash.json", good));
    expect(result.valid).toBe(false);
  });

  it("rejects a non-bundle document with a structural error, never a crash", async () => {
    const result = await verifyBundleFile(await writeBundle("junk.json", { hello: "world" }));
    expect(result.valid).toBe(false);
    expect(result.structuralError).toMatch(/unexpected bundle version/u);
  });

  it("the invariant recheck holds even when a document is hand-crafted to skip the chain", () => {
    // A bundle whose entries+bundleHash are absent still cannot pass: no stored hash to match.
    const result = verifyBundleDocument({
      version: "tanren-proof-bundle.v1",
      evidence: {
        run: { runId: "r" },
        verdicts: [{ verdictId: "v", outcome: "passed", requiredAssertionCount: 3, executedAssertionCount: 3 }],
        resolutionProofs: [],
      },
    });
    expect(result.valid).toBe(false);
  });
});
