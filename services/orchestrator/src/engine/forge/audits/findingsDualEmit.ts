// WAVE-2 / SLICE P-A de-risk flag (tanren-owns-the-engine.md §4 + §8 guardrail
// "migrate through an explicit compatibility read-model, not silent abandonment").
//
// During this slice the auditor DUAL-EMITS: it records BOTH the legacy verdict
// (`passed`/`recommendedAction`/`outstandingBehaviorIds`) AND the new explicit
// `findings: Finding[]` on `auditor.verdict`. S1 reads findings; S3 deletes the
// legacy verdict. This flag is the single switch that gates the additive findings
// emission so the slice can land WITHOUT changing live-loop behavior if needed —
// nothing downstream is forced to read findings yet.
//
// It is a GOVERNED CONSTANT (a code-level default, the same shape as the other
// engine defaults), NOT a `process.env.X ?? default`. The default is ON: emit
// findings alongside the legacy verdict. A caller may override per-stage (the
// `AuditorStageInput.dualEmitFindings` knob) for a focused test.

/**
 * Whether the auditor emits the explicit `findings` list alongside the legacy
 * verdict on `auditor.verdict`. Default ON for this slice (additive dual-emit).
 * When OFF, the auditor emits only the legacy verdict and the DagLifecycle read
 * model falls back to the legacy severity inference — byte-identical to the
 * pre-slice behavior.
 */
export const AUDIT_FINDINGS_DUAL_EMIT_DEFAULT = true;
