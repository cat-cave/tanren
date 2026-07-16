import type pg from "pg";
import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { DeployOnMergeWatcher } from "../src/engine/postMerge/deployOnMerge.js";
import type { DeployHttpTransport } from "../src/engine/provisioners/deployTransport.js";

const RUN_ID = "run_lineage_a";
const ORG_A = "org_lineage_a";
const ORG_B = "org_lineage_b";
const PROJECT_B = "project_lineage_b";
const SPEC_B = "spec_lineage_b";

interface DownstreamReads {
  config: number;
  authority: number;
  environment: number;
}

function malformedOwnerPool(reads: DownstreamReads): pg.Pool {
  const query = async (sql: string, params: readonly unknown[] = []) => {
    const text = sql.trim();
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SET )/u.test(text)) return { rows: [], rowCount: 0 };
    if (/FROM events e/u.test(sql) && params[1] === "merge.completed") {
      return {
        rows: [
          {
            event_run_id: RUN_ID,
            event_spec_id: SPEC_B,
            event_project_id: PROJECT_B,
            event_org_id: ORG_A,
            payload: { prNumber: 9, mergeSha: "a".repeat(40) },
            run_id: RUN_ID,
            run_spec_id: SPEC_B,
            run_project_id: PROJECT_B,
            run_org_id: ORG_A,
            pr_url: "https://github.com/acme/widget/pull/9",
            // Crafted owner-bypass history: the run names tenant B's project/spec
            // while carrying tenant A's org. The production reader must catch it.
            project_org_id: ORG_B,
            spec_org_id: ORG_B,
            spec_project_id: PROJECT_B,
          },
        ],
        rowCount: 1,
      };
    }
    if (/SELECT config, org_id FROM projects/u.test(sql)) reads.config += 1;
    if (/org_integration_(?:connections|grants)/u.test(sql)) reads.authority += 1;
    if (/FROM project_app_env/u.test(sql)) reads.environment += 1;
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release: () => {} };
  return { query, connect: async () => client } as unknown as pg.Pool;
}

class RecordingSecrets extends InMemorySecretStore {
  reads = 0;
  override async get(ref: string) {
    this.reads += 1;
    return super.get(ref);
  }
}

describe("deploy-on-merge cross-tenant production seam", () => {
  it("rejects malformed owner lineage before config, authority, secrets, env, or provider I/O", async () => {
    const reads: DownstreamReads = { config: 0, authority: 0, environment: 0 };
    const secrets = new RecordingSecrets();
    let providerCalls = 0;
    const transport: DeployHttpTransport = {
      async request() {
        providerCalls += 1;
        return { status: 500, ok: false, json: {}, text: "must not be reached" };
      },
    };
    const watcher = new DeployOnMergeWatcher({ pool: malformedOwnerPool(reads), secrets, transport });

    await expect(watcher.check(RUN_ID)).rejects.toThrow(/run lineage mismatch.*does not own its project/u);
    expect(reads).toEqual({ config: 0, authority: 0, environment: 0 });
    expect(secrets.reads).toBe(0);
    expect(providerCalls).toBe(0);
  });
});
