# MILESTONE5_DESIGN_v2.md — Auditable multi-agent review system (Claim Ledger + Human Gate)

Design-only document for Phase 2A Milestone 5. **No production TypeScript is changed by
this document.** This revision supersedes `MILESTONE5_DESIGN.md` (v1) after an independent
senior-architect review identified four BLOCKING and six MEDIUM risks in v1. It builds on
the frozen Milestone 4A fixed-round loop and the frozen Milestone 4B convergence-driven
loop, subject to one narrowly-scoped, explicitly-reviewed refinement of what "frozen"
means (§9.1) — required to satisfy the architect review's mandatory change 3, and called
out precisely so it is never mistaken for silent scope creep.

---

## Revision history

**v2 (this revision) — applied all eight mandatory changes from the architect review of
v1, before any implementation:**

1. **Decision Engine fully specified.** v1 gave only a `DecisionRecommendation` data shape
   with no algorithm — "deterministic" was asserted about an undefined function. v2 adds a
   complete, worked-example decision rule with explicit default thresholds (§8), matching
   the rigor `MILESTONE4B_DESIGN.md` §8 established for the convergence engine. Closes
   BLOCKING #1.
2. **`hardMaxRounds` restored as genuinely unoverridable.** v1's round budget was advisory
   only ("the human is the one who must actually stop it"), removing 4B's hard safety
   ceiling. v2 adds two-layer enforcement — gate-level input restriction plus independent
   orchestrator-level validation — so no sequence of `CONTINUE` responses, human or
   scripted, can exceed it (§7.5). Closes BLOCKING #2.
3. **Severity rules extracted into a shared pure module, not duplicated.** v1 implied
   `objectionLedger.ts`'s severity-floor/downgrade-rejection logic would be "reused
   unchanged" while simultaneously declaring that file byte-for-byte frozen — those two
   claims cannot both be true, since the relevant functions aren't exported. v2 designs a
   new `src/orchestration/shared/severityRules.ts` and a scoped, behavior-preserving
   migration plan, with the freeze policy restated precisely as a *behavioral/contract*
   freeze (verified by the unmodified existing test suite) rather than a literal
   never-touch-the-bytes rule (§4.5, §9.1). Closes BLOCKING #3.
4. **`HumanGatePresentation` now carries resolved `Evidence` records**, not bare ids, plus
   a `legalOutcomes` field enforcing item 2 above (§7.2). Closes BLOCKING #4.
5. **Evidence Agent phased out of the initial cut.** Milestone 5 is now split into **5A**
   (Claim Ledger + Decision Engine + Human Gate; evidence is a data layer only — structural
   resolution evidence and human-supplied evidence, no live LLM elicitation) and **5B**
   (adds the on-demand Evidence Agent turn once 5A is proven in real use). Addresses
   MEDIUM #1 and #2 (unbounded per-round evidence fan-out is now out of scope for the
   phase actually being designed for implementation next).
6. **`schemaVersion` added** to every independently-persistable container type, with an
   explicit rule for which nested types do and don't need their own tag (§12.1). Addresses
   MEDIUM #4.
7. **`FakeHumanGate` isolation rules defined explicitly** — file location constraint,
   single-export production factory, and a new isolation test (§7.6). Addresses MEDIUM #5.
8. **Generator revision-prompt adaptation designed explicitly.** v1 claimed reuse of
   `buildConvergenceChatGptRevisionPrompt`, which doesn't type-check against
   `ClaimLedgerEntry[]`. v2 designs a new, purpose-built `buildClaimReviewRevisionPrompt`
   (§13.1) that also surfaces confidence/dispute context the Generator never had access to
   in 4B. Addresses MEDIUM #3.

As a direct consequence of #1, `DecisionRecommendation.disputedCount`/`averageConfidence`
now have a defined role in the decision rule (§8), closing MEDIUM #6. As a direct
consequence of #5, the per-round evidence fan-out cap (MEDIUM #2) is deferred to 5B's own
scope rather than needing a cap in a mechanism that no longer exists in the phase being
specified for near-term implementation (§6.4).

Everything not named above (overall goal, architecture direction, most field names, the
2-adapter/no-new-browser-code principle) is unchanged from v1's reasoning and is restated
below so this document is self-contained.

---

## 0. Inspection summary

Same repository inspection as v1 (current file tree, `TODO.md`, `DECISIONS.md`,
`REVIEW.md`, all of `src/orchestration/`), plus the independent architect review of v1
itself, whose four BLOCKING and six MEDIUM findings are the direct input to every change
listed above. Key re-confirmed facts from v1 §0 still hold: Milestone 4B is complete and
real-browser-verified (`DECISIONS.md` §11f), the convergence engine is pure and
browser-agnostic, two conversational participants exist via `ConversationalSiteAdapter`,
the objection ledger has no evidence concept, there is no human-in-the-loop point in 4A/4B,
and persistence is explicitly and repeatedly deferred.

**Newly confirmed during this revision, directly relevant to mandatory change 3:**
`src/orchestration/convergence/objectionLedger.ts` exports exactly `severityRank`,
`InvalidLedgerIngestError`, `createEmptyLedger`, `cloneLedger`, `countsForLedger`,
`ingestReview`, `ingestStructuredReview`. Its severity-floor/downgrade-rejection helpers
(`adjust`, `reopen`) are private, unexported functions. This confirms the architect
review's finding exactly: as the file stands today, nothing outside `objectionLedger.ts`
can import that logic, so v1's implied reuse was not achievable without either the
migration designed in §9.1 or undisclosed duplication.

---

## 1. Goal / Non-goals

**Goal:** evolve the two-party ChatGPT ⇄ Claude convergence loop into an **auditable
multi-role review system**, delivered in two sub-phases:

- **Milestone 5A** (specified in full detail here, intended as the next implementation
  target): a richer Claim Ledger (claims, evidence references, a continuous confidence
  signal), a fully-specified deterministic Decision Engine, and a mandatory, unoverridable
  **human decision gate**. Evidence in 5A is a **data layer** — claims can carry evidence
  references and confidence, but evidence is populated only from structurally-required
  resolution evidence and from evidence a human explicitly attaches at the gate. No new
  LLM prompt/parse contract for evidence exists in 5A.
- **Milestone 5B** (named and scoped, not designed to implementation-detail here): adds
  the live, on-demand Evidence Agent turn (§6.4) once 5A's ledger/gate mechanics are
  proven against real runs.

**Non-goals (5A, unless noted 5B):**

- **No changes to Milestone 4A or 4B's observable behavior or public contracts**,
  verified by the full existing test suite passing unmodified (§9.1 states precisely what
  "frozen" now means, given mandatory change 3).
- **No browser/adapter changes of any kind.** `chatgptSite.ts`, `claudeSite.ts`,
  `claudeUserTurns.ts`, `domUtil.ts`, `discoverSitePages.ts`, `siteTypes.ts`, any selector
  file — all untouched. No new site adapter, no third browser tab, no new CDP target.
- **No live Evidence Agent elicitation in 5A** (deferred to 5B, §6.4, §16.1).
- **No automatic human-gate bypass, simulation, or timeout-based auto-decision** in
  production code, and — new in v2 — **no way to exceed `hardMaxRounds` regardless of
  gate responses** (§7.5).
- **No persistence/disk writes** in 5A. The data model remains JSON-serializable and now
  schema-versioned (§12.1), but 5A does not write `runs/<run-id>/` or any file to disk.
