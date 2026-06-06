export const LIST_PROJECTS_WITH_QUEUE_SQL = `
SELECT DISTINCT mq.project_id
  FROM merge_queue mq
 WHERE mq.status IN ('queued', 'merging')
    OR (
      mq.status = 'dequeued'
      AND mq.dequeue_reason = 'blocked'
      AND mq.pr_url IS NOT NULL
      AND mq.pr_url <> ''
      AND mq.pr_number IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
          FROM merge_queue active
         WHERE active.run_id = mq.run_id
           AND active.status IN ('queued', 'merging')
      )
      AND COALESCE((
        SELECT (
            latest.event_type = 'merge.dequeued'
            AND latest.payload ->> 'integration' = 'native_queue'
            AND latest.payload ->> 'reason' = 'blocked'
          )
          OR (
            latest.event_type = 'merge.batch.infra_blocked'
            AND latest.payload ->> 'terminal' = 'true'
            AND (
              (
                COALESCE(latest.payload ->> 'kind', '') <> 'ambiguous_merge_state'
                AND COALESCE(latest.payload ->> 'message', '') NOT LIKE '%ambiguous%'
                AND COALESCE(latest.payload ->> 'message', '') NOT LIKE '%double-merge%'
                AND NOT COALESCE((
                  latest.payload ->> 'kind' IN ('missing_required_credential', 'missing_github_credential')
                  OR latest.payload ->> 'cause' IN ('missing_required_credential', 'missing_github_credential')
                  OR latest.payload ->> 'reason' IN ('missing_required_credential', 'missing_github_credential')
                  OR latest.payload ->> 'message' LIKE '%missing GitHub credential ref:%'
                  OR latest.payload ->> 'message' LIKE '%missing % credential ref:%'
                  OR latest.payload ->> 'message' LIKE '%No GitHub credential configured%'
                ), false)
              )
              OR (
                (
                  latest.payload ->> 'kind' IN ('missing_required_credential', 'missing_github_credential')
                  OR latest.payload ->> 'cause' IN ('missing_required_credential', 'missing_github_credential')
                  OR latest.payload ->> 'reason' IN ('missing_required_credential', 'missing_github_credential')
                  OR latest.payload ->> 'message' LIKE '%missing GitHub credential ref:%'
                  OR latest.payload ->> 'message' LIKE '%missing % credential ref:%'
                  OR latest.payload ->> 'message' LIKE '%No GitHub credential configured%'
                )
                AND EXISTS (
                  SELECT 1
                    FROM events repair
                   WHERE repair.project_id = mq.project_id
                     AND repair.org_id = mq.org_id
                     AND (repair.ts > latest.ts OR (repair.ts = latest.ts AND repair.id > latest.id))
                     AND (
                       repair.event_type IN ('credential.configured', 'credential.github.configured')
                       OR (repair.event_type = 'integration.provisioned' AND repair.payload ->> 'providerKind' = 'github')
                       OR repair.event_type = 'org.github.connected'
                       OR repair.payload ->> 'provider' = 'github'
                     )
                     AND (
                       repair.payload ->> 'mode' = 'app'
                       OR repair.payload ->> 'credentialKind' = 'github_app'
                       OR COALESCE(
                         NULLIF(latest.payload ->> 'credentialRef', ''),
                         NULLIF(latest.payload ->> 'missingRef', ''),
                         NULLIF(latest.payload ->> 'requiredCredentialRef', ''),
                         substring(latest.payload ->> 'message' from 'missing [^:]* credential ref: ([^[:space:]]+)')
                       ) IS NULL
                       OR repair.payload ->> 'credentialRef' = COALESCE(
                         NULLIF(latest.payload ->> 'credentialRef', ''),
                         NULLIF(latest.payload ->> 'missingRef', ''),
                         NULLIF(latest.payload ->> 'requiredCredentialRef', ''),
                         substring(latest.payload ->> 'message' from 'missing [^:]* credential ref: ([^[:space:]]+)')
                       )
                       OR repair.payload ->> 'ref' = COALESCE(
                         NULLIF(latest.payload ->> 'credentialRef', ''),
                         NULLIF(latest.payload ->> 'missingRef', ''),
                         NULLIF(latest.payload ->> 'requiredCredentialRef', ''),
                         substring(latest.payload ->> 'message' from 'missing [^:]* credential ref: ([^[:space:]]+)')
                       )
                       OR EXISTS (
                         SELECT 1
                           FROM jsonb_array_elements_text(
                             CASE WHEN jsonb_typeof(repair.payload -> 'secretRefNames') = 'array'
                               THEN repair.payload -> 'secretRefNames'
                               ELSE '[]'::jsonb
                             END
                           ) AS secret_ref(ref)
                          WHERE secret_ref.ref = COALESCE(
                            NULLIF(latest.payload ->> 'credentialRef', ''),
                            NULLIF(latest.payload ->> 'missingRef', ''),
                            NULLIF(latest.payload ->> 'requiredCredentialRef', ''),
                            substring(latest.payload ->> 'message' from 'missing [^:]* credential ref: ([^[:space:]]+)')
                          )
                       )
                     )
                )
              )
            )
          )
          FROM events latest
         WHERE latest.id = (
           SELECT e.id
             FROM events e
            WHERE e.project_id = mq.project_id
              AND e.org_id = mq.org_id
              AND (
                e.event_type IN (
                  'merge.dequeued',
                  'merge.completed',
                  'merge.queue.infra_blocked',
                  'merge.batch.culprit',
                  'dag.spec.needs_attention',
                  'dag.spec.percolation_replan',
                  'merge.conflict.replan_routed',
                  'recovery.replan_queued'
                )
                OR (e.event_type = 'merge.batch.infra_blocked' AND e.payload ->> 'terminal' = 'true')
              )
              AND (
                (e.run_id IS NOT NULL AND e.run_id = mq.run_id)
                OR (NULLIF(e.payload ->> 'runId', '') IS NOT NULL AND e.payload ->> 'runId' = mq.run_id)
                OR (NULLIF(e.payload ->> 'prUrl', '') IS NOT NULL AND e.payload ->> 'prUrl' = mq.pr_url)
                OR (NULLIF(e.payload ->> 'prNumber', '') IS NOT NULL AND e.payload ->> 'prNumber' = mq.pr_number)
                OR EXISTS (
                  SELECT 1
                    FROM jsonb_array_elements(
                      CASE WHEN jsonb_typeof(e.payload -> 'members') = 'array'
                        THEN e.payload -> 'members'
                        ELSE '[]'::jsonb
                      END
                    ) AS member
                   WHERE member ->> 'prNumber' = mq.pr_number
                      OR member ->> 'specId' = mq.spec_id
                )
                OR (
                  e.event_type IN (
                    'dag.spec.needs_attention',
                    'dag.spec.percolation_replan',
                    'merge.conflict.replan_routed',
                    'recovery.replan_queued'
                  )
                  AND e.spec_id = mq.spec_id
                )
              )
            ORDER BY e.ts DESC, e.id DESC
            LIMIT 1
         )
      ), false)
    )
    OR (
      mq.status = 'merged'
      AND mq.pr_url IS NOT NULL
      AND mq.pr_url <> ''
      AND mq.pr_number IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
          FROM merge_queue active
         WHERE active.run_id = mq.run_id
           AND active.status IN ('queued', 'merging')
      )
      AND EXISTS (
        SELECT 1
          FROM events held
         WHERE held.project_id = mq.project_id
           AND held.org_id = mq.org_id
           AND held.event_type = 'merge.speculative_held'
           AND (NOT (held.payload ? 'integration') OR held.payload ->> 'integration' = 'native_queue')
           AND (
             held.run_id = mq.run_id
             OR held.payload ->> 'runId' = mq.run_id
             OR held.payload ->> 'prUrl' = mq.pr_url
             OR held.payload ->> 'prNumber' = mq.pr_number
             OR held.spec_id = mq.spec_id
           )
      )
      AND NOT EXISTS (
        SELECT 1
          FROM events done
         WHERE done.project_id = mq.project_id
           AND done.org_id = mq.org_id
           AND done.event_type = 'merge.completed'
           AND (
             done.run_id = mq.run_id
             OR done.payload ->> 'runId' = mq.run_id
             OR done.payload ->> 'prUrl' = mq.pr_url
             OR done.payload ->> 'prNumber' = mq.pr_number
             OR done.spec_id = mq.spec_id
           )
      )
    )
 ORDER BY mq.project_id`;
