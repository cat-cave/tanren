import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Verifies the 0009 migration ships the P2A-0017 notifications matrix
// tables with the constraints and indexes the dispatcher relies on.

const migrationPath = fileURLToPath(new URL("../../../db/migrations/0009_lonely_krista_starr.sql", import.meta.url));

async function readMigration(): Promise<string> {
  return readFile(migrationPath, "utf8");
}

describe("0009 notifications-matrix migration", () => {
  it("creates the notification_targets table with channel_kind and scope CHECKs", async () => {
    const sql = await readMigration();
    expect(sql).toContain('CREATE TABLE "notification_targets"');
    expect(sql).toContain("notification_targets_channel_kind_check");
    expect(sql).toMatch(
      /channel_kind.*IN \('ntfy','slack','github_checks','teams','discord','email','twilio','pagerduty','webhook'\)/u,
    );
    expect(sql).toContain("notification_targets_scope_check");
    expect(sql).toMatch(/scope.*IN \('org','user'\)/u);
    expect(sql).toContain("notification_targets_scope_user_check");
  });

  it("creates the notification_routes table with severity floor and event_name CHECKs", async () => {
    const sql = await readMigration();
    expect(sql).toContain('CREATE TABLE "notification_routes"');
    expect(sql).toContain("notification_routes_min_severity_check");
    expect(sql).toMatch(/min_severity.*IN \('ok','info','warn','fail'\)/u);
    expect(sql).toContain("notification_routes_event_name_check");
    // event_name CHECK reuses the events.event_type enum: at least one
    // canonical event from each lifecycle band must appear.
    expect(sql).toContain("'run.failed'");
    expect(sql).toContain("'ci.failed'");
    expect(sql).toContain("'auditor.verdict'");
  });

  it("creates the (target_id, event_name) unique index", async () => {
    const sql = await readMigration();
    expect(sql).toContain('CREATE UNIQUE INDEX "notification_routes_target_event_unique"');
  });

  it("creates lookup indexes for the dispatcher's per-event query path", async () => {
    const sql = await readMigration();
    expect(sql).toContain('CREATE INDEX "notification_targets_org_id"');
    expect(sql).toContain('CREATE INDEX "notification_routes_event_name"');
    expect(sql).toContain('CREATE INDEX "notification_targets_channel_kind"');
  });

  it("foreign-keys notification_routes.target_id to notification_targets and target.user_id to users", async () => {
    const sql = await readMigration();
    expect(sql).toContain('FOREIGN KEY ("target_id") REFERENCES "public"."notification_targets"');
    expect(sql).toContain('FOREIGN KEY ("user_id") REFERENCES "public"."users"');
  });
});
