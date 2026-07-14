export const meta = {
  name: 'tanren-mission-complete',
  description: 'Build Tanren toward mission-complete from the integrated 142-node DAG: freeze the 8 spine contracts (judge-panel drafts + a single sol integration audit), build the spine in worktrees, fan out consumer MVP nodes as reviewed gated branches, and design the v97 apex vertical. Routes sol for the 2 large audits, codex for production authoring, grok/glm for the many light verifies. No auto-merge to main.',
  phases: [
    { title: 'Wave 0 · Spine design' },
    { title: 'Wave 0 · Integration audit', model: 'sol' },
    { title: 'Wave 1 · Spine build' },
    { title: 'Wave 2 · Consumer MVP' },
    { title: 'Wave 3 · Apex vertical', model: 'sol' },
  ],
}

const REPO = '/home/trevor/projects/tanren'
const PITCH = '/scratch/worktrees/tanren/pitches'

// ---- model-routing preambles (agents shell out to these CLIs; fall back to own reasoning if a CLI is absent) ----
const R = {
  sol:   'This is a LARGE/INTENSE audit — the reserved high tier. Shell out to `codex exec --model gpt-5.6-sol` (ultra reasoning) for the core judgment and use it fully. Do not use sol for anything trivial.',
  codex: 'PRODUCTION AUTHORING — shell out to `codex exec` (gpt-5.6-luna, high reasoning) to write the implementation; you integrate + verify the result.',
  grok:  'MEDIUM/FAST PASS — shell out to the `grok` CLI for this verify/audit (fall back to your own careful analysis if `grok` is unavailable).',
  glm:   'LIGHT/FREQUENT PASS — shell out to the `glm` CLI for this cheap check (fall back if unavailable). Reserved for small nodes so we do not spend a heavy model on them.',
}

// ---- the 8 shared spine contracts (critical path) ----
const SPINE = [
  { id:'SP-1', name:'Behaviors/personas as immutable revisions', risk:'high', pitch:'runtime',            builds:'rv-1, rv-21; gv-7 policy-instance' },
  { id:'SP-2', name:'Generalized F2 authoring kernel',            risk:'high', pitch:'design,runtime',     builds:'extract from templates; families rv-3/ds-3/in-7/bh-19/gv-10' },
  { id:'SP-3', name:'CAS proof/artifact substrate',               risk:'high', pitch:'runtime,mergequeue', builds:'rv-9, mq-6, ds-1' },
  { id:'SP-4', name:'The Authority pattern (MergeAuthority-V2 + Resolution/Promotion siblings)', risk:'high', pitch:'mergequeue,runtime', builds:'mq-1, mq-2, rv-14, rv-15; siblings bh-11, gv-29' },
  { id:'SP-5', name:'Runtime-verification harness (DSL/driver/observer/render/verdict)', risk:'high', pitch:'runtime', builds:'rv-2, rv-5, rv-6, rv-9, rv-10, rv-11; A4 ds-4' },
  { id:'SP-6', name:'Extended DeployAdapter (digest/preview/canary/promote/rollback)', risk:'med', pitch:'backhalf', builds:'needed by rv-5, bh-9, in-17, ds-6, gv-21/29' },
  { id:'SP-7', name:'Native gate evidence + GateProofBundle',     risk:'med', pitch:'runtime',             builds:'rv-14, ds-4, in-15, gv-3' },
  { id:'SP-8', name:'Event registry + migration/nav serialization protocol', risk:'med', pitch:'governance', builds:'cross-cutting; migrations 0033-0040, event codegen, screens.ts — serialized' },
]