- **No LLM-backed Decision Agent.** Fully specified as deterministic in §8.
- **No change to `config/loadConfig.ts` or `config/config.json`.** New tunables
  (`hardMaxRounds`, `resolutionConfidenceThreshold`, etc.) stay call parameters with
  defaults, matching 4A/4B's precedent.

---

## 2. Current state recap (frozen foundation)

Unchanged from v1:

```
runFixedReviewLoop.ts            — Milestone 4A: fixed G0→C1→G1→...→C(n)→G(n)
runConvergenceReviewLoop.ts      — Milestone 4B: G0→C1→G1→C2→... until CONVERGED /
                                    MAX_ROUNDS_REACHED / INVALID_REVIEW
  convergence/convergencePrompts.ts     — pure prompt builders
  convergence/structuredReviewParser.ts — pure text → StructuredClaudeReview | Invalid
  convergence/objectionLedger.ts        — pure ledger create/ingest (severity-floor logic
                                           to be extracted per §9.1, behavior unchanged)
  convergence/fingerprint.ts            — pure normalization + Dice-coefficient similarity
  convergence/convergenceEngine.ts      — pure decision function
```

---

## 3. Architecture evolution

### 3.1 Current (Milestone 4B) architecture

Unchanged from v1 — see `MILESTONE5_DESIGN.md` §3.1 for the diagram; no changes needed
here.

### 3.2 Future (Milestone 5A) architecture

```
                 ┌───────────────────────────────────┐
 originalTask →  │  runAuditedReviewLoop.ts           │ → AuditedReviewResult
                 │  (sole Page/adapter/gate caller)   │    (schemaVersion, outcome,
                 └──┬──────────┬──────────┬────────┬──┘     finalAnswer, claimLedger,
                    │calls     │calls     │calls    │calls   evidenceLog, auditTrail, …)
     ┌──────────────┴─┐ ┌──────┴──────┐ ┌─┴───────┐ ┌┴────────────────────┐
     │ shared/         │ │ claims/*    │ │convergence/*│ │ humanGate/*          │
     │ severityRules.ts│ │ claimLedger │ │ (behavior-  │ │ HumanGate interface  │
     │ (NEW — reused by│ │ decisionAgent│ │  frozen,    │ │ + createTerminal-    │
     │  BOTH ledgers,  │ │ claimPrompts│ │  §9.1       │ │   HumanGate() (real, │
     │  §4.5, §9.1)    │ │ (new pure)  │ │  migration) │ │   only prod export)  │
     └────────┬────────┘ └─────────────┘ └─────────────┘ │ FakeHumanGate —      │
              │ imported by both                          │ tests/ ONLY, never  │
     ┌────────┴────────┐                                  │ exported from src/  │
     │ objectionLedger  │  (4B, migrated to import        │ (§7.6)              │
     │ .ts (4B, import  │   severityRules.ts internally;  └─────────────────────┘
     │  added, behavior │   external contract identical)
     │  unchanged)      │
     └─────────────────┘
     ChatGPT tab (Generator)  ⇄  Claude tab (Reviewer)
     — same two adapters, same ConversationalSiteAdapter contract, NO new browser code —
     — plus a synchronous, blocking, UNOVERRIDABLE-at-hardMaxRounds HUMAN GATE
     — Evidence Agent (a THIRD prompt kind against these same two adapters) is 5B, not 5A
```

The role/adapter-binding table from v1 §3.2 is unchanged (Generator→ChatGPT adapter,
Reviewer→Claude adapter, no new browser code for either); the Evidence Agent row is now
annotated "5B" throughout this document rather than implemented alongside 5A.

---

## 4. Claim Ledger enhancement

### 4.1 Field-by-field evolution table (updated: severity-rule reuse row corrected)

| Current (`ObjectionLedgerEntry`) | Future (`ClaimLedgerEntry`, new `claims/types.ts`) | What changed and why |
|---|---|---|
| `id: string` (`OBJ-<n>`) | `id: string` (`CLAIM-<n>`) | Renamed prefix only; same engine-assigned, monotonic, never-reused identity rule. |
| `severity` | `severity` (unchanged type) **plus** `confidence: number` (`0.0`–`1.0`) | Orthogonal axes: severity = "how blocking if true," confidence = "how sure we are it's true" (§4.2, unchanged from v1). |
| `status: ObjectionStatus` | `status: ClaimStatus` (`OPEN`\|`DISPUTED`\|`RESOLVED`\|`REJECTED`) | Unchanged from v1 (§4.3). |
| `summary`/`reason` | `claim: { statement, rationale }` | Renamed only, unchanged from v1. |
| *(none)* | `evidenceFor`/`evidenceAgainst: EvidenceRef[]` | New (§6). |
| *(none)* | `confidenceHistory: ConfidenceChangeEvent[]` | New (§4.2). |
| `highestSeveritySeen` | `highestSeveritySeen` (unchanged) | **Corrected in v2:** the floor arithmetic itself is now computed by the shared `reopenSeverityFloor()` function in `shared/severityRules.ts` (§4.5, §9.1), imported by `claimLedger.ts` — not "reused unchanged from 4B" as v1 vaguely claimed, but genuinely shared via a common pure module both ledgers call. |
| `normalizedFingerprint` | unchanged | Reused by direct import of `convergence/fingerprint.ts`, exactly as v1 designed — this reuse path was already sound (`fingerprint.ts`'s functions are already exported and take injectable thresholds) and required no correction. |
| `history` | `history: ClaimHistoryEvent[]` | Superset of 4B's event kinds plus `EVIDENCE_ADDED`, `CONFIDENCE_CHANGED`, `DISPUTED`, `UNDISPUTED`, `HUMAN_DECISION_RECORDED` — unchanged from v1. |

### 4.2 Confidence (unchanged from v1)

See `MILESTONE5_DESIGN.md` §4.2 — the three invariants (boundedness, symmetry, no-silent-
overwrite) are unchanged and still required, each with a corresponding unit test (§15.1).

### 4.3 The `DISPUTED` status band (unchanged from v1)

See `MILESTONE5_DESIGN.md` §4.3 — unchanged.

### 4.4 Resolution history (unchanged from v1)

See `MILESTONE5_DESIGN.md` §4.4 — unchanged: a `RESOLVED`/`REJECTED` event must carry a
`resolutionEvidenceRef`.

### 4.5 Severity rules now come from a shared module, not a vague "reused unchanged" claim

`ClaimLedgerEntry.severity`/`highestSeveritySeen` are governed by exactly the same
escalation-always-allowed / downgrade-rejected / reopen-floors-at-peak rules 4B proved
correct (`MILESTONE4B_DESIGN.md` §6.6) — but in v2, `claimLedger.ts`'s ingest logic calls
`adjustSeverity()`/`reopenSeverityFloor()` from the new `src/orchestration/shared/
severityRules.ts` (§9.1) rather than reimplementing that arithmetic. This is what makes
the table row above true instead of aspirational.

---

## 5. Evidence tracking system (5A scope: data layer only)

### 5.1 `Evidence` — a first-class, independently addressable record (unchanged shape from v1)

```ts
// design sketch — src/orchestration/claims/types.ts (new module)
export type EvidenceKind = "SUPPORTING" | "CHALLENGING" | "RESOLUTION";
export type EvidenceStrength = "STRONG" | "MODERATE" | "WEAK";
export type EvidenceSourceRole = "GENERATOR" | "REVIEWER" | "EVIDENCE_AGENT" | "HUMAN";
//                                                          ^^^^^^^^^^^^^^^ 5B only in
//                                                          practice for 5A — see §5.3

export interface Evidence {
  id: string; claimId: string; kind: EvidenceKind; strength: EvidenceStrength;
  sourceRole: EvidenceSourceRole; text: string; round: number; submittedAt: string;
  supersedesEvidenceId?: string;
}

export type EvidenceRef = string; // an Evidence.id
```

Evidence remains append-only and immutable once created (unchanged rationale from v1
§5.1).

### 5.2 What each claim supports (unchanged mapping from v1 §5.2)

The task's five bullet points (original claim, source/evidence, reviewer challenge,
resolution evidence, confidence changes) map exactly as v1 designed — this mapping did not
need correction. The one change is **where evidence comes from in 5A** (§5.3 below), not
what a claim tracks about it.

