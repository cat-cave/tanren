import { describe, expect, it } from "vitest";
import { FragmentsStore, type RegisterFragmentInput } from "../src/engine/repositories/fragments.js";
import { fragmentEvidenceContentDigest } from "../src/engine/templates/fragments/fragmentEvidenceContract.js";

const ACTOR = { kind: "operator" as const };
const EVIDENCE_BASE = {
  schemaVersion: "fragment_evidence.v1" as const,
  junitReportPath: "reports/junit.xml",
  testSelector: { path: ".tanren/test-selector.json", format: "json" as const },
  behaviorManifest: { path: ".tanren/behavior-manifest.json", format: "json" as const },
};
const EVIDENCE = {
  ...EVIDENCE_BASE,
  contentDigest: fragmentEvidenceContentDigest({ ...EVIDENCE_BASE, contentDigest: `sha256:${"0".repeat(64)}` }),
};

interface StoredRow {
  fragment_id: string;
  org_id: string;
  kind: string;
  label: string;
  version: string;
  body_ts: string;
  contract: unknown;
  depends_on: unknown;
  status: string;
  created_at: Date;
  validated_at: Date | null;
}

class FragmentPersistenceClient {
  readonly stored: StoredRow[] = [];

  async query(sql: string, params: unknown[] = []) {
    const statement = sql.replaceAll(/\s+/gu, " ").trim();
    if (statement.startsWith("INSERT INTO fragments")) {
      const [fragmentId, orgId, kind, label, version, bodyTs, contract, dependsOn, status] = params;
      const row: StoredRow = {
        fragment_id: String(fragmentId),
        org_id: String(orgId),
        kind: String(kind),
        label: String(label),
        version: String(version),
        body_ts: String(bodyTs),
        contract: JSON.parse(String(contract)),
        depends_on: JSON.parse(String(dependsOn)),
        status: statement.includes("'validated'") ? "validated" : String(status),
        created_at: new Date("2026-01-01T00:00:00.000Z"),
        validated_at: statement.includes("'validated'") ? new Date("2026-01-01T00:00:00.000Z") : null,
      };
      this.stored.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (statement.startsWith("SELECT") && statement.includes("WHERE fragment_id = $1")) {
      const row = this.stored.find((candidate) => candidate.fragment_id === params[0]);
      return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
    }
    if (statement.startsWith("SELECT DISTINCT ON")) {
      const rows = this.stored.filter((row) => row.status === "validated");
      return { rows, rowCount: rows.length };
    }
    if (statement.startsWith("SELECT") && statement.includes("FROM fragments")) {
      return { rows: [...this.stored], rowCount: this.stored.length };
    }
    if (statement.startsWith("UPDATE fragments")) {
      const row = this.stored.find((candidate) => candidate.fragment_id === params[0]);
      if (row === undefined) return { rows: [], rowCount: 0 };
      row.status = "validated";
      row.validated_at = new Date("2026-01-02T00:00:00.000Z");
      return { rows: [row], rowCount: 1 };
    }
    if (statement.startsWith("DELETE FROM fragments")) {
      const index = this.stored.findIndex((row) => row.fragment_id === params[0]);
      if (index >= 0) this.stored.splice(index, 1);
      return { rows: [], rowCount: index >= 0 ? 1 : 0 };
    }
    throw new Error(`unexpected query: ${statement}`);
  }

  asClient() {
    return this as never;
  }
}

function fragmentInput(version = "1.0.0"): RegisterFragmentInput {
  return {
    orgId: "org_mq12",
    kind: "runtime",
    label: "custom",
    version,
    bodyTs: "export default {};",
    contract: { reportPath: "reports/junit.xml", evidence: EVIDENCE },
    dependsOn: ["base", 7 as never],
  };
}

describe("mq-12 fragment evidence persistence contract", () => {
  it("round-trips only a schema-valid frozen contract through create, validate, read, and delete", async () => {
    const client = new FragmentPersistenceClient();
    const created = await FragmentsStore.create(client.asClient(), fragmentInput(), ACTOR);
    expect(created).toMatchObject({
      fragmentId: "org_mq12:runtime-custom:1.0.0",
      contract: { evidence: EVIDENCE },
      dependsOn: ["base"],
      status: "draft",
    });

    const validated = await FragmentsStore.markValidated(client.asClient(), created.fragmentId, ACTOR);
    expect(validated.validatedAt).toEqual(new Date("2026-01-02T00:00:00.000Z"));
    expect((await FragmentsStore.get(client.asClient(), created.fragmentId, ACTOR))?.contract.evidence).toEqual(
      EVIDENCE,
    );
    expect(await FragmentsStore.get(client.asClient(), "missing", ACTOR)).toBeUndefined();
    expect((await FragmentsStore.list(client.asClient(), ACTOR)).map((row) => row.fragmentId)).toEqual([
      created.fragmentId,
    ]);
    expect((await FragmentsStore.listValidated(client.asClient(), ACTOR)).map((row) => row.fragmentId)).toEqual([
      created.fragmentId,
    ]);

    const second = await FragmentsStore.createValidated(client.asClient(), fragmentInput("2.0.0"), ACTOR);
    expect(second.status).toBe("validated");
    await FragmentsStore.deleteById(client.asClient(), second.fragmentId, ACTOR);
    expect(await FragmentsStore.get(client.asClient(), second.fragmentId, ACTOR)).toBeUndefined();
  });

  it("rejects a persisted stale contract instead of returning it to the fragment library", async () => {
    const client = new FragmentPersistenceClient();
    client.stored.push({
      fragment_id: "org_mq12:runtime-stale:1.0.0",
      org_id: "org_mq12",
      kind: "runtime",
      label: "stale",
      version: "1.0.0",
      body_ts: "export default {};",
      contract: {
        reportPath: "reports/junit.xml",
        evidence: { ...EVIDENCE, contentDigest: `sha256:${"f".repeat(64)}` },
      },
      depends_on: [],
      status: "validated",
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      validated_at: new Date("2026-01-01T00:00:00.000Z"),
    });

    await expect(FragmentsStore.get(client.asClient(), "org_mq12:runtime-stale:1.0.0", ACTOR)).rejects.toThrow(
      /immutable evidence content/u,
    );
  });
});