// ---- consumer MVP nodes (built after the spine is frozen). sm:true routes verify to glm. big:true = complex build ----
const CONSUMER = [
  { b:'mergequeue', id:'mq-3' }, { b:'mergequeue', id:'mq-4' }, { b:'mergequeue', id:'mq-5' }, { b:'mergequeue', id:'mq-11' },
  { b:'runtime', id:'rv-4' }, { b:'runtime', id:'rv-7' }, { b:'runtime', id:'rv-8' }, { b:'runtime', id:'rv-12' }, { b:'runtime', id:'rv-13', big:true },
  { b:'runtime', id:'rv-16' }, { b:'runtime', id:'rv-17' }, { b:'runtime', id:'rv-18' }, { b:'runtime', id:'rv-19' }, { b:'runtime', id:'rv-20', sm:true },
  { b:'runtime', id:'rv-22', big:true }, { b:'runtime', id:'rv-23', big:true }, { b:'runtime', id:'rv-24' }, { b:'runtime', id:'rv-25', sm:true },
  { b:'integrations', id:'in-1', big:true }, { b:'integrations', id:'in-2' }, { b:'integrations', id:'in-3', sm:true }, { b:'integrations', id:'in-4' },
  { b:'integrations', id:'in-5' }, { b:'integrations', id:'in-6' }, { b:'integrations', id:'in-7' }, { b:'integrations', id:'in-8', sm:true },
  { b:'integrations', id:'in-9' }, { b:'integrations', id:'in-10' }, { b:'integrations', id:'in-11', big:true }, { b:'integrations', id:'in-12' },
  { b:'integrations', id:'in-13', big:true }, { b:'integrations', id:'in-14' }, { b:'integrations', id:'in-15' }, { b:'integrations', id:'in-16' },
  { b:'integrations', id:'in-17', big:true }, { b:'integrations', id:'in-18' }, { b:'integrations', id:'in-19', big:true }, { b:'integrations', id:'in-20', big:true },
  { b:'integrations', id:'in-21', big:true }, { b:'integrations', id:'in-22' },
  { b:'backhalf', id:'bh-1', big:true }, { b:'backhalf', id:'bh-2' }, { b:'backhalf', id:'bh-3' }, { b:'backhalf', id:'bh-4', big:true },
  { b:'backhalf', id:'bh-5', big:true }, { b:'backhalf', id:'bh-6', big:true }, { b:'backhalf', id:'bh-7' }, { b:'backhalf', id:'bh-8' },
  { b:'backhalf', id:'bh-9' }, { b:'backhalf', id:'bh-10' }, { b:'backhalf', id:'bh-11', big:true }, { b:'backhalf', id:'bh-12' },
  { b:'backhalf', id:'bh-13' }, { b:'backhalf', id:'bh-14', big:true },
  { b:'design', id:'ds-0', big:true }, { b:'design', id:'ds-1', big:true }, { b:'design', id:'ds-2', big:true }, { b:'design', id:'ds-3', big:true },
  { b:'design', id:'ds-4', big:true }, { b:'design', id:'ds-5', big:true },
  { b:'governance', id:'gv-1', sm:true }, { b:'governance', id:'gv-2' }, { b:'governance', id:'gv-3' }, { b:'governance', id:'gv-4' },
  { b:'governance', id:'gv-5', sm:true }, { b:'governance', id:'gv-6' }, { b:'governance', id:'gv-7', big:true }, { b:'governance', id:'gv-8' },
  { b:'governance', id:'gv-9' }, { b:'governance', id:'gv-10' }, { b:'governance', id:'gv-11' }, { b:'governance', id:'gv-12', big:true },
  { b:'governance', id:'gv-13' }, { b:'governance', id:'gv-14' }, { b:'governance', id:'gv-15', big:true },
]

const CONTRACT_SCHEMA = { type:'object', additionalProperties:false, required:['id','summary','interfaceSketch','dataModel','conformanceOutline','perConsumerBinding','ready'], properties:{
  id:{type:'string'}, summary:{type:'string'}, interfaceSketch:{type:'string', description:'the TS types/interfaces this contract exposes'},
  dataModel:{type:'string', description:'tables/migrations, or none'}, conformanceOutline:{type:'string'},
  perConsumerBinding:{type:'string', description:'how each consuming bucket binds to it'}, openRisks:{type:'array', items:{type:'string'}}, ready:{type:'boolean'} } }