### 5.3 Evidence sources in 5A (data layer only — no live elicitation)

In 5A, `Evidence` records are created only by:

1. **Structural resolution evidence** — when the Reviewer's structured response resolves a
   claim (`resolvedObjectionIds`-equivalent), the required, already-present resolution
   text (4B's `resolutionEvidence` map, carried forward per §4.4) is turned directly into
   an `Evidence` record of `kind: "RESOLUTION"`, `sourceRole: "REVIEWER"` — this requires
   **no new prompt or turn**, since the Reviewer already produces this text in its normal
   review response.
2. **Human-supplied evidence at the gate** — the real terminal `HumanGate` implementation
   (§7.3) optionally accepts a free-text evidence submission from the human for any
   presented claim (`kind`/`strength` chosen by the human), recorded with `sourceRole:
   "HUMAN"`. This is what gives `evidenceFor`/`evidenceAgainst`/`confidence` genuine,
   exercised behavior in 5A even without a live Evidence Agent: a human who disagrees with
   a claim's current confidence can attach counter-evidence on the spot, and the next
   round's confidence recomputation (§4.2) reflects it immediately.

No `EvidenceSourceRole: "EVIDENCE_AGENT"` record can be created in 5A — the type value
exists now (so 5B is additive, not a breaking schema change) but nothing in 5A's code path
produces one.

### 5.4 Evidence Agent (5B — named, not designed to implementation detail)

5B adds a new prompt kind (`buildEvidenceRequestPrompt`, sentinel-JSON grammar
`BEGIN_EVIDENCE_RESPONSE`/`END_EVIDENCE_RESPONSE`) fired on-demand against one of the two
existing adapters, exactly as v1 §5.3 sketched. Two items v1 left unresolved are deferred
to 5B's own design pass, not solved here: **(a)** the per-round fan-out cap (a
`maxEvidenceRequestsPerRound` default, plus the round-latency budget impact of N
sequential adapter turns before the human reaches the gate), and **(b)** which adapter is
the default elicitation target per claim. Deferring both to 5B is itself the direct
response to the architect review's recommendation to phase risk rather than solve it
prematurely.

---

## 6. Human decision gate

### 6.1 Placement in the lifecycle (unchanged shape from v1, with hardMaxRounds enforcement added — see §7.5)

```
   AI review (Generator + Reviewer; evidence bookkeeping per §5.3 — no live Evidence
              Agent turn in 5A)
                              ↓
   Decision Engine computes a RECOMMENDATION only (§8) — fully specified, not just shaped
                              ↓
   ════ HUMAN DECISION GATE (blocking, mandatory, every round, hardMaxRounds-enforced) ════
   Presented: claim ledger delta, disputed claims, RESOLVED evidence for both, the
   recommendation + reason, the current answer, and which outcomes are legal this round
                              ↓
        CONTINUE (if legal)          ACCEPT                    REJECT
```

### 6.2 Gate contract (updated: resolved evidence + legal-outcomes fields)

```ts
// design sketch — src/orchestration/humanGate/humanGate.ts (new module)
export type HumanGateOutcome = "CONTINUE" | "ACCEPT" | "REJECT";

export interface HumanGatePresentation {
  round: number;
  currentAnswer: string;
  recommendation: DecisionRecommendation;         // §8
  disputedClaims: ClaimLedgerEntry[];
  claimLedgerDelta: ClaimLedgerEntry[];
  relevantEvidence: Evidence[];                   // NEW (mandatory change 4) — every
                                                    // Evidence record referenced by any
                                                    // claim in disputedClaims or
                                                    // claimLedgerDelta, resolved in full
                                                    // (not just ids). Scoped to keep the
                                                    // payload bounded; the run's complete
                                                    // evidenceLog remains in the final
                                                    // AuditedReviewResult (§12) for
                                                    // full post-hoc audit.
  legalOutcomes: HumanGateOutcome[];               // NEW (mandatory change 2) — computed
                                                    // by the orchestrator, never by the
                                                    // gate: ["ACCEPT","REJECT"] once
                                                    // round >= hardMaxRounds, else
                                                    // ["CONTINUE","ACCEPT","REJECT"]
}

export interface HumanGateResponse {
  schemaVersion: number;    // NEW (mandatory change 6) — see §12.1
  outcome: HumanGateOutcome;
  rationale?: string;       // REQUIRED when outcome === "REJECT"
  decidedAt: string;
}

export interface HumanGate {
  presentAndAwaitDecision(presentation: HumanGatePresentation): Promise<HumanGateResponse>;
}
```

### 6.3 Production implementation: blocking terminal prompt (updated)

Unchanged core mechanism from v1 (blocks on terminal input, mirrors Phase 1's login-wait
ENTER flow) with two additions:

- Renders `relevantEvidence` inline, joined by id against `disputedClaims`/
  `claimLedgerDelta`, so the human actually sees supporting/challenging text, not opaque
  ids — this is the direct fix for BLOCKING #4.
- Only accepts an outcome token present in `presentation.legalOutcomes` — if the human
  types `continue` while `legalOutcomes` is `["ACCEPT","REJECT"]` (i.e., `round >=
  hardMaxRounds`), the prompt explicitly explains why `continue` is not accepted this
  round and re-prompts. This is enforcement Layer 1 of §7.5.

### 6.4 Evidence attachment at the gate (5A's evidence-input mechanism, §5.3 point 2)

The terminal implementation offers an optional "attach evidence" step before the human
commits to an outcome: for any claim in `disputedClaims`/`claimLedgerDelta`, the human may
submit free text plus a `kind`/`strength`, which the orchestrator turns into a
`sourceRole: "HUMAN"` `Evidence` record and ingests (confidence recompute, `DISPUTED`
reclassification, §4.2/§4.3) **before** finalizing that round's `HumanGateResponse`. This
keeps the "attach evidence, see its effect, then decide" flow inside one gate interaction
rather than requiring an extra round just to record a human's counter-evidence.

### 6.5 hardMaxRounds enforcement — two independent layers (mandatory change 2, BLOCKING #2 fix)

**Layer 1 — gate-level input restriction (§6.3):** the real terminal implementation will
not submit a `CONTINUE` outcome when `legalOutcomes` excludes it.

**Layer 2 — orchestrator-level validation, independent of any `HumanGate` implementation:**
`runAuditedReviewLoop.ts` itself checks, after receiving *any* `HumanGateResponse` (from
the real gate, a future custom gate, or — in tests only — a fake), whether
`response.outcome === "CONTINUE"` while `round >= hardMaxRounds`. If so, the orchestrator
**does not honor it** — it forces `outcome := "REJECTED"` with a system-authored
rationale (`"hardMaxRounds (<n>) reached; a CONTINUE response past the ceiling was not
honored"`), records a distinguishing history event showing "the gate returned X, the
engine enforced Y," and stops. No further Generator/Reviewer turns are sent.

