// TEST FIXTURE ONLY (P1c). Deterministic vision-interview answerer — a scripted
// stand-in for the real provider interview answerer (`wrapProviderInterviewAnswerer`).
// It MUST NOT be constructed by any production/runtime path: production resolves a
// real provider answerer from the project's `forge` routing (see
// engine/forge/providerFactory.ts). It lives under tests/ so the §8a arch-lint
// keeps it out of src/.
//
// It runs a scripted ~14-round interview that accumulates the capture (identity →
// personas → behaviors → interfaces → design-DNA → architecture → rulesets), so a
// test can drive the round/derive paths without hitting an LLM. The script mirrors
// the hi-fi `supply-chain-os` example; each round contributes a capture delta + the
// next question; the final round flips `complete`.

import {
  type InterviewAnswerer,
  type InterviewAnswererContext,
  type InterviewRoundOutput,
} from "../../../src/engine/forge/interview/types.js";

// One scripted round: the question Forge asks NEXT and the capture this round
// folds in. Index 0 is round 1.
/* eslint-disable unicorn/no-thenable */
// `then` is BDD Given/When/Then vocabulary in the capture behaviors below; the
// thenable-object lint does not apply to these plain data literals.
const SCRIPT: InterviewRoundOutput[] = [
  {
    say: "Welcome to the forge. In one line — what are we building, and who is it for?",
    captureDelta: {},
    suggestions: [
      {
        label: "a supply-chain ops tool",
        value: "supply chain operations for mid-market manufacturers",
      },
    ],
    complete: false,
  },
  {
    say: "Got it. What should we call the repo? And who are the main people who'll use this day to day?",
    captureDelta: {
      identity: {
        slug: "supply-chain-os",
        pitch: "supply chain operations for mid-market manufacturers.",
        repoHint: "github.com/cat-cave/supply-chain-os",
      },
    },
    suggestions: [{ label: "ops manager · line worker · cfo", value: "ops manager, line worker, cfo" }],
    complete: false,
  },
  {
    say: "Three personas captured — ops manager, line worker, cfo. Let's nail the line worker's behaviors. Walk me through their morning.",
    captureDelta: {
      personas: [
        { name: "ops manager", description: "orders, supplier scoring", surface: "desktop" },
        { name: "line worker", description: "barcode + bin moves", surface: "handheld" },
        { name: "cfo", description: "monthly reports, edi", surface: "desktop" },
      ],
    },
    suggestions: [],
    complete: false,
  },
  {
    say: "Good — I'm capturing the line worker's shift as behaviors. These become BDD scenarios in your DAG. Now the ops manager: what do they do most?",
    captureDelta: {
      behaviors: [
        {
          persona: "line worker",
          title: "clock in with badge",
          given: "line worker at handheld",
          when: "they scan their badge",
          then: "a shift opens + pick list loads",
        },
        {
          persona: "line worker",
          title: "pull the day's pick list",
          given: "an open shift",
          when: "they open the station",
          then: "the pick list for their station loads",
        },
        {
          persona: "line worker",
          title: "scan items off the bin",
          given: "a pick list",
          when: "they scan an item",
          then: "the item is added to the tote",
        },
        {
          persona: "line worker",
          title: "confirm each scan",
          given: "a scanned item",
          when: "they confirm",
          then: "the scan is committed",
        },
        {
          persona: "line worker",
          title: "push tote to staging",
          given: "a full tote",
          when: "they push it",
          then: "the tote moves to staging",
        },
      ],
    },
    suggestions: [],
    complete: false,
  },
  {
    say: "Captured the ops manager's core flows. What does the cfo need each month?",
    captureDelta: {
      behaviors: [
        {
          persona: "ops manager",
          title: "place a purchase order",
          given: "an ops manager",
          when: "they submit a PO",
          then: "the order is created + routed",
        },
        {
          persona: "ops manager",
          title: "review supplier scorecard",
          given: "a supplier",
          when: "they open its scorecard",
          then: "scoring + history render",
        },
      ],
    },
    suggestions: [],
    complete: false,
  },
  {
    say: "Good. What surfaces do these people work on — desktop, handheld, both?",
    captureDelta: {
      behaviors: [
        {
          persona: "cfo",
          title: "run the monthly close",
          given: "a month end",
          when: "they run the close",
          then: "variance + exports are produced",
        },
      ],
    },
    suggestions: [
      {
        label: "desktop + offline handheld",
        value: "desktop dashboard for ops + cfo, offline-capable handheld for the line worker",
      },
    ],
    complete: false,
  },
  {
    say: "Two interfaces inferred. Pick a design starter — it sets your component DNA.",
    captureDelta: {
      interfaces: [
        { name: "desktop dashboard", note: "ops + cfo" },
        { name: "handheld web app", note: "line worker · offline-capable" },
      ],
    },
    suggestions: [
      { label: "industrial · tanren forge", value: "industrial" },
      { label: "bauhaus · clean", value: "bauhaus" },
      { label: "editorial · brand", value: "editorial" },
    ],
    complete: false,
  },
  {
    say: "Industrial it is. Here's the architecture I'd propose — confirm or override.",
    captureDelta: { designDna: "industrial" },
    suggestions: [{ label: "looks right", value: "confirm the proposed architecture" }],
    complete: false,
  },
  {
    say: "Architecture locked. Last required step: your repo rulesets — tanren can't operate without these.",
    captureDelta: {
      architecture: [
        { layer: "web", choice: "next.js · turborepo" },
        { layer: "handheld", choice: "next.js pwa · service worker" },
        { layer: "data", choice: "postgres · drizzle" },
        { layer: "deploy", choice: "fly.io · 2 regions" },
      ],
    },
    suggestions: [],
    complete: false,
  },
  {
    say: "Rulesets locked. That's everything I need — your smithy is ready to derive.",
    captureDelta: {
      rulesets: [
        "main protected · pr required",
        "linear history",
        "status checks required",
        "no force push",
        "mergify on",
      ],
    },
    suggestions: [],
    complete: true,
  },
];
/* eslint-enable unicorn/no-thenable */

// The deterministic answerer returns the scripted round for `context.round`
// (1-based). Once past the script it repeats the final, `complete` round so the
// surface never stalls. Real production answerers run the same shape over an LLM.
export function createDeterministicInterviewAnswerer(): InterviewAnswerer {
  return {
    async ask(context: InterviewAnswererContext): Promise<InterviewRoundOutput> {
      const index = Math.max(0, context.round - 1);
      const last = SCRIPT.at(-1);
      const entry = index < SCRIPT.length ? SCRIPT[index] : last;
      return entry ?? { say: "(interview complete)", captureDelta: {}, suggestions: [], complete: true };
    },
  };
}