const VERDICT_SCHEMA = { type:'object', additionalProperties:false, required:['verdict','issues'], properties:{ verdict:{enum:['approve','revise']}, issues:{type:'array',items:{type:'string'}}, mustFix:{type:'array',items:{type:'string'}} } }
const AUDIT_SCHEMA = { type:'object', additionalProperties:false, required:['verdict','conflicts','notes'], properties:{ verdict:{enum:['go','no-go']}, conflicts:{type:'array', items:{type:'object', additionalProperties:false, required:['contracts','issue','fix'], properties:{ contracts:{type:'string'}, issue:{type:'string'}, fix:{type:'string'} }}}, sharedTypeAlignment:{type:'string'}, notes:{type:'string'} } }
const BUILD_SCHEMA = { type:'object', additionalProperties:false, required:['node','gate','summary'], properties:{ node:{type:'string'}, branch:{type:'string'}, filesTouched:{type:'array',items:{type:'string'}}, gate:{enum:['green','red','partial','skipped']}, summary:{type:'string'}, notes:{type:'string'} } }
const NODEV_SCHEMA = { type:'object', additionalProperties:false, required:['node','verdict'], properties:{ node:{type:'string'}, verdict:{enum:['pass','fail','concerns']}, findings:{type:'array',items:{type:'string'}} } }

const MIG = { 'SP-1':'0033', 'SP-3':'0034', 'SP-6':'0035', 'SP-5':'0036', 'SP-7':'0037', 'SP-4':'0038', 'SP-8':'0039', 'SP-2':'(code — no migration; fragment-family tables land with each family later)' }

const CLEAN = `CLEAN-REPLACE DOCTRINE — Tanren has NO real users and has barely completed one apex fixture run, so there is NOTHING to preserve. NO backwards compatibility, NO legacy support, NO compatibility facades/aliases, NO dual-run, NO shadow-mode, NO backfill, NO "for legacy rows" nullable columns. Keeping the old path alive beside the new one is COSPLAY — new features that secretly still run the old code — and is FORBIDDEN. REPLACE outright: DELETE the superseded code/types/tables (V1 MergeAuthorityImpl is deleted, not delegated; the old /provision + governance import facades are deleted; any "V2 backfill/cutover" step is dropped — there is nothing to cut over from). Migrations are minimal: ONE clean CREATE per new table in its serialized slot, DROP obsolete tables in the SAME change, never a backfill or a compat view. Migrate every caller to the new contract in the SAME change. A green gate must mean the NEW path runs end-to-end — not that a shim kept the old one alive.`