This is deliberate defense-in-depth: Layer 1 makes the *intended* real-world experience
correct (a human is never even offered the illegal choice); Layer 2 makes the *safety
property* independent of trusting any particular `HumanGate` implementation to behave —
including a hypothetical future implementation this design didn't anticipate, or a
scripted/fake gate accidentally reaching a production code path. `hardMaxRounds` is
therefore enforced by the orchestrator's own control flow, exactly satisfying "cannot be
overridden by HumanGate."

`hardMaxRounds` (default `20`) is distinct from `recommendedMaxRounds` (default `10`, a
soft budget that only affects `DecisionRecommendation.reason` text, §8.4); the orchestrator
validates `hardMaxRounds > recommendedMaxRounds` at options-construction time, mirroring
4B's `maxRounds >= 1` validation (`runConvergenceReviewLoop.ts:110`).

### 6.6 `FakeHumanGate` isolation rules (mandatory change 7, MEDIUM #5 fix)

1. **Location constraint.** `FakeHumanGate` (and any other scripted `HumanGate` test
   double) is defined **only** under `tests/` — e.g. a shared `tests/unit/fakes/
   fakeHumanGate.ts` helper — and is never exported from anything under `src/`.
2. **Single production export.** `src/orchestration/humanGate/humanGate.ts` exports
   exactly one `HumanGate`-constructing function: `createTerminalHumanGate(): HumanGate`.
   No fake, mock, or scripted constructor is ever exported alongside it from that module
   or any other file under `src/`.
3. **`scripts/smoke-audited-review.ts` is structurally constrained** to only import and
   call `createTerminalHumanGate` — there is no other `HumanGate`-constructing symbol
   reachable from `src/` for it to accidentally import.
4. **New isolation test, `tests/unit/humanGateIsolation.spec.ts`** (extending the same
   source-scan/import-graph technique 4B's `convergenceEngineIsolation.spec.ts` already
   uses): asserts (a) no file under `src/` imports anything from `tests/`, (b)
   `src/orchestration/humanGate/humanGate.ts`'s exports contain nothing matching
   `/^(create)?Fake/i`, and (c) `scripts/smoke-audited-review.ts`'s only `HumanGate`-typed
   construction call is `createTerminalHumanGate()`.

This mirrors, and now states explicitly, the same discipline 4A/4B already maintain
implicitly for fake `ConversationalSiteAdapter`s (defined inline in spec files, never
exported from `src/`).

---

## 7. Multi-agent roles

### 7.1 Generator Agent (unchanged from v1)

### 7.2 Reviewer Agent (unchanged from v1)

### 7.3 Evidence Agent — **5B**, not 5A

Named and scoped in §5.4. Not implemented, not designed to prompt/parser detail, in this
5A-focused document.

### 7.4 Decision Engine — now fully specified, see §8

v1's §7.4 gave only the `DecisionRecommendation` type shape. That type is unchanged in
v2, but the actual recommendation algorithm now exists (§8) — closing BLOCKING #1. The
"not LLM-backed, deterministic" rationale from v1 is unchanged and reaffirmed: §8's
formulas are ordinary TypeScript over the ledger's plain data, cheap, instant, and
independently unit-testable.

### 7.5 Role summary table (updated)

| Role | AI-backed? | Bound to | Can finalize an outcome? | Phase |
|---|---|---|---|---|
| Generator | Yes (ChatGPT) | Existing adapter | No | 5A |
| Reviewer | Yes (Claude) | Existing adapter | No | 5A |
| Evidence | Yes (either adapter, on demand) | Existing adapter(s) | No | **5B** |
| Decision Engine | No (deterministic, §8) | Pure function | No — recommendation only | 5A |
| **Human Gate** | No — a real person | `HumanGate` interface | **Yes, within `legalOutcomes` (§6.5)** | 5A |

---

## 8. Decision Engine specification (mandatory change 1, BLOCKING #1 fix)

### 8.1 Inputs (computed fresh each round, after ingest)

- `openHighCount`, `openMediumCount`, `openLowCount` — counts of `OPEN` claims by severity
  (same definition style as 4B; `DISPUTED` claims are tracked separately, not counted
  here).
- `disputedCount` — count of claims with `status === "DISPUTED"` (§4.3).
- `chronicClaims` — claims whose `history` contains `>= reopenRejectThreshold` `REOPENED`
  events (§8.3).
- `lowConfidenceResolutions` — `RESOLVED` claims whose confidence, as of the round their
  terminal `RESOLVED` event was recorded, was `< resolutionConfidenceThreshold`.
- `averageConfidence` — mean `confidence` across all claims currently `OPEN` or
  `DISPUTED` (terminal-status claims excluded).
- `cleanStreak` — see §8.2.
- `round`, `hardMaxRounds`, `recommendedMaxRounds`.

### 8.2 Clean round definition (extends 4B §8.1 with two new conjuncts)

```
isCleanRound(r) :=  openHighCount(r) === 0
                AND openMediumCount(r) === 0
                AND disputedCount(r) === 0
                AND lowConfidenceResolutions(r) === 0

cleanStreak(r)  :=  isCleanRound(r) ? cleanStreak(r-1) + 1 : 0     // reset-on-any-non-clean,
                                                                     unchanged rule from 4B §8.2
```

**Why the two new conjuncts, each closing a specific false-accept vector:**

- `disputedCount(r) === 0` — a round cannot be "clean" while a `DISPUTED` claim (§4.3,
  contradictory unresolved evidence) exists, regardless of its severity. This prevents
  "the dispute is technically only LOW severity, so ignore it" from silently producing an
  accept-eligible round.
- `lowConfidenceResolutions(r) === 0` — a claim marked `RESOLVED` on weak, still-contested
  evidence (confidence below `resolutionConfidenceThreshold` at the moment of resolution)
  must not count toward a clean round. This is the claim-ledger analogue of 4B's own
  false-convergence concern (`MILESTONE4B_DESIGN.md` §13), extended to a system where
  resolutions carry a continuous confidence score instead of a bare `RESOLVED` boolean.

### 8.3 Chronic-claim reject trigger

```
isChronic(claim) := count(claim.history, event => event.kind === "REOPENED")
                     >= reopenRejectThreshold      // default 3
```

Rationale: repeated resolve→reopen cycling on the same claim indicates the Generator
cannot durably address it — the frequency-based analogue of 4B's severity-floor concept,
extended into a genuine `REJECT`-shaped signal that 4B never needed (it had no reject
outcome).

### 8.4 Decision priority order (single checkpoint per round, first-match-wins — same style as `MILESTONE4B_DESIGN.md` §8.3)

