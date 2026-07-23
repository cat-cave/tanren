import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { eventTypesSeed } from "../src/eventTypesSeed.js";
import { integrationNodes, integrationProofs, mergeEagerBeams } from "../src/schema.js";

describe("mq-8 eager beam database contract", () => {
  it("exports an RLS-protected beam table with exact frontier and plan coordinates", () => {
    const config = getTableConfig(mergeEagerBeams);

    expect(config.name).toBe("merge_eager_beams");
    expect(config.enableRLS).toBe(true);
    expect(config.columns.map((column) => column.name)).toEqual([
      "org_id",
      "id",
      "project_id",
      "frontier_run_id",
      "frontier_spec_id",
      "plan_digest",
      "integration_node_id",
      "rank",
      "generation",
      "state",
      "stale_reason",
      "created_at",
      "updated_at",
    ]);
    expect(config.foreignKeys.map((key) => key.getName()).sort()).toEqual([
      "merge_eager_beams_frontier_run_fk",
      "merge_eager_beams_frontier_spec_fk",
      "merge_eager_beams_integration_node_fk",
      "merge_eager_beams_org_id_organizations_id_fk",
      "merge_eager_beams_plan_cas_fk",
      "merge_eager_beams_project_fk",
      "merge_eager_beams_project_id_projects_project_id_fk",
    ]);
    expect(config.checks.map((check) => check.name).sort()).toEqual([
      "merge_eager_beams_complete_plan_check",
      "merge_eager_beams_generation_check",
      "merge_eager_beams_rank_check",
      "merge_eager_beams_stale_reason_check",
      "merge_eager_beams_state_check",
    ]);
  });

  it("keeps EAGER purpose and lifecycle events in the exported cross-package vocabulary", () => {
    const integration = getTableConfig(integrationNodes);
    expect(integration.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["project_id", "org_id", "purpose", "member_key", "proof_root", "status"]),
    );
    expect(integration.checks.map((check) => check.name)).toContain("integration_nodes_purpose_check");
    expect(integration.foreignKeys.map((key) => key.getName()).sort()).toEqual([
      "integration_nodes_org_id_organizations_id_fk",
      "integration_nodes_project_id_projects_project_id_fk",
      // gv-17: composite same-org project FK (tenant lineage).
      "integration_nodes_project_org_fk",
    ]);
    const proofs = getTableConfig(integrationProofs);
    expect(proofs.foreignKeys.map((key) => key.getName()).sort()).toEqual([
      "integration_proofs_node_id_integration_nodes_node_id_fk",
      // gv-17: composite same-org node + project FKs.
      "integration_proofs_node_org_fk",
      "integration_proofs_org_id_organizations_id_fk",
      "integration_proofs_project_id_projects_project_id_fk",
      "integration_proofs_project_org_fk",
    ]);
    expect(eventTypesSeed).toEqual(
      expect.arrayContaining([
        { name: "merge.beam.planned", defaultSeverity: "info" },
        { name: "merge.beam.stale", defaultSeverity: "warn" },
      ]),
    );
  });
});