const RECON = `FROZEN CROSS-CONTRACT RECONCILIATION — from the sol integration audit. These OVERRIDE any single pitch; your contract MUST comply, and the re-audit rejects non-compliance:
1. MIGRATION BAND — a serialized spine-foundation band first, ONE sole schema-owner per migration, foundation tables NEVER FK forward to feature (bucket) tables. Slots: 0033=SP-1(behavior/persona revision tables), 0034=SP-3(cas_artifacts + proof units/edges/bundles), 0035=SP-6(release_instances), 0036=SP-5(behavior_verification_* + design_render_verdicts, thin CAS links), 0037=SP-7(thin gate section/bundle projections), 0038=SP-4(authority_decisions + effect intents), 0039=SP-8(event vocabulary). Feature buckets shift to 0040+. Own tables ⇒ use ONLY your slot, publish full PK/columns/FKs. SP-4's 0038 authority_decisions (NOT the legacy 'merge_authority_decisions' name) + idempotent effect-intent + receipt/reconcile tables use a SCALAR integration_node_id identity column (no forward FK). SP-8's 0039 MUST transactionally SEED the complete current + retained-historical event vocabulary BEFORE adding/validating any event_type FK (never FK to an empty event_types); 0038 must not SQL-depend on 0039's event_types.
2. ONE MERGE AUTHORITY — MergeAuthorityV2 (SP-4) is the SOLE land decision + sole host-land capability; the live V1 MergeAuthorityImpl is DELETED outright (no V1 kept, no delegate, no dual-run). NO new field on AuthorizeLandInput: SP-5 does NOT add runtimeBehaviorOutcome — SP-5 only EMITS evidence, never calls an authority. Resolution/Promotion are siblings that NEVER land code. SP-4 MUST publish engine/contracts/mergeAuthority.ts exporting: GateVerdict='passed'|'failed'|'unknown'; the frozen AuthorizeLandInput (NO runtimeBehaviorOutcome field); LandSubject={kind:'integration_node';id}; a V2 binding envelope OUTSIDE the frozen input (subject + ordered members + exact head + expected-main SHA + artifactDigest:Digest + target); member dispositions admit|exclude|hold|bisect (NO land payload); MergeAuthorityV2 accepting (frozen input, envelope) separately; an INJECTED land-binding revalidator (SP-7 implements, V2 invokes immediately before authorizing — TOCTOU; type-only import to avoid an SP-4↔SP-7 cycle); the SOLE CodeHost.landAuthorizedIntegration idempotent CAS capability; EffectReconcile incl. state_unknown; LandOutcome incl. merge_state_unknown.
3. LAND SUBJECT + EFFECT — the ONLY land-capable subject is {kind:'integration_node', id} bound to ordered members + exact head + expected main SHA + artifact + target. Member verdicts admit/exclude/hold/bisect but carry NO land payload. Git host + Postgres cannot share a txn: use the 4-step protocol — (1) one DB txn persists the immutable decision + idempotent effect intent, (2) external idempotent CAS land, (3) second txn records the receipt, (4) ambiguous ⇒ shared EffectReconcile.state_unknown → LandOutcome.merge_state_unknown. V2 accepts a binding envelope OUTSIDE the frozen V1 input + revalidates it immediately before authorizing (TOCTOU).
4. ONE PROOF SUBSTRATE — SP-3 SOLELY owns proof units/edges, root computation, Ed25519 sealing, verification, byte storage. SP-7's GateProofBundleV2 is a typed PROFILE over SP-3 (four section schemas + required-section plan + canonical ordering + verdict aggregation only) — never a parallel root algo, signature, or byte store. Gate tables are thin FKs to SP-3 rows.
5. PROOF-REUSE KEY — integrationNodes.ts PERMANENTLY owns the FROZEN 6-component bare-hex proofReuseKey + memberKey (the only permanent exceptions to SP-3's domainHash rule; never canonicalized/algo-prefixed/parsed). SP-3 owns every NEW per-unit/V2 digest. SP-5's runtimeBehaviorContextHash():Digest is a versioned-domainHash runtime PROOF-UNIT key component, NEVER a 7th V1-key component.
6. ARTIFACT IDENTITY — canonical release/artifact identity is the SP-3 Digest (sha256:<hex>). SP-6 release_instances.artifact_digest uses it; provider sha512 is a separately-named ProviderChecksum (never a CAS/proof identity). SP-5 writes only link rows (cas_digest FK → cas_artifacts), NO bytes; SP-7 stores bundle bytes THROUGH SP-3. Exactly one byte store (SP-3).`

const TYPES = `CANONICAL SHARED TYPES (from the re-audit — every contract MUST import/use these EXACT forms; never redeclare or re-path them):
- ONE proof/CAS module: services/orchestrator/src/engine/contracts/cas.ts is the SOLE module exporting Digest, ProviderChecksum, ProofUnit / ProofUnitRef / ProofUnitDraft, domainHash, parseDigest, CasByteStore. Every consumer imports from THAT exact specifier — no re-export shims, no ./proofs.js / ./casProof.ts / placeholder paths.
- Digest is a BRANDED type minted only by parseDigest / domainHash / CasByteStore.put; format exactly sha256:<64 lowercase hex>. Every Digest DB column CHECK is ^sha256:[0-9a-f]{64}$ (never a bare +). SP-1 RevisionDigest = Digest (alias the brand; do NOT re-declare a template literal).
- ONE domainHash signature: domainHash(tag: DomainTag, canonicalBody): Digest — 2-arg, no separate version param (fold version into the tag .vN suffix). ONE tag convention: dotted-underscore + version. SP-3's DomainTag registry MUST include exactly the tags SP-1 and SP-5 use: persona_revision.v1, behavior_revision.v1, runtime_behavior_context.v1. SP-5 runtimeBehaviorContextHash = domainHash(runtime_behavior_context.v1, body).
- ProviderChecksum is owned SOLELY by cas.ts (one branded definition, sha512 form). SP-6 IMPORTS it, never redeclares it.
- CAS foreign keys are COMPOSITE: FOREIGN KEY (org_id, <digest_col>) REFERENCES cas_artifacts(org_id, digest) — because cas_artifacts PK is (org_id, digest). SP-6 release_instances.artifact_digest FK is composite.
- GateSectionKind is EXACTLY four: native_ci, runtime_behavior, design_render, artifact_provenance. There is NO integration or a11y section — in-15 integration evidence and a11y evidence map onto artifact_provenance (or native_ci). Adding a kind means bumping RequiredSectionPlan + CANONICAL_SECTION_ORDER, not stray prose. GateSectionKind's SINGLE public module is engine/contracts/gateProof.ts (SP-7-owned) exporting the four values, GATE_SECTION_KINDS, CANONICAL_SECTION_ORDER, RequiredSectionPlan, the four section-body schemas, and the GateVerdict-mapping/aggregation types; gate/gateProofBundle.ts may hold impl but IMPORTS these. SP-5 + all consumers import contracts/gateProof.ts.
- SP-5 writes NO bytes: it submits canonical ProofUnitDrafts to an SP-3-owned ingestion/sealing op (SP-3 alone stores bytes, creates+seals units, returns ProofUnitRef/Digest); SP-5 persists only composite link rows. SP-3 MUST publish the concrete draft-ingestion / bundle-construction / root / seal / verify / persist signatures that SP-5 and SP-7 call.
- SP-3's DomainTag registry is the closed set { persona_revision.v1, behavior_revision.v1, runtime_behavior_context.v1, plan.v1 }; SP-5 plan_hash = domainHash('plan.v1', body). Do NOT add the runtime-context or plan digest as a 7th integrationNodes V1 proofReuseKey component (the frozen 6-component key is untouched).
- SP-7's 0037 gate projection FKs 1:1 (composite, org-scoped) to SP-3's proof_bundles, and each section unit via composite FK to proof_bundle_units — copying no root/signature/bytes.
- SP-5's 0036 evidence link publishes FOREIGN KEY (org_id, cas_digest) REFERENCES cas_artifacts(org_id, digest) DIRECTLY (a transitive proof-unit→CAS link is non-compliant); a separate composite proof-unit FK may coexist.`

