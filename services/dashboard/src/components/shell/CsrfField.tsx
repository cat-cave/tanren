/**
 * Hidden CSRF synchronizer field for server-rendered form POSTs.
 * Prefer embedding this in every state-changing form so pure HTML posts work
 * without JS. Islands may instead send `x-csrf-token` (see client csrf helpers).
 */

import { CSRF_FORM_FIELD } from "../../auth/csrf.js";

export function CsrfField(props: { token: string | undefined }) {
  const token = props.token;
  if (token === undefined || token === "") {
    return null;
  }
  return <input type="hidden" name={CSRF_FORM_FIELD} value={token} />;
}
