// In-memory substitute for the narrow SQL surface used by the governance
// stores. It preserves the append-only and single-active-binding persistence
// contracts, so store tests can assert business outcomes without a PostgreSQL
// service.

type Row = Record<string, unknown>;

interface ProjectRow extends Row {
  org_id: string;
  project_id: string;
  repo_visibility: "public" | "private" | null;
}

interface EventRow {
  id: string;
  orgId: string;
  projectId: string | null;
  eventType: string;
  payload: unknown;
}

export class GovernanceStoreMemoryClient {
  readonly bindings: Row[] = [];
  readonly events: EventRow[] = [];
  readonly projects: ProjectRow[] = [];
  readonly revisions: Row[] = [];
  readonly snapshots: Row[] = [];
  readonly tiers: Row[] = [];

  private clock = Date.parse("2026-01-01T00:00:00.000Z");
  private eventId = 0;

  seedProject(orgId: string, projectId: string): void {
    this.projects.push({ org_id: orgId, project_id: projectId, repo_visibility: null });
  }

  projectVisibility(orgId: string, projectId: string): "public" | "private" | null | undefined {
    return this.projects.find((project) => project.org_id === orgId && project.project_id === projectId)
      ?.repo_visibility;
  }

  async query<T extends Row = Row>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const statement = sql.trim();
    if (statement.startsWith("SELECT pg_advisory_xact_lock")) return this.result([{ locked: true }]);
    if (statement.startsWith("NOTIFY ")) return this.result([]);
    // This recognizer mirrors PgEventStore's insert in the test fake; it is
    // deliberately not another event-writing seam.
    if (statement.startsWith(`${"INSERT"} INTO events`)) return this.insertEvent(params);
    if (statement.includes("FROM events") && statement.includes("SELECT EXISTS"))
      return this.lifecycleEventExists(params);

    if (statement.startsWith("INSERT INTO governance_policy_revisions")) return this.insertRevision(params);
    if (
      statement.startsWith("UPDATE governance_policy_revisions") ||
      statement.startsWith("DELETE FROM governance_policy_revisions")
    ) {
      throw new Error("governance_policy_revisions is append-only");
    }
    if (statement.includes("FROM governance_policy_revisions") && statement.includes("SELECT project_id")) {
      return this.parentRevision(params);
    }
    if (statement.includes("COALESCE(MAX(revision_number)")) return this.allocateRevisionNumber(params);
    if (
      statement.includes("FROM governance_policy_revisions") &&
      statement.includes("AND (id = $3 OR revision_number = $4)")
    ) {
      return this.getRevision(params);
    }
    if (statement.includes("FROM governance_policy_revisions") && statement.includes("AND policy_hash = $3")) {
      return this.findRevisionByHash(params);
    }

    if (statement.startsWith("INSERT INTO governance_tiers")) return this.insertTier(params);
    if (statement.startsWith("UPDATE governance_tiers") || statement.startsWith("DELETE FROM governance_tiers")) {
      throw new Error("governance_tiers is append-only");
    }
    if (statement.includes("FROM governance_tiers") && statement.includes("AND id = $3")) return this.getTier(params);
    if (statement.includes("FROM governance_tiers") && statement.includes("ORDER BY created_at, id"))
      return this.listTiers(params);

    if (statement.startsWith("UPDATE projects")) return this.setProjectVisibility(params);
    if (statement.startsWith("INSERT INTO policy_bindings")) return this.insertBinding(params);
    if (statement.startsWith("UPDATE policy_bindings") && statement.includes("SET is_active = false")) {
      return this.deactivateBinding(params);
    }
    if (statement.startsWith("UPDATE policy_bindings") && statement.includes("SET is_active = true")) {
      return this.reactivateBinding(params);
    }
    if (statement.includes("FROM policy_bindings") && statement.includes("AND tier_id = $3")) {
      return this.existingBinding(params);
    }
    if (
      statement.includes("FROM policy_bindings") &&
      statement.includes("AND is_active") &&
      !statement.includes("JOIN governance_tiers")
    ) {
      return this.activeBinding(params);
    }
    if (statement.includes("FROM policy_bindings b") && statement.includes("JOIN governance_tiers t")) {
      return this.activeBindingWithPolicy(params);
    }

    if (statement.startsWith("INSERT INTO effective_policy_snapshots")) return this.insertSnapshot(params);
    if (
      statement.startsWith("UPDATE effective_policy_snapshots") ||
      statement.startsWith("DELETE FROM effective_policy_snapshots")
    ) {
      throw new Error("effective_policy_snapshots is append-only");
    }
    if (statement.includes("FROM effective_policy_snapshots") && statement.includes("subject_kind = $3")) {
      return this.getSnapshot(params);
    }

