/**
 * Reusable server-rendered primitives for the P2B-0002 onboarding /
 * credentials / notifications screens. Rebuilt as TSX from the hi-fi
 * (`flows.jsx` OnbShell / StepHeading / Field / Toggle / StatusBadge /
 * PhaseBadge). Pure presentation; interactivity is handled by the screen's
 * own island (`onboarding.ts`) reading `data-*` hooks.
 */

import type { Severity } from "../../api/types.js";

export interface WizardStep {
  /** 1-based step index. */
  index: number;
  label: string;
}

/** The top journey stepper for a multi-step onboarding track. */
export function JourneyStepper(props: {
  steps: WizardStep[];
  current: number;
  /** Base path; each step links to `${basePath}?step=N`. */
  basePath: string;
}) {
  return (
    <div class="journey">
      {props.steps.map((step, i) => {
        const state = step.index < props.current ? "done" : step.index === props.current ? "live" : "queued";
        return (
          <>
            <a class={`j-step ${state}`} href={`${props.basePath}?step=${step.index}`} title={step.label}>
              <span class="num">{state === "done" ? "✓" : step.index}</span>
              <span class="lbl">{step.label}</span>
            </a>
            {i < props.steps.length - 1 ? <span class={`j-arrow ${state === "done" ? "done" : ""}`}>→</span> : null}
          </>
        );
      })}
    </div>
  );
}

/** Substep heading inside a step body. */
export function StepHeading(props: { eyebrow: string; title: string; em?: string; sub?: string; right?: unknown }) {
  return (
    <div class="step-heading">
      <div>
        <div class="eyebrow">{props.eyebrow}</div>
        <div class="title">
          {props.title} {props.em ? <em>{props.em}</em> : null}
        </div>
        {props.sub ? <div class="sub">{props.sub}</div> : null}
      </div>
      {props.right ? <div class="right">{props.right}</div> : null}
    </div>
  );
}

/** A labeled text/select form input. Secrets are plain inputs (write-only). */
export function Field(props: {
  name: string;
  label: string;
  placeholder?: string;
  value?: string;
  type?: "text" | "password" | "url";
  hint?: string;
  required?: boolean;
}) {
  return (
    <div class="field">
      <label for={props.name}>{props.label}</label>
      <input
        id={props.name}
        name={props.name}
        type={props.type ?? "text"}
        placeholder={props.placeholder}
        value={props.value}
        required={props.required}
        autocomplete="off"
      />
      {props.hint ? <div class="hint">{props.hint}</div> : null}
    </div>
  );
}

/** A labeled select. `options` are `[value, label]` pairs. */
export function SelectField(props: {
  name: string;
  label: string;
  options: Array<[string, string]>;
  value?: string;
  hint?: string;
}) {
  return (
    <div class="field">
      <label for={props.name}>{props.label}</label>
      <select id={props.name} name={props.name}>
        {props.options.map(([value, label]) => (
          <option value={value} selected={value === props.value}>
            {label}
          </option>
        ))}
      </select>
      {props.hint ? <div class="hint">{props.hint}</div> : null}
    </div>
  );
}

/** Read-only on/off toggle pill (interactivity wired by the screen island). */
export function Toggle(props: { on: boolean; dataAttrs?: Record<string, string> }) {
  return (
    <button type="button" class={`toggle ${props.on ? "on" : "off"}`} {...(props.dataAttrs ?? {})}>
      <span class="knob"></span>
    </button>
  );
}

/** Roadmap-phase badge (`v0` wired, `p3`/`p4` stub). */
export function PhaseBadge(props: { phase: "v0" | "p3" | "p4" }) {
  return <span class={`phase-badge phase-${props.phase}`}>{props.phase}</span>;
}

/** Integration connection-state badge. */
export function StatusBadge(props: { status: string }) {
  const kind =
    props.status === "connected" || props.status === "always-on"
      ? "on"
      : props.status === "auth needed" || props.status === "action needed"
        ? "warn"
        : "off";
  return <span class={`status-badge status-${kind}`}>{props.status}</span>;
}

/** Severity chip used in the matrix and event rows. */
export function SevBadge(props: { severity: Severity }) {
  return <span class={`matrix-sev ${props.severity}`}>{props.severity}</span>;
}

/** The bottom action bar (back / hint / secondary / primary). */
export function WizardFoot(props: {
  backHref?: string;
  backLabel?: string;
  hint?: string;
  secondaryHref?: string;
  secondaryLabel?: string;
  primaryHref: string;
  primaryLabel: string;
}) {
  return (
    <div class="foot">
      {props.backHref ? (
        <a class="btn ghost" href={props.backHref}>
          ← {props.backLabel ?? "back"}
        </a>
      ) : null}
      {props.hint ? <div class="hint">{props.hint}</div> : null}
      <div class="grow"></div>
      {props.secondaryHref ? (
        <a class="btn" href={props.secondaryHref}>
          {props.secondaryLabel}
        </a>
      ) : null}
      <a class="btn primary" href={props.primaryHref}>
        {props.primaryLabel}
      </a>
    </div>
  );
}