const PINS = `FINAL FREEZE PINS (mechanical, from the last audit — obey EXACTLY, these are the last blockers):
- SP-1's module is engine/contracts/behaviorRevision.ts (SINGULAR) and MUST export BehaviorRevisionId + PersonaRevisionId (branded string row-ids, UNIQUE(org_id,id)) alongside RevisionDigest + the domain tags. SP-5/6/7 import from './behaviorRevision.js' — NEVER a plural './behaviorRevisions.js' specifier.
- SP-4's LandBindingEnvelope MUST include a readonly subject: LandSubject field (outside the frozen AuthorizeLandInput, which keeps its own subject); the injected revalidator asserts envelope.subject deep-equals input.subject before authorizing.
- The SOLE host-land method is CodeHost.landAuthorizedIntegration on the EXISTING CodeHost contract (DELETE the old landAuthorizedRef) — NOT a separate CodeHostLandCapability type. mq imports exactly CodeHost.landAuthorizedIntegration.
- SP-7's 0037 gate_proof_bundles stores NO root_digest / signature / bytes — ONLY the composite 1:1 FK (org_id, proof_bundle_id) -> proof_bundles(org_id, id); the root is obtained by join.
- gateProof.ts exports, per section, BOTH a schema value and an inferred type: export const <Section>BodySchema = z.object(...).strict(); export type <Section>Body = z.infer<typeof <Section>BodySchema> (all four sections). Consumers import the inferred TYPE; SP-3 ingestion validates against the schema VALUE.
- The composite cas_artifacts FK applies ONLY to columns referencing STORED bytes (CAS artifacts / proof-unit payloads / evidence). Semantic-only domainHash keys (persona/behavior-revision, plan, runtime-context digests) are NOT stored bytes and do NOT FK to cas_artifacts.
- SP-6's 0035 MUST publish the release<->behavior_revision binding: a junction release_instance_behavior_revisions(org_id, release_instance_id, behavior_revision_id) with composite FKs to release_instances and behavior_revisions(org_id, id).`

