-- rv-1 — DB-level content immutability for the persona/behavior revision spine.
--
-- Migration 0034 created `persona_revisions` + `behavior_revisions` with a
-- `status` lifecycle column ('active' | 'superseded' | 'needs_respec') but NO
-- guard against content mutation. The peer append-only spine tables all carry a
-- BEFORE UPDATE/DELETE trigger (0047 governance_policy_revisions, 0049
-- source_findings, 0089 verdict evidence); the revision tables were shipped
-- without one. rv-1 is the consumer node that mints these revisions, so it
-- closes the gap: a persisted revision's CONTENT is immutable — a new content
-- is a NEW revision row, never an overwrite.
--
-- The lifecycle `status` column is legitimately mutable (active -> superseded /
-- needs_respec), so this is a CONTENT-scoped trigger rather than a blanket
-- append-only lock: every identity/content column is frozen, DELETE is refused
-- outright, and only a status transition is allowed to pass. Enforced at the DB
-- so the invariant holds even against a system-credentialed client. Drizzle does
-- not manage triggers; this is intentional hand-authored SQL.

CREATE FUNCTION "reject_persona_revision_content_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'persona_revisions is append-only; DELETE is not permitted (id=%)', OLD.id;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."org_id" IS DISTINCT FROM OLD."org_id"
     OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
     OR NEW."persona_id" IS DISTINCT FROM OLD."persona_id"
     OR NEW."scope" IS DISTINCT FROM OLD."scope"
     OR NEW."revision_number" IS DISTINCT FROM OLD."revision_number"
     OR NEW."name" IS DISTINCT FROM OLD."name"
     OR NEW."description" IS DISTINCT FROM OLD."description"
     OR NEW."attributes" IS DISTINCT FROM OLD."attributes"
     OR NEW."content_digest" IS DISTINCT FROM OLD."content_digest"
     OR NEW."authoring_provenance" IS DISTINCT FROM OLD."authoring_provenance"
     OR NEW."supersedes_id" IS DISTINCT FROM OLD."supersedes_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'persona_revisions content is immutable; only status may transition (id=%)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "persona_revisions_content_immutable"
BEFORE UPDATE OR DELETE ON "persona_revisions"
FOR EACH ROW EXECUTE FUNCTION "reject_persona_revision_content_mutation"();
--> statement-breakpoint
CREATE FUNCTION "reject_behavior_revision_content_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'behavior_revisions is append-only; DELETE is not permitted (id=%)', OLD.id;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."org_id" IS DISTINCT FROM OLD."org_id"
     OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
     OR NEW."behavior_id" IS DISTINCT FROM OLD."behavior_id"
     OR NEW."persona_revision_id" IS DISTINCT FROM OLD."persona_revision_id"
     OR NEW."revision_number" IS DISTINCT FROM OLD."revision_number"
     OR NEW."title" IS DISTINCT FROM OLD."title"
     OR NEW."given" IS DISTINCT FROM OLD."given"
     OR NEW."when" IS DISTINCT FROM OLD."when"
     OR NEW."then" IS DISTINCT FROM OLD."then"
     OR NEW."acceptance" IS DISTINCT FROM OLD."acceptance"
     OR NEW."content_digest" IS DISTINCT FROM OLD."content_digest"
     OR NEW."design_contract_digest" IS DISTINCT FROM OLD."design_contract_digest"
     OR NEW."authoring_provenance" IS DISTINCT FROM OLD."authoring_provenance"
     OR NEW."supersedes_id" IS DISTINCT FROM OLD."supersedes_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'behavior_revisions content is immutable; only status may transition (id=%)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "behavior_revisions_content_immutable"
BEFORE UPDATE OR DELETE ON "behavior_revisions"
FOR EACH ROW EXECUTE FUNCTION "reject_behavior_revision_content_mutation"();