```
1. if round >= hardMaxRounds:
      kind := REJECT_RECOMMENDED
      reason := "hardMaxRounds (<n>) reached"
      // This branch is still only a RECOMMENDATION. The actual, unoverridable stop at
      // hardMaxRounds is enforced independently by the orchestrator (§6.5), not by this
      // recommendation alone — the two mechanisms are deliberately decoupled so that a
      // bug in this function could never, by itself, remove the hard ceiling.

2. else if any claim in the ledger isChronic (§8.3):
      kind := REJECT_RECOMMENDED
      reason := "claim <id> reopened >= reopenRejectThreshold times"

3. else if round > recommendedMaxRounds:
      kind := CONTINUE_RECOMMENDED
      reason := "round budget (recommendedMaxRounds=<n>) exceeded; consider REJECT or a
                 manual ACCEPT override if remaining claims are judged immaterial"
      // Advisory only — the round is still evaluated for CONVERGED-equivalent status by
      // branch 4 below in every subsequent round; exceeding the soft budget does not
      // itself block an ACCEPT recommendation once the ledger is actually clean.

4. else if isCleanRound(r) AND cleanStreak(r) >= stabilityWindowRounds:   // default 2
      kind := ACCEPT_RECOMMENDED
      reason := "<cleanStreak> consecutive clean rounds, no open HIGH/MEDIUM, no disputed
                 claims, no low-confidence resolutions"

5. else:
      kind := CONTINUE_RECOMMENDED
      reason := "<openHighCount> open HIGH, <openMediumCount> open MEDIUM,
                 <disputedCount> disputed, <lowConfidenceResolutions> low-confidence
                 resolution(s) remaining"
```

Branch 3 is a deliberate correction to v1's silence on this point: exceeding
`recommendedMaxRounds` alone must not force a `REJECT_RECOMMENDED` (that would make the
soft budget behave like a second hard ceiling, defeating the point of having two separate
thresholds) — it only changes the *reason text* attached to a `CONTINUE_RECOMMENDED`,
giving the human visibility without pre-empting branch 4's own, independent evaluation of
whether the ledger has actually become clean.

### 8.5 Default thresholds

| Option | Default | Meaning |
|---|---|---|
| `stabilityWindowRounds` | 2 | reused from 4B |
| `disputedConfidenceBandLow` / `High` | 0.35 / 0.65 | reused from v1 §4.3 |
| `resolutionConfidenceThreshold` | 0.75 | minimum confidence a `RESOLVED` claim must have at resolution time to count toward a clean round |
| `reopenRejectThreshold` | 3 | `REOPENED` event count marking a claim chronic |
| `recommendedMaxRounds` | 10 | soft budget; affects recommendation *reason* text only (§8.4 branch 3) |
| `hardMaxRounds` | 20 | hard ceiling; validated `> recommendedMaxRounds` at options-construction time; enforced independently of this function by the orchestrator (§6.5) |

### 8.6 Updated `DecisionRecommendation` shape (fields now meaningfully used)

```ts
export interface DecisionRecommendation {
  kind: "CONTINUE_RECOMMENDED" | "ACCEPT_RECOMMENDED" | "REJECT_RECOMMENDED";
  round: number;
  reason: string;                  // one of §8.4's five templated reasons, filled in
  cleanStreak: number;
  openHighCount: number;
  openMediumCount: number;
  disputedCount: number;           // now directly gates ACCEPT via isCleanRound (§8.2)
  averageConfidence: number;       // now directly informs lowConfidenceResolutions'
                                    // upstream computation and is surfaced to the human
                                    // at the gate for their own judgment, even though it
                                    // is not itself a branch condition in §8.4
  lowConfidenceResolutionCount: number;   // NEW — makes §8.2's fourth conjunct visible in
                                           // the recommendation, not just baked into
                                           // isCleanRound's boolean result
}
```

### 8.7 Worked consequences (mirroring `MILESTONE4B_DESIGN.md` §8.3's style)

- A single `DISPUTED` claim blocks `ACCEPT_RECOMMENDED` even with zero open HIGH/MEDIUM.
- A claim resolved on `confidence = 0.6` (below the `0.75` threshold) keeps the round
  non-clean until either more evidence pushes it over threshold, or — in 5A specifically —
  a human attaches stronger evidence at the gate (§6.4); 5B's live Evidence Agent is
  another, later way this can happen.
- Reaching `hardMaxRounds` always recommends `REJECT`, never `ACCEPT`, regardless of
  ledger cleanliness — a run that "looks clean" but took unexpectedly long is still
  flagged for scrutiny rather than quietly waved through.