function designPrompt(c){
  return `${R.codex}
You are the SUPERVISING engineer FREEZING shared spine contract ${c.id}: "${c.name}" for Tanren (repo ${REPO}), built by [${c.builds}] and consumed across buckets. Read ${PITCH}/pitch-${c.pitch.split(',')[0]}.final.md (and siblings if listed) plus the real code it touches. Drive codex to author the contract — but YOU OWN CORRECTNESS: after EACH codex pass, VALIDATE its output yourself. Every field must be real, complete, and compliant (NEVER a stub / placeholder / "test"); the exact TS types, migration DDL, conformance outline, and per-consumer bindings must actually satisfy RECON + CLEAN + TYPES and match the real code paths. If ANYTHING is missing, stubbed, wrong, or non-compliant, shell BACK OUT to codex with the SPECIFIC gaps and have it fix them, then re-validate — REPEAT until the contract is ACTUALLY complete and correct. Never accept or pass through junk; the final contract is YOUR responsibility, not codex's.
${RECON}
${CLEAN}
${TYPES}
${PINS}
NOTE: the pitch-*.final.md files PREDATE this reconciliation — read them for domain/behavior detail ONLY; RECON, CLEAN, and TYPES OVERRIDE any conflicting pitch prose (competing stores, compat facades, extra authority fields, stale migration slots, etc.). Do not import pre-reconciliation drift.
Your assigned migration slot: ${MIG[c.id]||'(none)'}.
Deliver the FROZEN contract that COMPLIES with the reconciliation above — an interface freeze, NOT an implementation: the exact TypeScript types/interfaces it exposes, its data-model (your assigned migration only, full PK/columns/FKs), a conformance-suite outline, and precisely how each consuming bucket binds to it. Name any residual risk. Keep it tight but COMPLETE. A stub, placeholder, empty, or "test" value in ANY field is a FAILURE — do the full work. Your ONLY deliverable is the COMPLETE structured contract object — FINISH by returning it via the structured output tool.`
}
function reviewPrompt(c, d){
  return `Adversarially review the FROZEN spine contract ${c.id} "${c.name}" below, as the engineer who has to build a consumer against it. ${c.risk==='high'?R.grok:R.glm}
Contract: ${JSON.stringify(d).slice(0, 6000)}
Would this let ${c.builds} build in parallel without a competing-authority or duplicate-store problem? Flag anything underspecified, any type that won't compose with siblings, any migration ordering hazard. Return approve only if a consumer could start building against it as-is.`
}
function integAuditPrompt(designs){
  const bundle = designs.filter(Boolean).map(d => `### ${d.contract.id} ${d.contract.name}\n${d.summary}\nINTERFACE: ${(d.interfaceSketch||'').slice(0,1300)}\nDATA-MODEL: ${(d.dataModel||'').slice(0,500)}\nBINDINGS: ${(d.perConsumerBinding||'').slice(0,800)}`).join('\n\n')
  return `${R.sol}
You are the INTEGRATION AUDITOR for Tanren's 8 spine contracts — a RE-AUDIT after the frozen reconciliation was applied. This gate decides whether the 142-node build proceeds; if these 8 don't compose, everything builds on sand. Read ${PITCH}/tanren-integrated-plan.html for the seams.
THE FROZEN RECONCILIATION + CANONICAL TYPES + FINAL PINS these contracts MUST obey:\n${RECON}\n${TYPES}\n${PINS}
THE 8 CONTRACTS AS RE-DESIGNED:\n${bundle}
Verify each reconciliation rule 1-6 is ACTUALLY honored AND the contracts compose: no competing authority (SP-4 sole, V1 DELETED not delegated; SP-5 emits-only; Resolution/Promotion never land), no compat facade / dual-run / backfill / legacy-preserving migration anywhere, one proof + one byte substrate (SP-3; SP-7 a profile over it), one serialized migration band with no forward FK, the frozen 6-component proof-reuse key intact, one artifact identity (SP-3 sha256), aligned shared types. Return go ONLY if all 6 rules hold and a consumer could build against every contract as-is; else no-go with the exact remaining conflicts + fixes.`
}
function buildPrompt(kind, c){
  const isSpine = kind === 'spine'
  const ref = isSpine ? `spine contract ${c.id} "${c.name}" (${PITCH}/pitch-${c.pitch.split(',')[0]}.final.md)` : `node ${c.id} of the ${c.b} bucket (find it in ${PITCH}/pitch-${c.b}.final.md)`
  return `${R.codex}
Build ${ref} into Tanren. You are in an ISOLATED WORKTREE off the latest origin/main. ${isSpine?'The 8 spine contracts were just frozen + integration-audited — implement THIS contract to its frozen interface + conformance suite.':'The spine contracts are FROZEN + MERGED to main — build against them, do not re-invent them.'}
${CLEAN}
YOU OWN CORRECTNESS: drive codex to author, but after each codex pass VALIDATE it YOURSELF — does it actually compile, does the gate GENUINELY pass, does it really implement the node with the deletions (no stub, no fake-green)? If not, shell BACK to codex with the specific failures and REPEAT until it is genuinely green. Never fake green or pass through unverified codex output. Read the pitch spec for full data-model/validation/HTTP/UI/apex-proof detail. Implement the code + conformance/unit tests + your migration (${isSpine?'your assigned spine slot':'next free feature slot 0040+'}; clean CREATE + DROP-old-outright, NO backfill/compat). DELETE every superseded code path this replaces. Files under 500 lines, org-scoped RLS on tenant tables, adapters-behind-contracts. Run the gate: \`just affected-typecheck\` + \`just affected-test\` (\`just fast-check\` if broad); do NOT run the full slow suite unless small.
THEN PUBLISH FOR REVIEW: commit to a descriptive branch, \`git push -u origin <branch>\`, and open a PR to main — \`gh pr create --repo cat-cave/tanren --base main --title "${isSpine?'spine/'+c.id:c.b+'/'+c.id}: <concise>" --body "<what + why, the node it implements, the clean-replace deletions>"\` (use the repo's commit trailers). DO NOT MERGE — that is the human review gate. Report the branch, the PR URL, files touched, deletions made, and an HONEST gate status (green/red/partial). Never fake green.`
}
function verifyPrompt(c){
  const tier = c.sm ? R.glm : R.grok
  return `${tier}
Adversarially verify the freshly-built node ${c.id} (${c.b} bucket) against its pitch spec's validation column in ${PITCH}/pitch-${c.b}.final.md. Check: does it implement the node's real behavior (not a stub), pass its own conformance/negative-control tests, honor org-scoped RLS, and avoid a competing-authority/duplicate-store violation of the spine? Return pass only if a reviewer would merge it; concerns/fail with specific findings otherwise.`
}

