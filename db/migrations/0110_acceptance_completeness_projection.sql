-- rv-26.4: read-only, security-invoker projection for the promotion-time behavior
-- completeness check.  It intentionally exposes only org/project-scoped rows;
-- underlying RLS remains authoritative (a caller without app.current_org_id sees
-- no rows).  The TypeScript authority rechecks exact sets before promotion.
CREATE VIEW "acceptance_completeness_projection"
  WITH (security_invoker = true)
AS
SELECT ri.org_id,
       ri.project_id,
       ri.id AS release_instance_id,
       ri.integration_node_id,
       ri.artifact_digest AS promoted_artifact_digest,
       COUNT(DISTINCT rb.behavior_revision_id)::integer AS required_behavior_revision_count
  FROM release_instances ri
  LEFT JOIN release_instance_behavior_revisions rb
    ON rb.org_id = ri.org_id AND rb.release_instance_id = ri.id
 GROUP BY ri.org_id, ri.project_id, ri.id, ri.integration_node_id, ri.artifact_digest;
