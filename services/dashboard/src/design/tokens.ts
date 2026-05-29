/**
 * Tanren design tokens — TypeScript constants.
 *
 * Mirrors the non-color tokens defined in `tokens.css` (which is itself a copy
 * of `docs/design/tokens/colors_and_type.css`, verified by the drift check at
 * `scripts/check-design-tokens-drift.mjs`).
 *
 * Color tokens are NOT duplicated here — they remain CSS variables and flow
 * through `tokens.css`. Reference them in TypeScript as `var(--accent)`,
 * `var(--fg-1)`, etc., when constructing inline styles.
 */

/** CSS `font-family` stacks. */
export const fontFamilies = {
  /** Syne — avant-garde display; H1s, hero headlines, italic emphasis. */
  display: '"Syne", "Space Grotesk", "Inter Tight", system-ui, sans-serif',
  /** Space Grotesk — UI and body. Geometric, slightly quirky. */
  ui: '"Space Grotesk", "Geist", -apple-system, "Segoe UI", system-ui, sans-serif',
  /** JetBrains Mono — code, numbers, eyebrow labels, terminal output. */
  mono: '"JetBrains Mono", "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace',
  /** Reggae One / Noto Serif JP — for the 鍛 / 鍛錬 kanji moments. */
  jp: '"Reggae One", "Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif',
} as const;

/** Type-scale tokens (rem). Pair with `fontFamilies` per surface. */
export const typeScale = {
  displayXl: "7.5rem",
  displayL: "4.5rem",
  displayM: "3rem",
  displayS: "2rem",
  h1: "2.25rem",
  h2: "1.625rem",
  h3: "1.25rem",
  h4: "1rem",
  bodyL: "1.125rem",
  body: "0.9375rem",
  bodyS: "0.8125rem",
  caption: "0.6875rem",
} as const;

/** Spacing scale — 4px base. */
export const spacing = {
  s0: "0",
  s1: "4px",
  s2: "8px",
  s3: "12px",
  s4: "16px",
  s5: "20px",
  s6: "24px",
  s7: "32px",
  s8: "40px",
  s9: "56px",
  s10: "72px",
  s11: "96px",
  s12: "128px",
} as const;

/** Corner radius scale. Tanren stays tight — never round to generic 8/12/16. */
export const radius = {
  r0: "0",
  r1: "2px",
  r2: "4px",
  r3: "6px",
  r4: "10px",
  full: "999px",
} as const;

/** Motion durations. Sharp, intentional, never bouncy. */
export const duration = {
  fast: "120ms",
  base: "200ms",
  slow: "380ms",
  page: "600ms",
} as const;

/** Easing curves. */
export const ease = {
  out: "cubic-bezier(0.16, 1, 0.3, 1)",
  inOut: "cubic-bezier(0.65, 0, 0.35, 1)",
  in: "cubic-bezier(0.7, 0, 0.84, 0)",
} as const;

/** Box-shadow tokens. We prefer hairlines to shadows; reserve these for elevation moments. */
export const shadow = {
  none: "none",
  s1: "0 1px 0 0 oklch(8% 0.012 60 / 0.04)",
  s2: "0 1px 2px 0 oklch(8% 0.012 60 / 0.06), 0 1px 0 0 oklch(8% 0.012 60 / 0.04)",
  s3: "0 6px 24px -8px oklch(8% 0.012 60 / 0.18), 0 1px 0 0 oklch(8% 0.012 60 / 0.06)",
  s4: "0 20px 60px -20px oklch(8% 0.012 60 / 0.30)",
  ember: "0 0 0 1px var(--ember-08), 0 6px 20px -8px oklch(66% 0.18 42 / 0.35)",
} as const;

export type FontFamilyToken = keyof typeof fontFamilies;
export type TypeScaleToken = keyof typeof typeScale;
export type SpacingToken = keyof typeof spacing;
export type RadiusToken = keyof typeof radius;
export type DurationToken = keyof typeof duration;
export type EaseToken = keyof typeof ease;
export type ShadowToken = keyof typeof shadow;