- `REJECT_RECOMMENDED` never itself rejects the run; only a human's `HumanGateResponse`
  can (§7.5's role table).
- Exceeding `recommendedMaxRounds` alone never blocks an otherwise-legitimate
  `ACCEPT_RECOMMENDED` (§8.4 branch 3 vs. branch 4) — the two thresholds serve genuinely
  different purposes and must not collapse into one.

---

## 9. Backward compatibility

### 9.1 What "frozen" precisely means in v2 (corrected from v1)

v1 stated Milestone 4B's files are "frozen, byte-for-byte, verified by `git diff`
producing no output." The architect review correctly identified that this is
**incompatible** with mandatory change 3 (share, don't duplicate, severity logic) as
written, since the relevant functions in `objectionLedger.ts` are private and unexported.

**v2's corrected rule: Milestone 4B's freeze is a behavioral and public-contract freeze,
not a literal never-touch-the-bytes rule.** It is verified by:

1. Every currently-exported symbol from every 4B file (`createEmptyLedger`, `cloneLedger`,
   `countsForLedger`, `ingestReview`, `ingestStructuredReview`, `severityRank`,
   `InvalidLedgerIngestError`, and everything exported by `runConvergenceReviewLoop.ts`,
   `convergencePrompts.ts`, `structuredReviewParser.ts`, `fingerprint.ts`,
   `convergenceEngine.ts`) keeping the exact same signature and behavior.
2. The full existing test suite (133 tests as of Milestone 4B's closeout, in
   `structuredReviewParser.spec.ts`, `objectionLedger.spec.ts`, `convergenceEngine.spec.ts`,
   `convergencePrompts.spec.ts`, `runConvergenceReviewLoop.spec.ts`, and every other
   existing spec file) passing **unmodified** — zero test-file edits, zero expectation
   changes.

Under this corrected rule, exactly **one** narrowly-scoped, internal-only change to a 4B
file is permitted, and only this one:

**Migration: `objectionLedger.ts`'s internal severity arithmetic moves to
`shared/severityRules.ts`.**

- **What changes:** the file's private, unexported `adjust()`/`reopen()` helper functions
  are replaced with calls to `severityRules.ts`'s `adjustSeverity()`/
  `reopenSeverityFloor()` (§4.5). This is an internal implementation change only.
- **What does not change:** the file's exported surface (names, signatures, behavior),
  `ObjectionLedgerEntry`'s shape, `ConvergenceOptions`, any prompt builder, any test
  file's content or expectations.
- **Acceptance gate for this migration, specifically:** it must land as its own isolated
  change, separate from any `claims/` code, with the existing test suite passing at
  133/133 **unmodified**, before any `claims/` code is written against
  `shared/severityRules.ts`. This document does not implement it (still design-only, per
  the task's instruction) — it is specified here as a **named prerequisite** for whoever
  begins Milestone 5A implementation (§14's file plan lists it first, ahead of any
  `claims/` file).

This is the one deliberate, reviewed exception to v1's stricter wording, made necessary
specifically by mandatory change 3, and is not a general loosening of the freeze policy —
every other file in the frozen list below remains untouched in the literal, byte-for-byte
sense as well.

### 9.2 Frozen list (otherwise unchanged from v1)

- `src/orchestration/runFixedReviewLoop.ts`, `fixedReviewPrompts.ts` — untouched, no exception.
- `src/orchestration/runConvergenceReviewLoop.ts` — untouched, no exception.
- `src/orchestration/convergence/types.ts`, `fingerprint.ts`, `structuredReviewParser.ts`,
  `convergenceEngine.ts`, `convergencePrompts.ts` — untouched, no exception.
- `src/orchestration/convergence/objectionLedger.ts` — **the one exception**, per §9.1,
  internal-only, contract/behavior identical, gated on the unmodified test suite passing.
- `src/sites/*`, `src/browser/*`, `scripts/smoke-multi-round.ts`,
  `scripts/smoke-convergence.ts`, `scripts/start-browser.ps1`, `src/config/loadConfig.ts`,
  `config/config.json` — untouched, no exception.
- Every existing test file under `tests/unit/` — untouched, no exception (must still pass,
  unmodified).

### 9.3 New, additive-only

- `package.json` may gain new script entries; existing lines byte-identical.
- New directories: `src/orchestration/shared/` (§4.5, new), `src/orchestration/claims/`,
  `src/orchestration/humanGate/` — never inside `src/orchestration/convergence/`.
- A new `runAuditedReviewLoop.ts`, parallel to `runConvergenceReviewLoop.ts`.

### 9.4 Isolation tests required (updated)

- `tests/unit/claimsIsolation.spec.ts` (unchanged from v1): no file under
  `src/orchestration/convergence/` imports from `src/orchestration/claims/` or
  `humanGate/`.
- **New:** `tests/unit/sharedSeverityRulesIsolation.spec.ts` — asserts
  `src/orchestration/shared/severityRules.ts` has no dependency on `convergence/` or
  `claims/` (the arrow points the other way: both depend on `shared/`, `shared/` depends
  on neither).
- `tests/unit/humanGateIsolation.spec.ts` (§6.6, new).

---

## 10. Persistence-readiness (unchanged principle, versioned now — see §12.1)

Unchanged from v1: the data model remains fully JSON-serializable, and 5A still does not
write anything to disk. What changes is that every independently-persistable container now
carries a `schemaVersion` (§12.1), directly answering the architect review's finding that a
model framed as "persistence-ready" cannot skip versioning.

---

## 11. (reserved — see §8 for what was previously drafted as a bare interface)

*(Section number intentionally not reused for unrelated content; the Decision Engine that
v1 sketched only as a type in its §7.4/§10 is now fully specified in §8, and this document
does not repeat it here to avoid two sources of truth.)*

---

## 12. Data model (consolidated design sketch, updated: schemaVersion, hardMaxRounds fields)

### 12.1 `schemaVersion` placement rule (mandatory change 6, MEDIUM #4 fix)

`schemaVersion` is added to every type that could plausibly be serialized or read back
**independently of a parent that is already versioned** — not to every nested type, which
would be redundant noise. Specifically:

- `AuditedReviewResult` — the top-level unit; always versioned.
- `HumanGateResponse` — plausible target of a future independent, append-only decision log
  (§16.2) that could exist before any full-run persistence layer is built; versioned so
  such a log remains interpretable on its own.

**Not individually versioned** (implicitly covered by their parent container's
`schemaVersion`, since they never travel or get read independently of it):
`AuditedRoundRecord`, `ClaimLedgerEntry`, `Evidence`, `DecisionRecommendation`,
`HumanGatePresentation`. This mirrors common event-sourcing/document-versioning practice
(a versioned envelope guarantees all nested shapes for that version) and is stated here as
a deliberate choice, open to revision if a future persistence design (§16.2) needs
finer-grained versioning.

### 12.2 Full sketch

```ts
// design sketch — src/orchestration/claims/types.ts (new module; does not edit
// src/orchestration/convergence/types.ts)

export const CLAIM_LEDGER_SCHEMA_VERSION = 1;

export type ReviewSeverity = "HIGH" | "MEDIUM" | "LOW";              // reused from convergence/types.ts
export type ClaimStatus = "OPEN" | "DISPUTED" | "RESOLVED" | "REJECTED";
export type EvidenceKind = "SUPPORTING" | "CHALLENGING" | "RESOLUTION";
export type EvidenceStrength = "STRONG" | "MODERATE" | "WEAK";
export type EvidenceSourceRole = "GENERATOR" | "REVIEWER" | "EVIDENCE_AGENT" | "HUMAN";
//                                                          ^^^^^^^^^^^^^^^ unused in 5A (§5.3)

export interface Evidence {
  id: string; claimId: string; kind: EvidenceKind; strength: EvidenceStrength;
  sourceRole: EvidenceSourceRole; text: string; round: number; submittedAt: string;
  supersedesEvidenceId?: string;
}

export interface ConfidenceChangeEvent {
  round: number; previousConfidence: number; newConfidence: number; causeEvidenceId: string;
}

export type ClaimHistoryEventKind =
  | "RAISED" | "REPEATED" | "PARAPHRASED" | "RESOLVED" | "REJECTED" | "REOPENED"
  | "IMPLICITLY_CARRIED_OPEN" | "SEVERITY_CHANGED" | "SEVERITY_DOWNGRADE_REJECTED"
  | "DUPLICATE_COLLAPSED"
  | "EVIDENCE_ADDED" | "CONFIDENCE_CHANGED" | "DISPUTED" | "UNDISPUTED"
  | "HUMAN_DECISION_RECORDED";

export interface ClaimHistoryEvent {
  round: number; kind: ClaimHistoryEventKind; detail?: string;
  resolutionEvidenceRef?: string;
}

export interface ClaimLedgerEntry {
  id: string; claim: { statement: string; rationale: string };
  severity: ReviewSeverity; highestSeveritySeen: ReviewSeverity;
  confidence: number; status: ClaimStatus;
  evidenceFor: string[]; evidenceAgainst: string[];
  confidenceHistory: ConfidenceChangeEvent[];
  firstSeenRound: number; lastSeenRound: number;
  normalizedFingerprint: string[];
  history: ClaimHistoryEvent[];
}

export interface DecisionRecommendation {           // §8.6
  kind: "CONTINUE_RECOMMENDED" | "ACCEPT_RECOMMENDED" | "REJECT_RECOMMENDED";
  round: number; reason: string; cleanStreak: number;
  openHighCount: number; openMediumCount: number; disputedCount: number;
  averageConfidence: number; lowConfidenceResolutionCount: number;
}

export type HumanGateOutcome = "CONTINUE" | "ACCEPT" | "REJECT";

export interface HumanGatePresentation {             // §6.2
  round: number; currentAnswer: string;
  recommendation: DecisionRecommendation;
  disputedClaims: ClaimLedgerEntry[]; claimLedgerDelta: ClaimLedgerEntry[];
  relevantEvidence: Evidence[];
  legalOutcomes: HumanGateOutcome[];
}

export interface HumanGateResponse {                 // §6.2
  schemaVersion: number;
  outcome: HumanGateOutcome; rationale?: string; decidedAt: string;
}

export interface AuditedRoundRecord {
  roundNumber: number;
  reviewerPrompt: string; reviewerRawResponse: string;
  recommendation: DecisionRecommendation;
  humanGateResponse: HumanGateResponse;     // ALWAYS present — every round is gated
  humanSuppliedEvidence?: Evidence[];        // NEW — evidence attached at the gate, §6.4
  generatorPrompt?: string; generatorResponse?: string;
}

export interface AuditedReviewResult {
  schemaVersion: number;                     // NEW (§12.1) — = CLAIM_LEDGER_SCHEMA_VERSION
  originalTask: string;
  outcome: "ACCEPTED" | "REJECTED";
  finalAnswer: string;
  initial: { prompt: string; response: string; startedAt: string; completedAt: string };
  rounds: AuditedRoundRecord[];
  claimLedger: ClaimLedgerEntry[];
  evidenceLog: Evidence[];
  hardMaxRounds: number; recommendedMaxRounds: number;   // NEW — the actual bounds used,
                                                           // recorded for audit (§6.5)
  invalidReview?: { round: number; rawText: string; reason: string };
}
```

Every field remains plain, JSON-serializable data.

---

## 13. Prompt design

### 13.1 Generator revision-prompt adaptation (mandatory change 8, MEDIUM #3 fix)

v1 claimed the Generator's revision prompt would be produced by "reusing 4B's
revision-prompt shape... extended with claim/evidence context," but
`buildConvergenceChatGptRevisionPrompt(task, previousAnswer, claudeRawReview,
openHighMediumObjections: ObjectionLedgerEntry[])` does not type-check against
`ClaimLedgerEntry[]` — a structurally different type. v2 resolves this by designing a new,
purpose-built builder rather than asserting an unverified reuse:

```ts
// design sketch — src/orchestration/claims/claimPrompts.ts (new module)
export function buildClaimReviewRevisionPrompt(
  task: string,
  previousAnswer: string,
  reviewerRawResponse: string,
  blockingClaims: ClaimLedgerEntry[],   // OPEN + DISPUTED, HIGH/MEDIUM severity
  relevantEvidence: Evidence[],         // evidence attached to blockingClaims, for context
): string
```

Modeled directly on `buildConvergenceChatGptRevisionPrompt`'s structure (task / previous
answer / latest review / blocking-objection list / empty-list guidance), with each
blocking line annotated with information the 4B Generator never had access to — confidence
and dispute status:

```
You are ChatGPT. Revise your previous answer to address the reviewer's open claims.

TASK:
---
<task>
---

YOUR PREVIOUS ANSWER:
---
<previousAnswer>
---

LATEST REVIEWER RESPONSE:
---
<reviewerRawResponse>
---

UNRESOLVED HIGH/MEDIUM/DISPUTED CLAIMS YOU MUST ADDRESS:
- [HIGH, confidence 0.42, DISPUTED] <statement>: <rationale>
    evidence for: 1 (WEAK) | evidence against: 2 (MODERATE, STRONG)
- [MEDIUM, confidence 0.81, OPEN] <statement>: <rationale>
    evidence for: 0 | evidence against: 0
(if this list is empty, there are no blocking claims — keep your previous answer's
substance unchanged unless a LOW-severity suggestion clearly warrants a small, harmless
improvement; do not make speculative or unrequested changes)

Provide your COMPLETE revised, standalone answer to the original task. A DISPUTED claim
means the reviewer's own evidence is contested — you may address it by directly countering
the challenging evidence, not only by editing the answer. Return the answer itself, not
commentary, not a changelog, and not any structured review output.
```

This is why the new builder is preferable to an adapter function that reshapes
`ClaimLedgerEntry[]` into `ObjectionLedgerEntry[]`: an adapter would have to either drop
the confidence/dispute information (defeating the point of upgrading the ledger) or bolt
it on as unstructured text anyway — writing a dedicated builder is simpler and gives the
Generator strictly more actionable signal than 4B's Generator ever had.

### 13.2 Reviewer / Evidence prompts (unchanged shape from v1 §5.3, deferred to 5B for Evidence)

`claims/claimPrompts.ts` also holds the Reviewer's claim-raising prompt (extends 4B's
grammar with claim-ledger fields, structurally analogous to `convergencePrompts.ts`'s
round-1/round-N split) — unchanged in spirit from v1, parsed by the new
`structuredClaimParser.ts` (§7.2 role description). The Evidence Agent's prompt
(`buildEvidenceRequestPrompt`) remains named only, deferred to 5B (§5.4).

---

## 14. Round lifecycle (design, updated for hardMaxRounds enforcement and 5A evidence scope)

```
state: INITIAL_GENERATOR
  → send task to Generator → wait → extract → G0
  → currentAnswer = G0; round = 1

state: ROUND(r)
  → build Reviewer prompt from (task, currentAnswer, OPEN+DISPUTED claim ledger summary)
  → send to Reviewer → wait → extract → rawReview
  → parse rawReview (claims/structuredClaimParser.ts)
  → if parse fails: record failure, claim ledger untouched, recommendation :=
        CONTINUE_RECOMMENDED citing the parse failure, still proceed to the gate
  → ingest parsed claims into the Claim Ledger, including structural resolution evidence
        (§5.3 point 1) — no live Evidence Agent turn in 5A (§5.4)
  → Decision Engine computes a DecisionRecommendation (§8) — never acts on it directly
  → orchestrator computes legalOutcomes := round >= hardMaxRounds
        ? ["ACCEPT","REJECT"] : ["CONTINUE","ACCEPT","REJECT"]                      [§6.5]
  → ════ HUMAN GATE (§6) — always fires ════
        present: claim ledger delta, disputed claims, relevantEvidence, recommendation +
                 reason, currentAnswer, legalOutcomes
        human optionally attaches evidence (§6.4), then responds with an outcome in
        legalOutcomes (+ mandatory rationale on REJECT)
  → orchestrator validates the response against legalOutcomes independently (§6.5 Layer 2):
        if outcome === "CONTINUE" AND round >= hardMaxRounds:
              force outcome := "REJECTED", rationale := "hardMaxRounds reached; CONTINUE
              not honored", record the override in history, STOP
  → act on the (possibly-overridden) outcome:
        ACCEPT   → STOP, outcome = "ACCEPTED", finalAnswer = currentAnswer
        REJECT   → STOP, outcome = "REJECTED", finalAnswer = currentAnswer (reference only)
        CONTINUE → build Generator revision prompt (§13.1's new builder)
                   → send to Generator → wait → extract → Gr
                   → currentAnswer = Gr; round = r + 1; repeat
```

The one behavioral difference from v1's lifecycle, beyond the hardMaxRounds enforcement
steps: there is no Evidence Agent turn between ingest and the Decision Engine step in 5A —
evidence bookkeeping is folded entirely into ingest (structural resolution evidence) and
into the gate interaction itself (human-supplied evidence, §6.4).

---

## 15. Testing strategy (updated)

### 15.1 Unit tests (offline, pure functions, no Playwright) — new/updated entries only

| Test file | Covers |
|---|---|
| `tests/unit/severityRules.spec.ts` (**new**) | Direct unit tests of `adjustSeverity()`/`reopenSeverityFloor()` in `shared/severityRules.ts` — escalation-applies, downgrade-rejected-and-logged, reopen-floors-at-peak — as pure, standalone tests independent of either ledger. |
| `tests/unit/objectionLedger.spec.ts` (**existing, must pass unmodified**) | The acceptance gate for the §9.1 migration: identical behavior before/after `objectionLedger.ts` is refactored to import from `shared/severityRules.ts`. |
| `tests/unit/decisionAgent.spec.ts` (**substantially expanded**) | One test per §8.4 priority branch (hardMaxRounds-reached, chronic-claim, soft-budget-exceeded-reason-only, clean-round-accept, default-continue), confirming priority order (e.g., a chronic claim recommends REJECT even in an otherwise-clean round), plus confirmation the function is pure and never mutates its input ledger. |
| `tests/unit/claimLedger.spec.ts` | Unchanged scope from v1, plus: confirm `claimLedger.ts` calls the shared `severityRules.ts` functions (not a reimplementation) via a spy/import-count check. |
| `tests/unit/humanGate.spec.ts` (**expanded**) | `legalOutcomes` enforcement at the fake-gate level; `REJECT` without `rationale` rejected; **new:** a scripted fake returning `CONTINUE` when `round >= hardMaxRounds` is fed to `runAuditedReviewLoop.spec.ts`'s orchestrator-level test (next row) to prove Layer 2 enforcement, not just Layer 1. |
| `tests/unit/runAuditedReviewLoop.spec.ts` (**expanded**) | v1's scenarios plus: **hardMaxRounds cannot be exceeded** even when a fake gate is deliberately scripted to always return `CONTINUE` — assert the run stops exactly at `hardMaxRounds` with `outcome === "REJECTED"` and a system-authored rationale, and that no Generator/Reviewer turn is sent for any round beyond it. |
| `tests/unit/claimsIsolation.spec.ts`, `humanGateIsolation.spec.ts` (**new**), `sharedSeverityRulesIsolation.spec.ts` (**new**) | Dependency-graph isolation, per §9.4 and §6.6. |

### 15.2 Simulation tests (offline, multi-round scripted scenarios) — new scenario added

All of v1 §12.2's scenarios, plus:

- **hardMaxRounds override attempt:** a fake gate scripted to return `CONTINUE` for every
  round up to and past `hardMaxRounds` — confirm the run is force-stopped at exactly
  `hardMaxRounds`, `outcome === "REJECTED"`, and the audit trail shows the human's (fake)
  `CONTINUE` responses were recorded but the final outcome was engine-forced, distinctly
  labeled as such (§6.5).
- **Low-confidence resolution keeps a round non-clean:** a claim resolved with confidence
  `0.6` (below the `0.75` default) — confirm `isCleanRound` is false that round and
  `cleanStreak` does not advance, even with zero open HIGH/MEDIUM/DISPUTED claims.
- **Human-supplied evidence at the gate changes the next round's recommendation:** a human
  attaches `CHALLENGING` evidence to an `OPEN` claim mid-gate — confirm confidence moves
  per §4.2's rule and the claim's `DISPUTED` classification is re-evaluated before the
  round's `HumanGateResponse` is finalized.

### 15.3 Real browser tests (manual, not part of the automated suite) — unchanged scope from v1

`scripts/smoke-audited-review.ts` — same CDP-attach-only safety pattern; now also exercises
`legalOutcomes` for real once a smoke run is deliberately driven past `hardMaxRounds` (a
low `hardMaxRounds` value, e.g. `2`, is recommended for the smoke script's own defaults, so
this path is actually exercisable in a short manual run).

### 15.4 Compatibility/regression checks — updated acceptance bar

- `git diff --stat` against every file in §9.2's frozen list, **except**
  `objectionLedger.ts`, must show no output.
- `objectionLedger.ts`'s diff must show **only** the internal `adjust`/`reopen` → shared-
  module-call replacement — no signature, export, or behavior change — and
  `objectionLedger.spec.ts` must pass unmodified (§15.1).
- All other existing `tests/unit/*.spec.ts` files (133 tests as of Milestone 4B's closeout)
  must still pass, unmodified.
- `npm run build` and `npm test` must both pass with Milestone 5A's new files present.

---

## 16. Open questions (updated — several from v1 resolved, two new ones added)

**Resolved by this revision (no longer open):** Decision Engine algorithm (was open in
spirit in v1, now §8); hardMaxRounds enforceability (§6.5); severity-rule reuse mechanism
(§4.5, §9.1); HumanGatePresentation evidence completeness (§6.2); Generator revision-prompt
adaptation (§13.1); schemaVersion placement (§12.1); FakeHumanGate isolation (§6.6).

**Still open, carried from v1:**

1. Should 5B's Evidence Agent ever be backed by real external retrieval? Deferred, per v1
   §13.1.
2. Should the human gate ever support asynchronous approval instead of a synchronous
   blocking terminal prompt? Deferred, per v1 §13.5 — unaffected by this revision.
3. Should a malformed Reviewer response support a bounded, explicitly-logged
   re-elicitation rather than always falling through to the gate? Deferred, per v1 §13.3.

**New in v2:**

4. **5B's per-round Evidence Agent fan-out cap** (`maxEvidenceRequestsPerRound` and its
   interaction with round wall-clock time) is named in §5.4 but its exact value and
   trigger policy are left to 5B's own design pass, not this one.
5. **Independent append-only decision log (§12.1's justification for versioning
   `HumanGateResponse` separately):** should 5A actually write a lightweight,
   line-per-decision log to disk (distinct from full `AuditedReviewResult` persistence,
   which remains out of scope, §1) purely to make `hardMaxRounds`-forced overrides visible
   in real time during a long-running manual smoke session, rather than only at the end?
   Named here because §12.1's versioning choice anticipates it, but building it is not
   part of 5A as scoped.

---

## 17. File / module plan (updated: shared/ module, migration ordering, no Evidence Agent files in 5A)

**Prerequisite (must land first, isolated from all `claims/` work, §9.1):**

- `src/orchestration/shared/severityRules.ts` (§4.5) — new file.
- `src/orchestration/convergence/objectionLedger.ts` — internal-only edit (§9.1); its own
  existing spec file must pass unmodified.
- `tests/unit/severityRules.spec.ts` (new).
- `tests/unit/sharedSeverityRulesIsolation.spec.ts` (new).

**Milestone 5A new files:**

- `src/orchestration/claims/types.ts` (§12.2)
- `src/orchestration/claims/claimLedger.ts` (§4, imports `shared/severityRules.ts`)
- `src/orchestration/claims/decisionAgent.ts` (§8)
- `src/orchestration/claims/claimPrompts.ts` (§13 — Reviewer prompt + the new
  `buildClaimReviewRevisionPrompt`; no Evidence Agent prompt yet, §5.4)
- `src/orchestration/claims/structuredClaimParser.ts` (§7.2)
- `src/orchestration/humanGate/humanGate.ts` (§6.2, §6.3 — `HumanGate` interface +
  `createTerminalHumanGate()`, the only production export, §6.6)
- `src/orchestration/runAuditedReviewLoop.ts` (§3.2, §14)
- `scripts/smoke-audited-review.ts` + `npm run smoke:audited-review` (§15.3)
- `tests/unit/structuredClaimParser.spec.ts`, `claimLedger.spec.ts`,
  `decisionAgent.spec.ts`, `humanGate.spec.ts`, `runAuditedReviewLoop.spec.ts`,
  `claimsIsolation.spec.ts`, `humanGateIsolation.spec.ts`
- `tests/unit/fakes/fakeHumanGate.ts` (test-only helper, §6.6)

**Deferred to Milestone 5B (not created now):** `claims/evidenceAgentPrompts.ts`-equivalent,
the `BEGIN_EVIDENCE_RESPONSE` grammar's parser additions, any fan-out-cap configuration.

**Explicitly untouched (§9.2's full list restated):** every file under
`src/sites/`, `src/browser/`, `runFixedReviewLoop.ts`, `fixedReviewPrompts.ts`,
`scripts/smoke-multi-round.ts`, `scripts/smoke-convergence.ts`,
`scripts/start-browser.ps1`, `src/config/loadConfig.ts`, `config/config.json`, every
existing test file, and every file under `src/orchestration/convergence/` other than the
one named internal edit to `objectionLedger.ts`.
