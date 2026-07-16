export interface MemoryConnection {
  id: string;
  org_id: string;
  provider_kind: string;
  provider_principal_id: string;
  principal_kind: string;
  display_name: string;
  principal_metadata: Record<string, unknown>;
  health: string;
  status: string;
  current_auth_generation: number | null;
  owner_id: string;
}
export interface MemoryAuthGeneration {
  org_id: string;
  provider_kind: string;
  connection_id: string;
  generation: number;
  credential_ref: string;
  auth_kind: string;
  expires_at: string | null;
  status: string;
}
export interface MemoryGrant {
  id: string;
  org_id: string;
  provider_kind: string;
  connection_id: string;
  plane: string;
  environment: string;
  current_generation: number | null;
  status: string;
}
export interface MemoryGrantGeneration {
  org_id: string;
  provider_kind: string;
  connection_id: string;
  grant_id: string;
  generation: number;
  capabilities: string[];
  operations: string[];
  provider_scopes: string[];
  policy_revision: string;
  consent_revision: string;
  status: string;
  expires_at: string | null;
}
export interface MemoryOperation {
  id: string;
  org_id: string;
  provider_kind: string;
  connection_id: string | null;
  operation_kind: string;
  stage: string;
  status: string;
  idempotency_key: string;
  actor_id: string;
  staged_secret_handle: string | null;
  candidate_principals: unknown[];
  selected_principal_id: string | null;
  target_auth_generation: number | null;
  failure_classification: string | null;
}
export interface MemorySelection {
  org_id: string;
  project_id: string;
  provider_kind: string;
  connection_id: string;
  auth_generation: number;
  grant_id: string;
  grant_generation: number;
  selected_by: string;
}