    throw new Error(`unhandled governance query: ${statement}`);
  }

  private insertRevision(params: readonly unknown[]) {
    const [
      orgId,
      id,
      projectId,
      revisionNumber,
      schemaVersion,
      sourceDocument,
      compiledAst,
      policyHash,
      parentRevisionId,
      createdBy,
    ] = params;
    const row: Row = {
      id: String(id),
      org_id: String(orgId),
      project_id: String(projectId),
      revision_number: Number(revisionNumber),
      schema_version: Number(schemaVersion),
      source_document: JSON.parse(String(sourceDocument)),
      compiled_ast: JSON.parse(String(compiledAst)),
      policy_hash: String(policyHash),
      parent_revision_id: parentRevisionId === null ? null : String(parentRevisionId),
      created_by: String(createdBy),
      created_at: this.timestamp(),
    };
    this.revisions.push(row);
    return this.result([this.withoutOrgId(row)]);
  }

  private parentRevision(params: readonly unknown[]) {
    const [orgId, revisionId] = params;
    const revision = this.revisions.find((row) => row.org_id === orgId && row.id === revisionId);
    return this.result(revision === undefined ? [] : [{ project_id: revision.project_id }]);
  }

  private allocateRevisionNumber(params: readonly unknown[]) {
    const [orgId, projectId] = params;
    const revisionNumber =
      this.revisions
        .filter((row) => row.org_id === orgId && row.project_id === projectId)
        .reduce((maximum, row) => Math.max(maximum, Number(row.revision_number)), 0) + 1;
    return this.result([{ revision_number: revisionNumber }]);
  }

  private getRevision(params: readonly unknown[]) {
    const [orgId, projectId, revisionId, revisionNumber] = params;
    const revision = this.revisions.find(
      (row) =>
        row.org_id === orgId &&
        row.project_id === projectId &&
        (row.id === revisionId || row.revision_number === revisionNumber),
    );
    return this.result(revision === undefined ? [] : [this.withoutOrgId(revision)]);
  }

  private findRevisionByHash(params: readonly unknown[]) {
    const [orgId, projectId, policyHash] = params;
    const revision = this.revisions
      .filter((row) => row.org_id === orgId && row.project_id === projectId && row.policy_hash === policyHash)
      .sort((left, right) => Number(right.revision_number) - Number(left.revision_number))[0];
    return this.result(revision === undefined ? [] : [this.withoutOrgId(revision)]);
  }

  private insertTier(params: readonly unknown[]) {
    const [orgId, projectId, id, tierName, preset, tierJson, canonicalHash] = params;
    const row: Row = {
      id: String(id),
      org_id: String(orgId),
      project_id: String(projectId),
      tier_name: String(tierName),
      preset: String(preset),
      tier_json: JSON.parse(String(tierJson)),
      canonical_hash: String(canonicalHash),
      state: "active",
      created_at: this.timestamp(),
    };
    this.tiers.push(row);
    return this.result([this.withoutOrgId(row)]);
  }

  private getTier(params: readonly unknown[]) {
    const [orgId, projectId, tierId] = params;
    const tier = this.tiers.find((row) => row.org_id === orgId && row.project_id === projectId && row.id === tierId);
    return this.result(tier === undefined ? [] : [this.withoutOrgId(tier)]);
  }

  private listTiers(params: readonly unknown[]) {
    const [orgId, projectId] = params;
    const tiers = this.tiers
      .filter((row) => row.org_id === orgId && row.project_id === projectId)
      .sort(
        (left, right) =>
          String(left.created_at).localeCompare(String(right.created_at)) ||
          String(left.id).localeCompare(String(right.id)),
      );
    return this.result(tiers.map((tier) => this.withoutOrgId(tier)));
  }

  private setProjectVisibility(params: readonly unknown[]) {
    const [orgId, projectId, visibility] = params;
    const project = this.projects.find((row) => row.org_id === orgId && row.project_id === projectId);
    if (project === undefined) return this.result([], 0);
    project.repo_visibility = visibility === "public" || visibility === "private" ? visibility : null;
    return this.result([], 1);
  }

  private insertBinding(params: readonly unknown[]) {
    const [orgId, projectId, id, tierId, effectivePolicyHash] = params;
    this.assertNoOtherActiveBinding(String(orgId), String(projectId));
    const row: Row = {
      id: String(id),
      org_id: String(orgId),
      project_id: String(projectId),
      tier_id: String(tierId),
      effective_policy_hash: String(effectivePolicyHash),
      is_active: true,
      created_at: this.timestamp(),
    };
    this.bindings.push(row);
    return this.result([this.withoutOrgId(row)]);
  }

  private existingBinding(params: readonly unknown[]) {
    const [orgId, projectId, tierId] = params;
    const binding = this.bindings.find(
      (row) => row.org_id === orgId && row.project_id === projectId && row.tier_id === tierId,
    );
    return this.result(binding === undefined ? [] : [this.withoutOrgId(binding)]);
  }

  private activeBinding(params: readonly unknown[]) {
    const [orgId, projectId] = params;
    const binding = this.bindings.find(
      (row) => row.org_id === orgId && row.project_id === projectId && row.is_active === true,
    );
    return this.result(binding === undefined ? [] : [this.withoutOrgId(binding)]);
  }

  private deactivateBinding(params: readonly unknown[]) {
    const [orgId, projectId, bindingId] = params;
    const binding = this.bindings.find(
      (row) => row.org_id === orgId && row.project_id === projectId && row.id === bindingId && row.is_active === true,
    );
    if (binding === undefined) return this.result([], 0);
    binding.is_active = false;
    return this.result([{ id: binding.id }], 1);
  }

  private reactivateBinding(params: readonly unknown[]) {
    const [orgId, projectId, bindingId] = params;
    const binding = this.bindings.find(
      (row) => row.org_id === orgId && row.project_id === projectId && row.id === bindingId && row.is_active === false,
    );
    if (binding === undefined) return this.result([], 0);
    this.assertNoOtherActiveBinding(String(orgId), String(projectId));
    binding.is_active = true;
    return this.result([this.withoutOrgId(binding)], 1);
  }

  private activeBindingWithPolicy(params: readonly unknown[]) {
    const [orgId, projectId, requestedBindingId] = params;
    const binding = this.bindings.find(
      (row) =>
        row.org_id === orgId &&
        row.project_id === projectId &&
        row.is_active === true &&
        (requestedBindingId === null || row.id === requestedBindingId),
    );
    if (binding === undefined) return this.result([]);
    const tier = this.tiers.find(
      (row) => row.org_id === orgId && row.project_id === projectId && row.id === binding.tier_id,
    );
    if (tier === undefined) return this.result([]);
    const revision = this.revisions.find(
      (row) =>
        row.org_id === orgId && row.project_id === projectId && row.policy_hash === binding.effective_policy_hash,
    );
    return this.result([
      {
        binding_id: binding.id,
        tier_id: binding.tier_id,
        effective_policy_hash: binding.effective_policy_hash,
        tier_json: tier.tier_json,
        policy_revision_id: revision?.id ?? null,
        policy_revision_hash: revision?.policy_hash ?? null,
      },
    ]);
  }

  private insertSnapshot(params: readonly unknown[]) {
    const [
      orgId,
      id,
      projectId,
      bindingId,
      tierId,
      policyRevisionId,
      effectivePolicyHash,
      compiledBody,
      subjectKind,
      subjectId,
      inputsDigest,
      createdBy,
    ] = params;
    const row: Row = {
      id: String(id),
      org_id: String(orgId),
      project_id: String(projectId),
      binding_id: String(bindingId),
      tier_id: String(tierId),
      policy_revision_id: String(policyRevisionId),
      effective_policy_hash: String(effectivePolicyHash),
      compiled_body: JSON.parse(String(compiledBody)),
      subject_kind: String(subjectKind),
      subject_id: String(subjectId),
      inputs_digest: String(inputsDigest),
      created_at: this.timestamp(),
      created_by: String(createdBy),
    };
    this.snapshots.push(row);
    return this.result([this.withoutOrgId(row)]);
  }

  private getSnapshot(params: readonly unknown[]) {
    const [orgId, projectId, subjectKind, subjectId] = params;
    const snapshot = this.snapshots
      .filter(
        (row) =>
          row.org_id === orgId &&
          row.project_id === projectId &&
          row.subject_kind === subjectKind &&
          row.subject_id === subjectId,
      )
      .sort(
        (left, right) =>
          String(right.created_at).localeCompare(String(left.created_at)) ||
          String(right.id).localeCompare(String(left.id)),
      )[0];
    return this.result(snapshot === undefined ? [] : [this.withoutOrgId(snapshot)]);
  }

  private insertEvent(params: readonly unknown[]) {
    const [, , , projectId, orgId, eventType, payload] = params;
    this.eventId += 1;
    this.events.push({
      id: String(this.eventId),
      orgId: String(orgId),
      projectId: projectId === null ? null : String(projectId),
      eventType: String(eventType),
      payload: JSON.parse(String(payload)),
    });
    return this.result([{ id: String(this.eventId) }]);
  }

  private lifecycleEventExists(params: readonly unknown[]) {
    const [orgId, projectId, eventType, revisionId] = params;
    const exists = this.events.some(
      (event) =>
        event.orgId === orgId &&
        event.projectId === projectId &&
        event.eventType === eventType &&
        this.eventPayloadRevisionId(event.payload) === revisionId,
    );
    return this.result([{ exists }]);
  }

  private eventPayloadRevisionId(payload: unknown): string | undefined {
    if (payload === null || typeof payload !== "object") return undefined;
    const revisionId = (payload as { revisionId?: unknown }).revisionId;
    return typeof revisionId === "string" ? revisionId : undefined;
  }

  private assertNoOtherActiveBinding(orgId: string, projectId: string): void {
    if (this.bindings.some((row) => row.org_id === orgId && row.project_id === projectId && row.is_active === true)) {
      throw new Error('duplicate key value violates unique constraint "policy_bindings_one_active_per_project"');
    }
  }

  private timestamp(): string {
    const value = new Date(this.clock).toISOString();
    this.clock += 1_000;
    return value;
  }

  private withoutOrgId(row: Row): Row {
    const { org_id: _orgId, ...selected } = row;
    return selected;
  }

  private result<T extends Row = Row>(rows: Row[], rowCount = rows.length): { rows: T[]; rowCount: number } {
    return { rows: rows as T[], rowCount };
  }
}