// ---- phase dispatch: default 'spine' (design→audit→build→PR, then STOP for merge); 'consumers' fans out AFTER the spine is merged to main ----
const PHASE = (args && args.phase) || 'spine'

if (PHASE === 'consumers') {
  phase('Wave 2 · Consumer MVP')
  log(`Spine is merged to main — fanning out ${CONSUMER.length} consumer MVP nodes (build→push PR→verify, worktrees off origin/main). Long wave.`)
  const consumerBuilt = await pipeline(CONSUMER,
    n => agent(buildPrompt('consumer', n), { label:`build:${n.id}`, phase:'Wave 2 · Consumer MVP', isolation:'worktree', schema: BUILD_SCHEMA }),
    (b, n) => b ? agent(verifyPrompt(n), { label:`verify:${n.id}`, phase:'Wave 2 · Consumer MVP', schema: NODEV_SCHEMA }).then(v => ({ ...b, node:n.id, bucket:n.b, verify:v })) : null,
  )
  const consGreen = consumerBuilt.filter(x => x && x.gate === 'green' && x.verify && x.verify.verdict === 'pass')
  log(`Consumer MVP: ${consGreen.length}/${CONSUMER.length} green+verified PRs opened against main.`)

  phase('Wave 3 · Apex vertical')
  const apex = await agent(`${R.sol}
Design the v97 whole-architecture APEX vertical that proves the freshly-built engine: notes → build → deploy → the 100-click→100-Slack-message + rendered-confirmation POSITIVE run, plus the negative controls (assertion sensitivity, queue member-bisection, cosmetic-fix blocked by post-deploy symptom verification, cross-tenant denied, proof-replay rejected). Exercise the spine live (behavior revisions → executable tests → gate → MergeAuthorityV2 → deploy → per-behavior demo → post-deploy re-proof) over ONLY the public HTTP + dashboard surfaces. Read ${PITCH}/tanren-integrated-plan.html §apex-proof and rv-26. Output the concrete apex run spec: fixture notes, the exact events to assert, the negative-control matrix, and the go/no-go acceptance. This is the acceptance test for the whole program.`, { label:'sol:apex-design', phase:'Wave 3 · Apex vertical', effort:'high' })
  log('CONSUMER PHASE COMPLETE — consumer MVP PRs opened against main; apex vertical designed. Review + merge the PRs.')
  return { phase:'consumers', consumer:{ total:CONSUMER.length, greenVerified:consGreen.length, prs:consumerBuilt.filter(Boolean) }, apexSpec:apex }
}

// ================= PHASE 'spine' — Wave 0 design → audit → Wave 1 build+PR → STOP for merge =================
phase('Wave 0 · Spine design')
log(`Freezing ${SPINE.length} spine contracts under the reconciliation + clean-replace doctrine (codex authoring + adversarial review each), then a re-audit gate.`)
const isStub = d => !d || !d.interfaceSketch || d.interfaceSketch.length < 220 || /^\s*(test|todo|placeholder|n\/a)\s*$/i.test(String(d.interfaceSketch).trim())
const designs = await pipeline(SPINE,
  c => agent(designPrompt(c), { label:`design:${c.id}`, phase:'Wave 0 · Spine design', schema: CONTRACT_SCHEMA }).then(d =>
        isStub(d)
          ? agent(designPrompt(c) + '\n\nYOUR PRIOR ATTEMPT RETURNED A STUB/PLACEHOLDER. This is the linchpin — produce the FULL, real contract with a substantial concrete interface, data-model DDL, conformance outline, and per-consumer bindings. No stubs.', { label:`design-retry:${c.id}`, phase:'Wave 0 · Spine design', schema: CONTRACT_SCHEMA, effort:'high' }).then(d2 => isStub(d2) ? null : { ...d2, contract:c })
          : { ...d, contract:c }),
  (d, c) => d ? agent(reviewPrompt(c, d), { label:`review:${c.id}`, phase:'Wave 0 · Spine design', schema: VERDICT_SCHEMA }).then(v => ({ ...d, review:v })) : null,
)
const goodDesigns = designs.filter(Boolean)
log(`Spine drafted: ${goodDesigns.length}/${SPINE.length}; ${goodDesigns.filter(d=>d.review&&d.review.verdict==='approve').length} approved on first review.`)

phase('Wave 0 · Integration audit')
const audit = await agent(integAuditPrompt(goodDesigns), { label:'sol:integration-audit', phase:'Wave 0 · Integration audit', effort:'high', schema: AUDIT_SCHEMA })
log(`INTEGRATION AUDIT: ${audit ? audit.verdict.toUpperCase() : 'ERROR'} — ${audit ? audit.conflicts.length : '?'} conflicts.`)
if (!audit || audit.verdict === 'no-go') {
  log('Spine did NOT compose — STOPPING before build. Fold the conflicts into RECON and re-run. Conflicts: ' + (audit ? JSON.stringify(audit.conflicts) : 'audit failed'))
  return { stoppedAt:'integration-audit', audit, designs: goodDesigns }
}

phase('Wave 1 · Spine build')
log('Spine composes — building the 8 contracts in worktrees, each pushed as a PR to main (clean-replace: old code/tables deleted; NO merge).')
const spineBuilt = await parallel(SPINE.map(c => () =>
  agent(buildPrompt('spine', c), { label:`build:${c.id}`, phase:'Wave 1 · Spine build', isolation:'worktree', schema: BUILD_SCHEMA })
    .then(b => b ? agent(verifyPrompt({ id:c.id, b:c.pitch.split(',')[0] }), { label:`verify:${c.id}`, phase:'Wave 1 · Spine build', schema: NODEV_SCHEMA }).then(v => ({ ...b, verify:v })) : null)
))
const spineGreen = spineBuilt.filter(x => x && x.gate === 'green' && x.verify && x.verify.verdict === 'pass')
log(`Spine build: ${spineGreen.length}/${SPINE.length} green+verified PRs opened against main. STOPPING for human merge before the consumer fan-out.`)
return { stoppedAt:'spine-prs-open', audit, spine:{ total:SPINE.length, greenVerified:spineGreen.length, prs:spineBuilt.filter(Boolean) }, note:'Review + merge the 8 spine PRs to main in migration-slot order (they co-touch core files + delete V1 — serialize the merge, resolve deletions), then relaunch this workflow with args {phase:"consumers"} for the fan-out.' }
