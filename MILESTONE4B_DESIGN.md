# MILESTONE4B_DESIGN.md — Convergence-driven ChatGPT ⇄ Claude review loop

Design-only document for Phase 2A Milestone 4B. No production TypeScript is changed by
this document. It builds on the frozen, real-browser-verified Milestone 4A fixed-round
loop (`src/orchestration/runFixedReviewLoop.ts`, `fixedReviewPrompts.ts`) and the adapter
contracts in `src/sites/siteTypes.ts`. Milestone 4A is **not modified** by this design —
every file it introduced keeps working exactly as verified.

## Revision history

**Architect review round 2 (this revision)** replaced or hardened seven areas of the
first draft after an explicit convergence-safety review, before any implementation:

1. **Round lifecycle** — collapsed the two-decision-point structure (convergence check
   after `Cr`, maxRounds check after `Gr`) into a **single decision point** right after
   every `Cr`, removing the ambiguity about whether `G1` is produced after a clean `C1`
   (§5). This also fixed a latent bug in the original stability-window formula (§8.1).
2. **Objection matching** — replaced the single `0.6` merge threshold with a
   precision-first, margin-based policy: automatic merge requires a high score, a clear
   margin over the next-best candidate, and a minimum shared-token count; anything weaker
   stays a distinct new objection (§6.5).
3. **Severity rules** — added explicit downgrade-rejection and reopen-floor rules so
   severity can never quietly de-escalate a blocking objection into a non-blocking one
   (§6.6).
4. **Ledger-id validation** — enumerated every contradiction/duplication case that must
   produce `INVALID_REVIEW` (§7.2).
5. **Structured review grammar** — replaced the line-based `STATUS:`-style sections with a
   sentinel-wrapped JSON payload (`BEGIN_STRUCTURED_REVIEW` / `END_STRUCTURED_REVIEW`) and
   strict schema validation, eliminating the delimiter-collision and multiline-text risks
   of a hand-rolled line grammar (§7).
6. **maxRounds semantics** — `maxRounds` now bounds the number of **Claude review**
   rounds; hitting the bound stops the run immediately after the final (still-reviewed)
   `Cr`, never generating an unreviewed trailing ChatGPT revision (§5, §8.2).
7. **Test plan** — added dedicated cases for conservative matching, severity floor/reject
   rules, ledger-id contradictions, the JSON grammar, and the exact state-machine
   sequences called out in this review (§15).

Everything not called out above (goal/non-goals, architecture, model roles, persistence
shape, file plan) is unchanged from the first draft.

---

## 1. Goal / Non-goals

**Goal:** replace the fixed-round loop's "always run exactly `reviewRounds` rounds"
control flow with a convergence-driven loop:

```
G0 → C1 → G1 → C2 → G2 → ... → convergence OR maxRounds
```

`G0` is the initial ChatGPT answer and is **not** a review round. `C1`/`G1` together are
review round 1; `C2`/`G2` are round 2; etc. `maxRounds` defaults to `10` and bounds the
number of **Claude review rounds** (§5, §8.2) — it is a hard safety bound, not a target.

**Non-goals (explicitly out of scope for Milestone 4B):**
- Persistence/resume, `runs/<run-id>/`, an `ArtifactStore` (a persistence-ready round
  record shape is *designed*, per §12, but not implemented or written to disk).
- Fresh-chat automation, file transfer, pause/interruption, mid-run human guidance.
- Any API usage (OpenAI/Anthropic), private endpoints, stealth, or CAPTCHA/Cloudflare
  automation.
- Any change to `chatgptSite.ts`, `claudeSite.ts`, `claudeUserTurns.ts`, `domUtil.ts`, or
  any selector file. All convergence logic is browser-agnostic (§3).
- Any change to Milestone 4A's `runFixedReviewLoop.ts`/`fixedReviewPrompts.ts` — that
  fixed-round loop stays available/frozen; Milestone 4B adds a **new**, separate
  orchestration entry point.
- Semantic/LLM-based paraphrase detection. Objection matching (§6.5) is lexical and
  deterministic, not a second model call.
- An automatic malformed-review repair/resend mechanism (§9) — explicitly not built now;
  the preferred, simpler behavior (stop safely) is what's implemented.

---

## 2. Existing stable foundation (frozen, reused as-is)

Everything Milestone 4A proved is reused unchanged:

- `ConversationalSiteAdapter` (`checkReady`, `captureTurnBaseline`, `sendPrompt`,
  `waitForGenerationStart`, `waitForGenerationComplete`, `getLatestAssistantResponse`).
- The stage-wrapped error pattern (`FixedReviewLoopError`-shaped: a typed error carrying
  the precise stage and the partial result), reused in shape for the new
  `ConvergenceReviewLoopError`.
- `generationStartTimeoutMs` default `30000`, per-site `generationTimeoutMs` default
  `180000`, no automatic resend after any timeout, attached-tab-only invariants (never
  navigate, never open/close a tab).
- The "one `sendPrompt` call per logical turn, no retry" invariant from Milestone 4A §9 —
  Milestone 4B **extends** this invariant to Claude's structured-review turn as well
  (§9).

Milestone 4B adds a **new**, parallel orchestration module. It does not extend or branch
inside `runFixedReviewLoop.ts` — that module stays exactly as verified, for callers who
still want a fixed-count run. The new module is `runConvergenceReviewLoop.ts` (§3, §5).

---

## 3. Architecture

```
runConvergenceReviewLoop.ts   (new orchestrator; depends ONLY on ConversationalSiteAdapter)
  ├─ convergence/convergencePrompts.ts     — pure prompt builders
  ├─ convergence/structuredReviewParser.ts — pure text → StructuredClaudeReview | Invalid
  ├─ convergence/objectionLedger.ts        — pure ledger create/ingest, conservative
  │                                          fingerprint matching, severity floor/reject
  │                                          rules
  ├─ convergence/fingerprint.ts            — pure normalization + similarity scoring
  └─ convergence/convergenceEngine.ts      — pure decision function (CONTINUE/CONVERGED/
                                              MAX_ROUNDS_REACHED/INVALID_REVIEW)
```

`ConvergenceEngine` (the module `convergenceEngine.ts`, plus everything under
`convergence/`) contains **no** Playwright import, no DOM selector, no ChatGPT/Claude page
logic, and no site-specific string. It is pure functions over plain data: given a ledger
and a round's parsed review, it returns a decision. This is verified directly by a
dependency-import isolation test (§15, test 16) rather than left as an assertion in prose.

`runConvergenceReviewLoop.ts` is the only file that touches `Page`/adapters; it is the
sole caller of both the adapter contract and the pure `convergence/` modules — exactly the
same shape as `runFixedReviewLoop.ts` calling `fixedReviewPrompts.ts`. No browser adapter
file is touched to implement any of this.

---

## 4. Model roles (explicit, per the task's own wording)

- **ChatGPT** is the **proposer/reviser**: produces `G0` and, in every round that reaches
  the revision step, a **complete** revised answer addressing the reviewer's open
  objections. ChatGPT never emits structured review syntax.
- **Claude** is the **reviewer**: identifies substantive objections against the current
  ChatGPT answer and reports, each round, which prior objections it now considers
  resolved, which remain open, which have reopened, and which are genuinely new. Claude
  never decides convergence — it only supplies structured input to the engine (§8).

No prompt or code comment in this design (or its future implementation) refers to either
model as "another AI" or "the other model" — both prompts (§11) name ChatGPT and Claude
explicitly, continuing Milestone 4A's verified convention (`DECISIONS.md` §11e).

---

## 5. Round lifecycle (single decision point)

**This section replaces the first draft's two-decision-point design.** The first draft
evaluated convergence right after `Cr` (deciding whether to skip `Gr`) and separately
evaluated `maxRounds` right after `Gr` — two different checkpoints, which is exactly what
created the ambiguity flagged in review: "`C1` is clean, `cleanStreak = 1`, not yet
converged — what happens next if `G1` is skipped?" It wasn't actually skipped in the first
draft's algorithm (§8.1's `cleanStreak >= 2` requirement already forced `G1` to be sent),
but the two-checkpoint structure made that easy to misread and, worse, allowed a real
`maxRounds` inconsistency (an unreviewed trailing `Gmax` could be generated). Both problems
are removed by using **one** decision point per round, evaluated immediately after `Cr`:

```
state: INITIAL_CHATGPT
  → send task to ChatGPT → wait → extract → G0
  → currentAnswer = G0
  → round = 1

state: ROUND(r)   [r = 1, 2, 3, ...]
  → build Claude review prompt from (task, currentAnswer, OPEN ledger summary)   [§11]
  → send to Claude → wait → extract → rawReview
  → parse rawReview against known ledger ids                                     [§7]
  → if parse fails:
        STOP, stopReason = INVALID_REVIEW, finalAnswer = currentAnswer
        (cleanStreak is NOT updated — a round that never parsed never happened
         for stability-window purposes; see §8.3)
  → ingest parsed review into the ledger; recompute openHigh, openMedium, cleanStreak [§6, §8]
  → decision, in this fixed priority order:
        1. if openHigh == 0 AND openMedium == 0 AND cleanStreak >= stabilityWindowRounds:
               STOP, stopReason = CONVERGED, finalAnswer = currentAnswer   (Gr is NEVER sent)
        2. else if r == maxRounds:
               STOP, stopReason = MAX_ROUNDS_REACHED, finalAnswer = currentAnswer
               (Gr is NEVER sent — the returned answer is the one Cr, the final
                permitted review, just evaluated)
        3. else:
               build ChatGPT revision prompt from (task, currentAnswer, rawReview,
                   OPEN HIGH/MEDIUM objections)                                   [§11]
               send to ChatGPT → wait → extract → Gr
               currentAnswer = Gr
               round = r + 1, repeat
```

This is exactly the lifecycle the review requested:

```
G0 → C1 → if cleanStreak < 2 and maxRounds not reached, produce G1
        → C2 → if cleanStreak >= 2, CONVERGED and DO NOT produce G2
```

Every non-final Claude review is followed by a ChatGPT revision turn (branch 3, the
fallthrough default) **unless** branch 1 or 2 fires first. There is no other path through
this state machine, so "does `G1` happen after a clean `C1`" has exactly one answer:
yes, unless `cleanStreak` already reached `stabilityWindowRounds` on that very round (which
cannot happen on round 1, since `cleanStreak` starts at `0` and can gain at most `1` per
round — see §8.1).

`INVALID_REVIEW` can only occur while parsing `Cr` — `Gr`'s extraction is plain text, never
structured-parsed, so it cannot itself be "malformed" in the sense this design cares about.

---

## 6. Objection ledger

### 6.1 Identity

Every objection gets an engine-assigned id `OBJ-<n>`, a monotonically increasing counter
for the life of one run, never reused, never assigned by Claude. Claude is handed existing
ids back in its prompt's ledger summary (§11) and references them by that id — but the
engine **never trusts id references alone** to be the full story; see §6.5 and §7.2.

**Internal uniqueness invariant (engine-side, not a Claude-input validation):** the id
counter is a single, strictly increasing integer per run; `nextId()` is called exactly
once per genuinely-new ledger entry, so two entries can never receive the same id. This is
asserted directly by a unit test (§15, "duplicate engine IDs are structurally impossible")
rather than left as an implicit property.

**Duplicate objections within the same round's `newObjections` list:** if two entries in
one round's `newObjections` array have byte-identical normalized fingerprints (§6.5) after
normalization, they describe the same thing reported twice in one response. These are
collapsed into a single new ledger entry (the second is not created as its own id); a
history note records the collapse. This is a benign-redundancy dedup, not an
`INVALID_REVIEW` condition — Claude repeating itself within one message is not a
contradiction the way referencing an id in two conflicting buckets is (§7.2).

### 6.2 Ledger entry shape

See §10 for the exact `ObjectionLedgerEntry` type. Each entry tracks `status` (`OPEN` |
`RESOLVED` | `REJECTED`), `severity` (current effective severity), `highestSeveritySeen`
(the severity floor used on reopen, §6.6), `firstSeenRound`, `lastSeenRound`, and an
append-only `history` of typed events (`RAISED`, `REPEATED`, `PARAPHRASED`, `RESOLVED`,
`REJECTED`, `REOPENED`, `IMPLICITLY_CARRIED_OPEN`, `SEVERITY_CHANGED`,
`SEVERITY_DOWNGRADE_REJECTED`). The history is what makes the ledger auditable — a
reviewer of a finished run can read exactly when and why any given objection changed
state, without re-deriving it from raw prompts/responses. Nothing is ever silently
overwritten without a corresponding history entry: even when a `PARAPHRASED` merge updates
`summary`/`reason` to the latest wording, the prior raw text is preserved in that round's
history event `detail`, so an audit can always recover what was merged and when.

`REJECTED` is distinct from `RESOLVED`: `RESOLVED` means ChatGPT's revision addressed it;
`REJECTED` means Claude, on reflection, decided the objection itself was invalid or
inapplicable (a false alarm). Both are non-blocking and both can be reopened (§6.4)
exactly like each other, using the same severity floor rule (§6.6).

### 6.3 Ingest rules (per round, applied in this order)

| Claude's signal this round | Engine action |
|---|---|
| `id` listed in `resolvedObjectionIds` | Must be a known `OPEN` entry (else `INVALID_REVIEW`, §7.2). Set `status = RESOLVED`, append `RESOLVED` history event, update `lastSeenRound`. |
| `id` listed in `stillOpenObjections` | Must be a known `OPEN` entry (else `INVALID_REVIEW`). Append `REPEATED` history event, update `lastSeenRound`. If `severityOverride` is present, apply the severity-change rule (§6.6) — escalation is honored, downgrade is rejected-and-logged. |
| `id` listed in `reopenedObjections` | Must be a known `RESOLVED` or `REJECTED` entry (else `INVALID_REVIEW`). Force `status = OPEN`, apply the reopen severity floor (§6.6), append a `REOPENED` history event with the given `note`. |
| entry in `newObjections` (severity/summary/reason, no id — Claude cannot cite an id for something it calls new) | Compute the entry's fingerprint (§6.5) against every existing ledger entry (`OPEN` and `RESOLVED`/`REJECTED` alike), then apply the conservative matching policy (§6.5) to decide merge vs. genuinely-new. |
| an `OPEN` ledger entry not referenced anywhere in this round's `resolvedObjectionIds`/`stillOpenObjections`/`reopenedObjections`, and not fingerprint-merged by any `newObjections` entry | Stays `OPEN` unchanged; append an `IMPLICITLY_CARRIED_OPEN` history event. **This is a deliberate safety default**, not an oversight: the engine never treats silence as resolution (§13, "Claude declares success too early" / "ChatGPT ignores an objection"). |

Every id referenced in `resolvedObjectionIds`/`stillOpenObjections`/`reopenedObjections`
is additionally checked against the **contradiction and duplication rules in §7.2** before
any of the actions above are applied — those checks happen first, as part of validating
the parsed payload, not as a side effect of ingest.

### 6.4 Distinguishing new / repeated / paraphrased / resolved / reopened

| Situation | How it's detected | Classification |
|---|---|---|
| Claude cites a known `OPEN` id in `stillOpenObjections` | exact id match | **Repeated** (same objection, still open) |
| Claude cites a known `OPEN` id in `resolvedObjectionIds` | exact id match | **Resolved** |
| Claude cites a known `RESOLVED`/`REJECTED` id in `reopenedObjections` | exact id match, explicit | **Reopened** (explicit) |
| A `newObjections` entry's fingerprint clears the conservative merge bar (§6.5) against an `OPEN` ledger entry | high-confidence, unique lexical match, no id given | **Paraphrased** — merged into the existing id, `PARAPHRASED` history event, **not** counted as new for stability purposes |
| A `newObjections` entry's fingerprint clears the conservative merge bar against a `RESOLVED`/`REJECTED` ledger entry | high-confidence, unique lexical match, no id given | **Reopened** (fingerprint-derived) — same handling as an explicit reopen, including the severity floor (§6.6) |
| A `newObjections` entry's fingerprint scores above the candidate floor but does **not** clear the merge bar (too weak, or ambiguous — tied with another candidate) | weak or ambiguous similarity | **Genuinely new** — a fresh `OBJ-<n>` id is assigned; a `possible duplicate of OBJ-<k>` note is attached to the `RAISED` history event for audit only, never affecting the decision |
| A `newObjections` entry matches nothing above the candidate floor | no meaningful overlap | **Genuinely new**, no duplicate note |
| A known `OPEN` id is mentioned nowhere this round | absence | **Implicitly carried open** (§6.3) — recorded so the audit trail shows the engine, not Claude, kept it open |

### 6.5 Deterministic normalization / conservative matching

**Why false-new must be preferred over false-merge.** A false split (treating one real
objection as two ledger entries) costs at most a few extra review rounds — annoying, but
safe, since both entries independently keep blocking convergence until resolved. A false
merge is worse and can be silent: if a genuinely new HIGH/MEDIUM objection gets folded into
an existing entry's identity, that entry's `summary`/`reason` is overwritten to describe
the *new* issue, and the *original* issue's distinct tracking is lost. If ChatGPT then
fixes only the newly-merged-in issue and Claude marks that same id `RESOLVED`, the engine
believes both issues are gone — `openHigh`/`openMedium` can drop to `0` even though the
original problem was never actually fixed. That is a direct path to **false convergence**,
which is the single worst outcome this whole design exists to prevent. The matching policy
is therefore deliberately biased toward under-merging.

**Normalization** (unchanged from the first draft):

```ts
const STOPWORDS = new Set([
  "the","a","an","and","or","but","is","are","was","were","be","to","of","in","on",
  "for","with","this","that","it","as","by","at","from","not","no",
]);

function normalizeForFingerprint(text: string): Set<string> {
  return new Set(
    text.toLowerCase().normalize("NFKD")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(tok => tok.length > 2 && !STOPWORDS.has(tok)),
  );
}

function diceCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const tok of a) if (b.has(tok)) overlap += 1;
  return (2 * overlap) / (a.size + b.size);
}
```

The fingerprint input is `summary + " " + reason` concatenated (both fields, so a
paraphrase that only reorders which sentence carries the key noun still matches).

**Conservative merge policy (revised).** For each `newObjections` entry `E`, compute
`diceCoefficient(E, X)` against every existing ledger entry `X` (any status), and sort
descending. Let `best` be the top score and `secondBest` the next-highest score (`0` if
there is no second candidate).

```ts
export interface ConvergenceOptions {
  // ...
  fingerprintMergeThreshold: number;      // default 0.85 — auto-merge floor
  fingerprintAmbiguityMargin: number;     // default 0.15 — required gap over 2nd-best
  fingerprintMinSharedTokens: number;     // default 3   — minimum overlapping tokens
  fingerprintCandidateThreshold: number;  // default 0.60 — floor for a logged "possible
                                           //                duplicate" note (audit only)
}

function classifyNewObjection(E, ledger, options): "MERGE" | "NEW" {
  const scored = ledger.map(x => ({ x, score: diceCoefficient(E, x), shared: sharedTokenCount(E, x) }))
                        .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const secondBestScore = scored[1]?.score ?? 0;
  const isUnique = (best?.score ?? 0) - secondBestScore >= options.fingerprintAmbiguityMargin;
  const isHighConfidence = (best?.score ?? 0) >= options.fingerprintMergeThreshold;
  const hasEnoughOverlap = (best?.shared ?? 0) >= options.fingerprintMinSharedTokens;
  if (best && isHighConfidence && isUnique && hasEnoughOverlap) return "MERGE"; // merge into best.x
  return "NEW"; // best (if any) only recorded as an audit note when >= candidateThreshold
}
```

Automatic merge requires **all three** conditions at once: a high absolute score
(`>= 0.85`), a clear margin over the next-best candidate (`>= 0.15`, so two
similarly-plausible candidates never get silently picked between — "never choose the
closest objection merely because one exists"), and a minimum absolute overlap
(`>= 3` shared informative tokens, so two short, generically-worded objections don't
spuriously hit a high Dice score on too little real content). Any weaker or ambiguous case
stays a distinct new objection. This is intentionally stricter than the first draft's flat
`0.6` threshold, which is now only the floor for a **non-binding audit annotation**, never
for an automatic merge decision.

**Known limitation, stated plainly:** this is lexical overlap, not semantic understanding,
and the conservative bar means some true paraphrases with low token overlap ("the retry
loop doesn't back off on failure" vs. "missing exponential backoff on retries") will
**not** auto-merge and will be tracked as two ledger entries instead. This is the accepted,
intended tradeoff: an occasional false split costs a round or two; the false merge it
prevents could otherwise cost run correctness itself (§16, open question 1).

### 6.6 Severity rules

Severity must never become a convergence escape hatch — an objection cannot quietly
de-escalate from blocking to non-blocking just because a later round's wording sounds
milder.

1. **Initial severity.** A genuinely new objection (§6.4) is created with exactly the
   severity Claude reported. `severity` and `highestSeveritySeen` both start at that
   value.
2. **Escalation is always allowed.** While an entry is `OPEN`, a `severityOverride` (from
   `stillOpenObjections`/`reopenedObjections`, or from the severity of a merged-in
   `newObjections` entry) that ranks *higher* (`LOW < MEDIUM < HIGH`) than the entry's
   current `severity` is applied immediately: `severity` is raised, `highestSeveritySeen`
   is raised to match if it wasn't already at least that high, and a `SEVERITY_CHANGED`
   history event records the change. Escalation only ever makes the engine more
   conservative, so it is never rejected.
3. **Downgrade of an OPEN HIGH/MEDIUM objection is rejected, not applied.** A
   `severityOverride` that ranks *lower* than the entry's current severity while the entry
   is still `OPEN` does **not** change `severity` — the attempt is recorded as a
   `SEVERITY_DOWNGRADE_REJECTED` history event (old severity, attempted severity) and the
   objection keeps blocking at its prior severity. **The only way to stop a HIGH/MEDIUM
   objection from blocking is an explicit `RESOLVED`.** Worked example, exactly as raised
   in review: `OBJ-3` is `MEDIUM`/`OPEN` after round 1; round 2's review restates the same
   substantive issue but labels it `LOW` via `stillOpenObjections: [{ id: "OBJ-3",
   severityOverride: "LOW" }]` — `OBJ-3` remains `MEDIUM`/`OPEN`, the downgrade is logged
   and ignored, and it still blocks convergence.
4. **Reopening floors at the historical peak.** When an entry is reopened (explicit or
   fingerprint-derived, §6.4), its new `severity` is
   `max(highestSeveritySeen, reportedSeverityOverride ?? severity-at-time-of-resolution)`
   — it can never come back weaker than the worst it was ever confirmed to be while
   blocking. Worked example, exactly as raised in review: `OBJ-3` was `MEDIUM`, then
   `RESOLVED`; later the same issue reappears (explicitly reopened, or fingerprint-matched
   from `newObjections`) reported as `LOW` — the reopened `OBJ-3` is floored to `MEDIUM`,
   not `LOW`, and a `SEVERITY_CHANGED` event records the floor being applied. An
   explicit escalating override on reopen (e.g. reopened as `HIGH` when the peak was only
   `MEDIUM`) is still honored upward, per rule 2.
5. **Severity history is retained.** Every `SEVERITY_CHANGED` and
   `SEVERITY_DOWNGRADE_REJECTED` event is appended to `history`, never overwritten —
   `highestSeveritySeen` itself is also visible on the entry so a reader never has to
   replay history just to find the floor.

---

## 7. Structured Claude review contract

**This section replaces the first draft's line-based `STATUS:`-style format.** A
hand-rolled line grammar cannot safely guarantee that a section header string appearing
inside free-form `summary`/`reason` text is never mistaken for actual structure, and
cannot represent multiline `reason` text without ad hoc greedy-boundary rules. Both risks
disappear by using a **sentinel-delimited JSON payload**: JSON's own string-escaping rules
make embedded delimiter-like text and multiline content unambiguous by construction, and a
schema validator gives exact, deterministic accept/reject behavior for missing, duplicated,
or unknown fields.

```
BEGIN_STRUCTURED_REVIEW
{
  "reviewStatus": "CONTINUE",
  "resolvedObjectionIds": ["OBJ-1"],
  "stillOpenObjections": [
    { "id": "OBJ-3", "severityOverride": "MEDIUM" }
  ],
  "reopenedObjections": [
    { "id": "OBJ-2", "note": "the same race condition reappeared after the revision", "severityOverride": "HIGH" }
  ],
  "newObjections": [
    { "severity": "LOW", "summary": "inconsistent heading capitalization", "reason": "section 2 uses Title Case, section 3 uses sentence case" }
  ],
  "reviewNotes": "Overall the revision addresses the correctness issue; remaining points are cosmetic."
}
END_STRUCTURED_REVIEW
```

`severityOverride` on `stillOpenObjections`/`reopenedObjections` entries is optional.
`reviewNotes` is optional. Every other top-level field is required, even if empty
(`resolvedObjectionIds: []`, `newObjections: []`, etc. — there is no "NONE" sentinel; an
empty JSON array is the one way to say "nothing in this bucket").

### 7.1 Parsing rules (deterministic, fail-safe)

1. **Delimiters.** Scan the raw text for lines that, after trimming leading/trailing
   whitespace, exactly equal `BEGIN_STRUCTURED_REVIEW` or `END_STRUCTURED_REVIEW`. Exactly
   one of each must be present, with `BEGIN` strictly before `END`. Zero occurrences,
   more than one occurrence of either, or `END` before `BEGIN` → `INVALID_REVIEW`
   (`"missing or duplicated structured-review delimiters"`). Any text before `BEGIN` or
   after `END` is discarded unread — it is never parsed or validated, which is what lets
   Claude add conversational preamble/postamble around the block without breaking parsing.
2. **JSON syntax.** The exact text strictly between the `BEGIN`/`END` lines (not including
   the sentinel lines themselves) is passed to a JSON parser. A syntax error →
   `INVALID_REVIEW` (`"structured review body is not valid JSON: <parse error>"`). Because
   this is standard JSON, delimiter-like substrings and multiline text inside any string
   field (`summary`, `reason`, `note`, `reviewNotes`) are handled by ordinary JSON string
   escaping (`\n` for newlines, `\"` for quotes) — they can never be mistaken for
   structural tokens, which fully resolves the "delimiters inside objection text" and
   "multiline reason text" requirements without any bespoke escaping rules.
3. **Schema validation**, applied to the parsed object:
   - Top level must be a JSON object with **exactly** these keys:
     `reviewStatus`, `resolvedObjectionIds`, `stillOpenObjections`, `reopenedObjections`,
     `newObjections` (all required) and `reviewNotes` (optional). Any missing required key
     or any key outside this set → invalid (`"missing field <x>"` / `"unknown field <x>"`).
   - `reviewStatus`: string, exactly `"CONTINUE"` or `"CANDIDATE_CONVERGED"` — anything
     else is invalid. This field is **advisory only** (§4, §8) — logged, including a
     mismatch warning if it disagrees with the engine's own decision, but never used to
     decide anything.
   - `resolvedObjectionIds`: array of strings, each matching `/^OBJ-\d+$/`; no duplicate
     strings within the array.
   - `stillOpenObjections`: array of objects, each with required `id` (`/^OBJ-\d+$/`) and
     optional `severityOverride` (`"HIGH"|"MEDIUM"|"LOW"`), no other keys; no duplicate
     `id` within the array.
   - `reopenedObjections`: array of objects, each with required `id` (`/^OBJ-\d+$/`),
     required non-empty `note` (string), and optional `severityOverride`, no other keys;
     no duplicate `id` within the array.
   - `newObjections`: array of objects, each with required `severity`
     (`"HIGH"|"MEDIUM"|"LOW"`), required non-empty `summary` (string, trimmed non-empty),
     and required non-empty `reason` (string, trimmed non-empty), no other keys.
   - `reviewNotes`: string if present; never validated for content, never used in
     decisions.
   - Any type mismatch anywhere in the above → invalid, with a field-path-specific reason
     (e.g. `"newObjections[1].severity must be HIGH, MEDIUM, or LOW"`).
4. **Ledger-id cross-validation** — see §7.2. This runs after schema validation succeeds
   and before ingest (§6.3).

Malformed or unparseable output — per any rule above — **never** produces a result that
could be mistaken for `CONVERGED`. The parser's return type makes this structural, not a
convention to remember (§10): it is either a fully-valid `StructuredClaudeReview` or an
explicit `{ invalid: true; reason: string }`, with no partial/best-effort middle ground.

### 7.2 Ledger-id validation (every case that produces `INVALID_REVIEW`)

Checked as one pass over the whole parsed payload, against the ledger state as of the
**start** of this round (`knownIds`):

| Condition | Result |
|---|---|
| An id in `resolvedObjectionIds` is not a known `OPEN` entry (unknown id, or known but already `RESOLVED`/`REJECTED`) | `INVALID_REVIEW` — `"unknown or non-open objection id in resolvedObjectionIds: <id>"` |
| An id in `stillOpenObjections` is not a known `OPEN` entry | `INVALID_REVIEW` — `"unknown or non-open objection id in stillOpenObjections: <id>"` |
| An id in `reopenedObjections` is not a known `RESOLVED`/`REJECTED` entry | `INVALID_REVIEW` — `"unknown or non-reopenable objection id in reopenedObjections: <id>"` |
| The same id appears in more than one of `resolvedObjectionIds` / `stillOpenObjections` / `reopenedObjections` in the same review | `INVALID_REVIEW` — `"objection id <id> appears in contradictory buckets: <bucket1>, <bucket2>"` |
| The same id appears more than once **within** a single bucket's array | `INVALID_REVIEW` — `"duplicate objection id <id> within <bucket>"` |
| Round 1 (empty ledger, `knownIds` is empty) but `resolvedObjectionIds`, `stillOpenObjections`, or `reopenedObjections` is non-empty | `INVALID_REVIEW` — `"objection id referenced before any ledger exists"` |
| `newObjections` contains an entry with an invalid `severity` value | caught at schema validation (§7.1 rule 3), same `INVALID_REVIEW` outcome |
| A `newObjections` entry is missing/empty `summary` or `reason`, or has an extra/unknown field | caught at schema validation, same outcome |
| The structured block is missing a required top-level field, has an unknown top-level field, or fails the delimiter/JSON-syntax checks | caught at §7.1 rules 1–3, same outcome |

**What is explicitly *not* invalid:** an `OPEN` id that is simply absent from every bucket
this round. Per §6.3, this is `IMPLICITLY_CARRIED_OPEN` — silence about an existing open
objection is never interpreted as resolution, and this rule is unchanged from the first
draft. The contradiction/duplication rules above only fire when Claude's output actively
disagrees with itself or with the ledger, never on mere omission.

---

## 8. ConvergenceEngine decision rule

### 8.1 Clean round — exact definition

A **clean round** means, immediately after ingesting round `r`'s review into the ledger,
all four of the following hold:

1. Zero `OPEN` `HIGH` objections.
2. Zero `OPEN` `MEDIUM` objections.
3. Zero new `HIGH`/`MEDIUM` objections were raised in this review (i.e. no ledger entry
   has `severity ∈ {HIGH, MEDIUM}` and `firstSeenRound === r`).
4. Zero `HIGH`/`MEDIUM` objections were reopened in this review (i.e. no ledger entry has
   a `REOPENED` history event at round `r` with `severity ∈ {HIGH, MEDIUM}` at the time of
   that event).

A round that resolves the very last open blocker **does** count as clean if all four
conditions hold once ingest is finished — resolving-and-having-nothing-else-open is
exactly what "clean" means; there is no separate exemption needed (§15, test "C1 resolves
final MEDIUM and otherwise clean").

**Derived simplification, stated explicitly because it matters for correctness.** Because
`resolvedObjectionIds` may only reference ids that existed in the ledger *before* this
round's ingest began (§7.2), a HIGH/MEDIUM entry raised-or-reopened *during* round `r` can
never also be resolved during that same round's ingest — there is no code path that could
un-introduce it before the round ends. Consequently, conditions 3 and 4 are **always**
already true whenever conditions 1 and 2 are true, and the whole four-part definition
reduces to a simple, directly-computable check:

```
isCleanRound(r)  :=  openHigh(r) === 0  AND  openMedium(r) === 0
```

This equivalence is asserted by a dedicated unit test (§15), not just claimed in prose,
because it is the basis for the corrected stability-window rule below.

### 8.2 The stability window — corrected rule

**This is the bug fix from architect review round 2.** The first draft reset `cleanStreak`
to `0` only when a round *introduced* a new-or-reopened HIGH/MEDIUM objection, and treated
every other round (including one where an *old*, still-unaddressed HIGH/MEDIUM objection
was simply sitting open, untouched, unmentioned) as if it still counted toward the streak.
That allowed `cleanStreak` to silently pre-accumulate across rounds while a real blocker
remained open, so the round that finally resolved it could immediately satisfy
`cleanStreak >= 2` from credit earned *before* the objection was ever actually cleared —
converging off effectively one truly-clean round, not two. §7 of the review's feedback
("C1 resolves final MEDIUM and otherwise clean → streak=1 → G1 → C2 clean → converge")
is the correct behavior, and it requires resetting on **any** non-clean round, not only on
ones with something newly introduced.

Corrected rule:

```
cleanStreak(0) := 0   // before round 1

cleanStreak(r) := isCleanRound(r)  ?  cleanStreak(r-1) + 1  :  0
```

`cleanStreak` resets to `0` on **every** round that is not fully clean — whether the cause
is a brand-new HIGH/MEDIUM, a reopened one, or simply an old one that nobody addressed this
round. There is no partial credit and no "pause without resetting." A malformed review
never reaches this computation at all (§8.3).

### 8.3 Decision, per round (single checkpoint, restated from §5)

```
CONVERGED            iff  isCleanRound(r) AND cleanStreak(r) >= stabilityWindowRounds (default 2)
MAX_ROUNDS_REACHED   iff  NOT CONVERGED AND r === maxRounds
CONTINUE             otherwise   (Gr is produced, round becomes r + 1)
INVALID_REVIEW       iff  Cr's raw text fails to parse (§7) — checked before any of the above;
                          cleanStreak and the ledger are left exactly as they were at the
                          end of round r-1, since this round never validly happened
```

Worked consequences, matching every explicit requirement one-for-one:

- **A single clean round is never enough** (§15 test "one clean round insufficient"):
  round 1 clean → `cleanStreak = 1`, which is `< 2` → `CONTINUE`, so `G1` is still
  produced. Only if round 2 is *also* clean does `cleanStreak` reach `2` and convergence
  trigger, with `finalAnswer = G1` (no `G2` sent).
- **Two consecutive clean rounds converge.**
- **A new MEDIUM (or HIGH) after one clean round resets the window:** the round is no
  longer clean (`openMedium(r) > 0`), so `cleanStreak` resets to `0` per §8.2, regardless
  of how high it had climbed.
- **A resolved HIGH/MEDIUM reappearing reopens it and resets the window:** reopening sets
  `status = OPEN`, so the round is not clean, so `cleanStreak` resets — same mechanism, no
  special case needed.
- **A resolved objection that stays resolved does not reset anything:** it contributes
  `0` to `openHigh`/`openMedium`, so it cannot make a round non-clean by itself.
- **Repeated LOW issues never block:** `openHigh`/`openMedium` only ever count `HIGH`/
  `MEDIUM` severities; LOW churn is invisible to `isCleanRound`.
- **The ledger persists correctly across many rounds:** every ingest updates the same
  in-memory ledger array, carried forward by the orchestrator loop across all rounds of
  one run — nothing is recomputed from scratch each round.
- **maxRounds always yields a Claude-reviewed final answer:** `MAX_ROUNDS_REACHED` is only
  reached *after* ingesting `Cr` for `r === maxRounds` — `Gr` for that round is never
  requested, so `finalAnswer` is always the answer that the final permitted Claude review
  actually evaluated (§8.4).

### 8.4 maxRounds semantics, restated plainly

`maxRounds` (default `10`) is the maximum number of **Claude review rounds** (`C1` through
`C(maxRounds)`), not a count of ChatGPT turns. `G0` is the initial answer and is not itself
a round. At round `r`:

1. Parse and ingest `Cr`.
2. Evaluate convergence (§8.3).
3. If `CONVERGED` → return `currentAnswer` (the answer `Cr` just reviewed). `Gr` is never
   generated.
4. Else if `r === maxRounds` → return `MAX_ROUNDS_REACHED` with `currentAnswer` (the answer
   `Cr` — the final permitted review — just evaluated). `Gr` is never generated.
5. Else → generate `Gr`, and it becomes the next round's `currentAnswer`.

The practical effect: reaching `maxRounds` without converging costs exactly `maxRounds`
Claude calls and `maxRounds` ChatGPT calls in total (`G0` through `G(maxRounds-1)`) — one
fewer ChatGPT call than Claude calls, because the final review is never followed by an
unreviewed revision. This is a deliberate choice, not an oversight: the review explicitly
requires "the answer returned on `MAX_ROUNDS_REACHED` has at least been reviewed by the
final Claude review," and generating one more ChatGPT turn after the budget is exhausted
would hand back an answer nobody ever checked. No alternative is proposed here since the
review's rule is unambiguous and directly adopted.

---

## 9. Invalid review handling

Per the task's explicit preference: **`INVALID_REVIEW` → stop safely with a structured
error.** No automatic reformat-and-resend is implemented in Milestone 4B.

- A parse failure immediately stops the run. `stopReason = INVALID_REVIEW`.
  `finalAnswer` = the last known-good `currentAnswer` (i.e. `G[r-1]`, the answer Claude was
  reviewing when it produced the malformed output). The raw, unparsed Claude text and the
  specific parse-failure reason (§7.1/§7.2) are preserved on the result/error for human
  inspection. The ledger and `cleanStreak` are left exactly as they were at the end of the
  prior round (§8.3) — an invalid review contributes nothing to either.
- **No automatic resend of the same browser turn.** `Cr`'s `sendPrompt` call is never
  repeated — the same "one send per logical turn" invariant Milestone 4A established
  (§2), simply extended to cover the new structured-review turn kind.
- **On a repair mechanism, if one is ever added later:** it must not violate that
  invariant. The only shape that would satisfy this is a **distinct, new logical turn** —
  e.g. a follow-up message in the same conversation, of a new `TurnKind` such as
  `"invalid_review_reformat"`, sent exactly once, with its own single `sendPrompt` call and
  its own stage. It must never re-issue the *same* `Cr` send. Milestone 4B does **not**
  build this turn kind — it is recorded here only so a future agent doesn't quietly bolt a
  same-turn retry loop onto the parser instead. See §16, open question 2.

---

## 10. Data model

New types, in a new module `src/orchestration/convergence/types.ts` (kept separate from
`runFixedReviewLoop.ts`'s types, which are untouched).

```ts
export type ReviewSeverity = "HIGH" | "MEDIUM" | "LOW";
export type ObjectionStatus = "OPEN" | "RESOLVED" | "REJECTED";

export interface ObjectionHistoryEvent {
  round: number;
  kind:
    | "RAISED" | "REPEATED" | "PARAPHRASED" | "RESOLVED" | "REJECTED"
    | "REOPENED" | "IMPLICITLY_CARRIED_OPEN"
    | "SEVERITY_CHANGED" | "SEVERITY_DOWNGRADE_REJECTED";
  detail?: string;
}

export interface ObjectionLedgerEntry {
  id: string;                        // "OBJ-<n>", engine-assigned, never reused
  severity: ReviewSeverity;          // current effective severity
  highestSeveritySeen: ReviewSeverity; // monotonic peak; floors severity on reopen (§6.6)
  summary: string;                   // latest wording
  reason: string;                    // latest wording; prior wording remains in history
  status: ObjectionStatus;
  firstSeenRound: number;
  lastSeenRound: number;
  relatesToObjectionId?: string;     // reserved for future manual/audit annotation;
                                      // never populated by Milestone 4B's own logic
  normalizedFingerprint: string[];   // sorted token array, for matching (§6.5)
  history: ObjectionHistoryEvent[];
}

export interface RawNewObjection {
  severity: ReviewSeverity;
  summary: string;
  reason: string;
}

export interface StructuredClaudeReview {
  reviewStatus: "CONTINUE" | "CANDIDATE_CONVERGED"; // advisory only, never decides anything
  resolvedObjectionIds: string[];
  stillOpenObjections: { id: string; severityOverride?: ReviewSeverity }[];
  reopenedObjections: { id: string; note: string; severityOverride?: ReviewSeverity }[];
  newObjections: RawNewObjection[];
  reviewNotes?: string;
  rawText: string;
}

export interface InvalidReview {
  invalid: true;
  reason: string;      // e.g. "unknown or non-open objection id in stillOpenObjections: OBJ-9"
  rawText: string;
}

export interface ConvergenceOptions {
  maxRounds: number;                       // default 10; bounds Claude review rounds (§8.4)
  stabilityWindowRounds: number;           // default 2 — fixed by spec, exposed for testability
  fingerprintMergeThreshold: number;       // default 0.85 (§6.5)
  fingerprintAmbiguityMargin: number;      // default 0.15 (§6.5)
  fingerprintMinSharedTokens: number;      // default 3 (§6.5)
  fingerprintCandidateThreshold: number;   // default 0.60 (§6.5)
}

export type ConvergenceDecisionKind =
  | "CONTINUE" | "CONVERGED" | "MAX_ROUNDS_REACHED" | "INVALID_REVIEW";

export interface ConvergenceDecision {
  kind: ConvergenceDecisionKind;
  round: number;
  reason: string;               // human-readable, e.g. "2 consecutive clean rounds, no open HIGH/MEDIUM"
  cleanStreak: number;
  openHighCount: number;
  openMediumCount: number;
  openLowCount: number;
}

export interface ConvergenceRoundSnapshot {
  round: number;
  decision: ConvergenceDecision;
  ledgerSnapshot: ObjectionLedgerEntry[];   // full ledger state after this round's ingestion
}

export interface ConvergenceHistory {
  rounds: ConvergenceRoundSnapshot[];
}

// Round record shape needed for future persistence (§12) — not written to disk in 4B.
export interface ConvergenceRoundRecord {
  roundNumber: number;
  claudeReviewPrompt: string;
  claudeReviewRawResponse: string;
  claudeStructuredReview: StructuredClaudeReview | null;  // null only if this round was INVALID_REVIEW
  decision: ConvergenceDecision;
  chatgptRevisionPrompt?: string;     // absent when the round converged or hit maxRounds
                                       // before a revision was requested (§5, §8.4)
  chatgptRevisionResponse?: string;   // absent likewise
  claudeStartedAt: string;
  claudeCompletedAt: string;
  chatgptStartedAt?: string;
  chatgptCompletedAt?: string;
}

export interface ConvergedReviewResult {
  originalTask: string;
  maxRounds: number;
  stopReason: "CONVERGED" | "MAX_ROUNDS_REACHED" | "INVALID_REVIEW";
  finalAnswer: string;
  initial: { prompt: string; response: string; startedAt: string; completedAt: string }; // same shape as 4A's InitialChatGptTurn
  rounds: ConvergenceRoundRecord[];
  ledger: ObjectionLedgerEntry[];
  convergenceHistory: ConvergenceHistory;
  invalidReview?: { round: number; rawText: string; reason: string };  // present only if stopReason === "INVALID_REVIEW"
}
```

`ConvergenceReviewLoopError` mirrors Milestone 4A's `FixedReviewLoopError` shape (a stage,
a message, a partial result, an optional cause) so error handling in a future caller looks
familiar; it is not shown in full here since it is structurally identical to the existing
class with a renamed partial-result type.

---

## 11. Prompt design

New pure module `src/orchestration/convergence/convergencePrompts.ts`. Neither prompt
depends on DOM/page state — both are built purely from `task`, `currentAnswer`, and the
in-memory ledger. Both instruct Claude to produce valid, properly-escaped JSON (newlines
as `\n`, quotes as `\"`) inside the sentinel block.

**Claude review prompt — round 1** (`buildConvergenceClaudeReviewPrompt(task, answer, [], 1)`):
```
You are Claude. Review the following answer produced by ChatGPT.

TASK:
---
<task>
---

CURRENT CHATGPT ANSWER:
---
<answer>
---

This is round 1 of an iterative review. There is no prior objection ledger yet.

Identify concrete objections that materially affect correctness, completeness, or
quality. Classify each one:
  HIGH   — a correctness or safety defect that must be fixed.
  MEDIUM — a significant completeness or quality gap.
  LOW    — a minor or stylistic point that does not need to block acceptance.
Do not invent speculative objections merely to keep the review going.

Respond with exactly one structured block, and nothing else inside it besides valid JSON:

BEGIN_STRUCTURED_REVIEW
{
  "reviewStatus": "CONTINUE" or "CANDIDATE_CONVERGED",
  "resolvedObjectionIds": [],
  "stillOpenObjections": [],
  "reopenedObjections": [],
  "newObjections": [
    { "severity": "HIGH" or "MEDIUM" or "LOW", "summary": "<one line>", "reason": "<evidence>" }
  ],
  "reviewNotes": "<optional>"
}
END_STRUCTURED_REVIEW

resolvedObjectionIds, stillOpenObjections, and reopenedObjections must all be empty
arrays in round 1 — there is nothing yet to reference. Use escaped \n for any line breaks
inside a string. You may write ordinary prose before or after the block; only the block
itself is read.
```

**Claude review prompt — round N ≥ 2** (`buildConvergenceClaudeReviewPrompt(task, answer, openLedgerEntries, N)`):
```
You are Claude. Review the latest revised answer produced by ChatGPT.

TASK:
---
<task>
---

LATEST CHATGPT ANSWER:
---
<answer>
---

OPEN OBJECTION LEDGER FROM PRIOR ROUNDS (RESOLVED/REJECTED objections are omitted):
- OBJ-1 [HIGH] <summary> — <reason>
- OBJ-3 [MEDIUM] <summary> — <reason>

For every open objection above, decide whether it is now resolved or still open in the
latest answer, and reference it by id — do not restate it as a new objection. Separately,
if you believe an objection you previously marked resolved or rejected has reappeared,
reference its id under reopenedObjections with a note explaining why, rather than raising
it again as new. Then list any genuinely new objections not already covered by an id
above.

Respond with exactly one structured block, and nothing else inside it besides valid JSON:

BEGIN_STRUCTURED_REVIEW
{
  "reviewStatus": "CONTINUE" or "CANDIDATE_CONVERGED",
  "resolvedObjectionIds": ["OBJ-1"],
  "stillOpenObjections": [{ "id": "OBJ-3" }],
  "reopenedObjections": [],
  "newObjections": [],
  "reviewNotes": "<optional>"
}
END_STRUCTURED_REVIEW

Only reference ids listed in the ledger above. Use escaped \n for any line breaks inside
a string. You may write ordinary prose before or after the block; only the block itself is
read.
```

**ChatGPT revision prompt** (`buildConvergenceChatGptRevisionPrompt(task, previousAnswer, claudeRawReview, openHighMediumObjections)`) — sent only when the round's decision is `CONTINUE` (§5, §8.3):
```
You are ChatGPT. Revise your previous answer to address the reviewer's open objections.

TASK:
---
<task>
---

YOUR PREVIOUS ANSWER:
---
<previousAnswer>
---

LATEST CLAUDE REVIEW:
---
<claudeRawReview>
---

UNRESOLVED HIGH/MEDIUM OBJECTIONS YOU MUST ADDRESS:
- [HIGH] <summary>: <reason>
- [MEDIUM] <summary>: <reason>
(if this list is empty, there are no blocking objections — keep your previous answer's
substance unchanged unless a LOW-severity suggestion from the review clearly warrants a
small, harmless improvement; do not make speculative or unrequested changes)

Provide your COMPLETE revised, standalone answer to the original task. Return the answer
itself, not commentary about the review, not a changelog, and not any structured review
output.
```

Every field the task requires is present: the Claude prompt carries the original task, the
current answer, and the prior-objection-ledger summary, plus the strict output contract;
the ChatGPT prompt carries the original task, the previous complete answer, the latest
Claude review, the unresolved HIGH/MEDIUM objections, and an explicit "return a COMPLETE
answer" instruction, plus explicit guidance for the empty-objections case (a no-op or
minor harmless revision is allowed, matching the review's requirement). Neither depends on
tab/DOM state — both are plain string functions, independently unit-testable exactly like
`fixedReviewPrompts.ts`'s builders.

---

## 12. Persistence-ready round record (not implemented)

`ConvergenceRoundRecord` and `ConvergedReviewResult` (§10) are shaped so a future
persistence layer (`PHASE2_DESIGN.md` §7's `runs/<run-id>/` design) could serialize them
directly to `rounds/round-NN-claude.json` / `round-NN-chatgpt.json` and a top-level
`ledger.json`/`state.json` without restructuring: every field is plain, JSON-serializable
data (strings, numbers, arrays of plain objects) — no class instances, no functions, no
`Page`/adapter references. Milestone 4B does not write any of this to disk; `runs/` is not
touched.

---

## 13. False-convergence cases — how each is actually prevented

| Case | Mechanism that prevents it |
|---|---|
| Claude declares success too early | `cleanStreak >= 2` is required even when round 1 is immediately clean (§8.2/§8.3) — one good review is structurally insufficient. |
| Same objection reworded | Conservative fingerprint matching (§6.5) merges a high-confidence, unambiguous paraphrase back into the existing `OPEN` id as `PARAPHRASED`; a weak or ambiguous match is deliberately left as a new entry instead (fail toward false-split, never false-merge). |
| Resolved objection returns | Explicit `reopenedObjections` reference, or a high-confidence fingerprint match against a `RESOLVED`/`REJECTED` entry, both force `status = OPEN`, apply the severity floor (§6.6), and make the round non-clean, resetting `cleanStreak` (§8.2). |
| New MEDIUM appears after one clean round | The round is no longer clean (`openMedium > 0`), `cleanStreak` resets to `0` (§8.2). |
| New HIGH appears after one clean round | Same mechanism. |
| Only LOW objections remain | `openHigh`/`openMedium` are both `0`; LOW never enters either count (§8.1). |
| Endless LOW nitpicks | LOW churn never makes a round non-clean, so `cleanStreak` keeps climbing regardless (§8.2). |
| ChatGPT ignores an objection | If Claude correctly still lists it under `stillOpenObjections`, it blocks normally. If Claude carelessly omits it, `IMPLICITLY_CARRIED_OPEN` keeps it `OPEN` anyway (§6.3) — silence is never resolution. If Claude tries to downgrade it away instead of resolving it, the downgrade is rejected (§6.6, rule 3). (Residual, documented limit: if Claude actively and incorrectly marks it `RESOLVED`, the engine cannot independently verify ChatGPT's text — that is Claude's reviewing job; §16, open question 3.) |
| Claude contradicts prior review | Contradictory bucket placement for the same id within one review is `INVALID_REVIEW` (§7.2) — Claude cannot, in a single response, call the same id both resolved and still-open. Contradictions *across* rounds (resolve, then later reopen) are fully visible in `history` and correctly rerun the stability window. |
| Malformed review | §7's parser never returns anything convergence-shaped for invalid input; §9's `INVALID_REVIEW` stop applies, and `cleanStreak` is left untouched (§8.3). |
| maxRounds reached | The decision priority order in §8.3 checks `MAX_ROUNDS_REACHED` only after confirming `CONVERGED` is false, and it is a distinct `stopReason` — never mislabeled, and it never generates an unreviewed trailing revision (§8.4). |

---

## 14. File / module plan

**New files (none created by this design turn):**
- `src/orchestration/convergence/types.ts` (§10)
- `src/orchestration/convergence/fingerprint.ts` (§6.5)
- `src/orchestration/convergence/structuredReviewParser.ts` (§7)
- `src/orchestration/convergence/objectionLedger.ts` (§6, including the severity floor/
  reject rules of §6.6 — kept in the same module since they mutate ledger entries as part
  of the same ingest pass, not split into a separate file)
- `src/orchestration/convergence/convergenceEngine.ts` (§8)
- `src/orchestration/convergence/convergencePrompts.ts` (§11)
- `src/orchestration/runConvergenceReviewLoop.ts` (§3, §5)
- `scripts/smoke-convergence.ts` + `npm run smoke:convergence` (real-site manual smoke,
  mirroring `scripts/smoke-multi-round.ts`'s structure — CDP connect, discover tabs, run,
  print, exit code; deterministic small task; prints the ledger and stop reason)
- `tests/unit/structuredReviewParser.spec.ts`
- `tests/unit/objectionLedger.spec.ts`
- `tests/unit/convergenceEngine.spec.ts`
- `tests/unit/convergencePrompts.spec.ts`
- `tests/unit/runConvergenceReviewLoop.spec.ts`

**Explicitly untouched:**
- `src/sites/siteTypes.ts`, `src/sites/chatgptSite.ts`, `src/sites/claudeSite.ts`,
  `src/sites/claudeUserTurns.ts`, `src/browser/domUtil.ts`, `src/sites/selectors/*`.
- `src/orchestration/runFixedReviewLoop.ts`, `src/orchestration/fixedReviewPrompts.ts`,
  `scripts/smoke-multi-round.ts`, and every Milestone 4A test file.
- `src/config/loadConfig.ts`, `config/config.json` — `maxRounds` stays a call parameter
  for 4B, matching 4A's §14 decision to keep `reviewRounds`/`maxRounds` out of the config
  schema until a real persistence layer needs a home for per-run settings.

---

## 15. Test plan

All tests run offline against pure inputs — no Playwright `Page` for the
engine/ledger/parser tests (they are pure functions), and fake in-memory
`ConversationalSiteAdapter`s (Milestone 4A's pattern) for the loop-integration test.

### 15.1 Original 16-case matrix (updated to the corrected rules)

| # | Requirement | Test file | Sketch |
|---|---|---|---|
| 1 | HIGH blocks convergence | `convergenceEngine.spec.ts` | Ledger with one `OPEN` `HIGH` → `isCleanRound` false regardless of `cleanStreak` → never `CONVERGED` while it's open. |
| 2 | MEDIUM blocks convergence | `convergenceEngine.spec.ts` | Same, with `OPEN` `MEDIUM`. |
| 3 | LOW does not block | `convergenceEngine.spec.ts` | Ledger with only `OPEN` `LOW` entries, `cleanStreak >= 2` → `CONVERGED`. |
| 4 | One clean round is insufficient | `convergenceEngine.spec.ts` | Round 1 clean (`cleanStreak` becomes `1`) → decision `CONTINUE`, not `CONVERGED`. |
| 5 | Two consecutive clean rounds converge | `convergenceEngine.spec.ts` + `runConvergenceReviewLoop.spec.ts` | Round 1 and round 2 both clean → `CONVERGED` after round 2's review, with no `G2` sent (assert call log has no second `chatgpt.send`). |
| 6 | New MEDIUM resets stability | `convergenceEngine.spec.ts` | `cleanStreak` at `1`, round 2 introduces a new `MEDIUM` → round 2 is not clean → `cleanStreak` back to `0`. |
| 7 | New HIGH resets stability | `convergenceEngine.spec.ts` | Same, with `HIGH`. |
| 8 | Resolved objection remains resolved | `objectionLedger.spec.ts` | `RESOLVED` entry, next round doesn't mention it → status stays `RESOLVED`, contributes `0` to open counts, does not make the round non-clean. |
| 9 | Resolved objection reappears and reopens | `objectionLedger.spec.ts` + `convergenceEngine.spec.ts` | Explicit `reopenedObjections` id and a fingerprint-derived case both flip status to `OPEN`, apply the severity floor (§6.6), and make the round non-clean (`cleanStreak` resets). |
| 10 | Paraphrased same objection is not counted as new | `objectionLedger.spec.ts` | A `newObjections` entry that clears the conservative merge bar (§6.5) against an existing `OPEN` entry merges into that id (`PARAPHRASED`), no new `OBJ-<n>` id created, round can still be clean if nothing else is open. |
| 11 | Malformed Claude review fails safely | `structuredReviewParser.spec.ts` | One case per §7.1/§7.2 rule (missing/duplicated delimiters, invalid JSON syntax, missing/unknown top-level field, bad `reviewStatus` value, unknown id in each bucket, contradictory buckets, duplicate id within a bucket, round-1 non-empty id arrays, malformed `newObjections` entry) — each returns `{ invalid: true, reason }`, never a `StructuredClaudeReview`, and `cleanStreak` is left unchanged (assert against the pre-round value). |
| 12 | maxRounds stops correctly | `runConvergenceReviewLoop.spec.ts` | `maxRounds = 3`, ledger never converges → run stops exactly after `C3`, no `G3` and no `C4` sent. |
| 13 | maxRounds result is NOT converged | `runConvergenceReviewLoop.spec.ts` | Same run: `stopReason === "MAX_ROUNDS_REACHED"`, never `"CONVERGED"`. |
| 14 | Ledger survives multiple rounds | `runConvergenceReviewLoop.spec.ts` | A 4-round run's final `ledger` reflects entries first raised in round 1 with correct `lastSeenRound` values updated through round 4. |
| 15 | Repeated LOW issues do not block | `convergenceEngine.spec.ts` | LOW objections raised, resolved, and re-raised every round for 3 rounds while HIGH/MEDIUM stay clear → converges on schedule (round 2), unaffected by LOW churn. |
| 16 | ConvergenceEngine has no browser/DOM dependency | `tests/unit/convergenceEngineIsolation.spec.ts` | Assert (via source-text scan or import-graph check) that no file under `src/orchestration/convergence/` imports `playwright` or references `Page`. |

### 15.2 New: conservative-matching tests (review requirement 2)

All in `objectionLedger.spec.ts`, using the default thresholds (`merge 0.85`, `margin
0.15`, `minSharedTokens 3`, `candidate 0.60`):

| # | Scenario | Expected |
|---|---|---|
| 17 | True paraphrase, high overlap (score ≥ 0.85, unique, ≥ 3 shared tokens) | Auto-merges into the existing `OPEN` entry as `PARAPHRASED`; no new id. |
| 18 | Two similar but substantively different objections (score in the 0.65–0.80 band) | Stays a distinct new entry; a `possible duplicate` note is attached to its `RAISED` event for audit only. |
| 19 | Ambiguous match to two ledger entries (top two candidates within the `0.15` margin of each other, both otherwise above the merge floor) | Stays a distinct new entry — "never choose the closest merely because one exists." |
| 20 | Weak lexical overlap (score below the `0.60` candidate floor) | Stays a distinct new entry, no duplicate note at all. |
| 21 | False-merge-prevention resets `cleanStreak` correctly | Construct the exact scenario a naive `0.6`-threshold policy would have wrongly merged (moderate overlap, distinct issue); confirm the conservative policy keeps it as a new `OPEN` `HIGH`/`MEDIUM` entry with `firstSeenRound = r`, so the round is correctly scored non-clean and `cleanStreak` resets to `0`. |

### 15.3 New: severity rules tests (review requirement 3)

All in `objectionLedger.spec.ts`:

| # | Scenario | Expected |
|---|---|---|
| 22 | Downgrade of an `OPEN` `MEDIUM` via a `stillOpenObjections` `severityOverride: "LOW"` | `severity` stays `MEDIUM`; a `SEVERITY_DOWNGRADE_REJECTED` event is logged; the objection still blocks. |
| 23 | Escalation of an `OPEN` `LOW` via `severityOverride: "HIGH"` (or via a merged `newObjections` entry reporting higher severity) | `severity` becomes `HIGH`; `highestSeveritySeen` updates; a `SEVERITY_CHANGED` event is logged; the objection now blocks. |
| 24 | Reopen floor with no override | A `RESOLVED` `MEDIUM` entry reopens (explicit or fingerprint-derived) with no `severityOverride` → reopened `severity = MEDIUM` (the floor), matching `highestSeveritySeen`. |
| 25 | Reopen floor overrides an attempted downgrade | Same entry reopens with `severityOverride: "LOW"` → reopened `severity` is still floored to `MEDIUM`, not `LOW`; a `SEVERITY_CHANGED` event records the floor being applied. |
| 26 | Reopen escalation is honored | Same entry reopens with `severityOverride: "HIGH"` → reopened `severity = HIGH` (escalation above the floor is always allowed). |

### 15.4 New: ledger-id validation tests (review requirement 4)

All in `structuredReviewParser.spec.ts`, one case per row of §7.2's table: unknown id in
each of `resolvedObjectionIds`/`stillOpenObjections`/`reopenedObjections`; the same id in
two contradictory buckets; a duplicate id within one bucket; non-empty id arrays in round
1; each mapped to its own `INVALID_REVIEW` with the specific reason string from §7.2.
Plus one test confirming an `OPEN` id simply absent from every bucket is **not** flagged
invalid (it becomes `IMPLICITLY_CARRIED_OPEN` at ingest, per §6.3 — parser-level, this
case must parse successfully).

### 15.5 New: JSON grammar tests (review requirement 5)

All in `structuredReviewParser.spec.ts`:

| # | Scenario | Expected |
|---|---|---|
| 27 | Multiline `reason` via `\n` escapes | Parses successfully; the resulting string contains the embedded newline. |
| 28 | Delimiter-like text embedded in a string field (e.g. `reason` contains the literal text `"END_STRUCTURED_REVIEW"` as a quoted JSON string value) | Parses successfully — it is inert data inside a JSON string, never mistaken for the real sentinel line. |
| 29 | Missing `BEGIN_STRUCTURED_REVIEW` or `END_STRUCTURED_REVIEW` | `INVALID_REVIEW`. |
| 30 | Duplicated `BEGIN_STRUCTURED_REVIEW` sentinel | `INVALID_REVIEW`. |
| 31 | Unknown top-level JSON field | `INVALID_REVIEW`. |
| 32 | Conversational text before `BEGIN_STRUCTURED_REVIEW` and after `END_STRUCTURED_REVIEW` | Ignored; only the block content is parsed; otherwise-valid JSON inside still parses successfully. |

### 15.6 New: state-machine sequence tests (review requirement 7)

All in `runConvergenceReviewLoop.spec.ts`, using fake in-memory adapters (Milestone 4A's
pattern):

| # | Scenario | Expected |
|---|---|---|
| 33 | `C1` clean → `cleanStreak=1` → `G1` still occurs → `C2` clean → `CONVERGED` → `G2` does NOT occur | Call log shows exactly two `chatgpt.send` (initial + `G1`) and two `claude.send` (`C1`, `C2`); `stopReason === "CONVERGED"`; `finalAnswer === G1`. |
| 34 | `C1` clean → `G1` → `C2` introduces new MEDIUM → streak resets → continue | After `C2`, `cleanStreak === 0`; decision `CONTINUE`; `G2` is produced addressing the new MEDIUM. |
| 35 | `C1` resolves the final MEDIUM and is otherwise clean → `cleanStreak=1` → `G1` produced → `C2` clean → converge | Confirms a round that clears the last blocker in the same round it ingests still counts as clean (§8.1); `finalAnswer === G1`. |
| 36 | At `maxRounds`: final Claude review happens, convergence evaluated, `MAX_ROUNDS_REACHED` if not converged, no unreviewed extra ChatGPT revision | With `maxRounds = 3` and no convergence, total `chatgpt.send` calls `=== 3` (`G0, G1, G2`), total `claude.send` calls `=== 3` (`C1, C2, C3`), `stopReason === "MAX_ROUNDS_REACHED"`, `finalAnswer === G2` (the answer `C3` reviewed). |

`runConvergenceReviewLoop.spec.ts` additionally covers the loop-integration shape carried
over from Milestone 4A's own suite in spirit (call order, exactly-one-send-per-turn on
failure, partial result availability on `INVALID_REVIEW`) using the same fake-adapter
pattern as `tests/unit/runFixedReviewLoop.spec.ts`.

---

## 16. Open design questions

1. **Lexical-only fingerprinting, even with the conservative policy, will still miss some
   true paraphrases with low token overlap** (§6.5) — an accepted tradeoff (false split
   over false merge), not a defect. Considered and deferred: (a) a second, cheap LLM call
   dedicated to objection-matching — rejected for now as it reintroduces non-determinism
   and cost into what should be a pure decision layer; (b) stemming/synonym expansion on
   top of the token-set approach — a reasonable future improvement that stays
   deterministic, not built now to avoid scope creep beyond what the milestone asks for.
2. **No malformed-review repair mechanism is built** (§9). If a future milestone wants one,
   it must be a distinct new logical turn, not a resend of the same turn — the shape is
   sketched but intentionally not implemented here.
3. **The engine trusts Claude's resolved/still-open self-report; it cannot independently
   verify ChatGPT's revision text actually fixed a HIGH/MEDIUM objection.** This is by
   design — Claude's job as reviewer is exactly that verification — but it means a
   consistently over-generous Claude could resolve objections that weren't really fixed.
   Mitigated only by prompt wording (§11) instructing Claude to verify before marking
   resolved and the severity-floor/downgrade-reject rules (§6.6) that at least stop a
   *labeling* trick from working; no code-level cross-check is proposed, since that would
   require the engine to itself judge answer quality, which is explicitly Claude's role
   (§4).
4. **`maxRounds` remains a call parameter, not a config field**, carried over unresolved
   from `MILESTONE4A_DESIGN.md` §14's open question 2 — still deferred to whenever
   persistence (`runs/<run-id>/state.json`) is actually built.
5. **JSON's strictness is a real, accepted brittleness tradeoff.** A single stray syntax
   error from Claude (an unescaped quote inside `reason`, a trailing comma) invalidates the
   *entire* review and stops the run, where a more permissive line-based grammar might have
   salvaged the rest of the payload. This is intentional, not overlooked: it is exactly the
   "stop safely, never guess" behavior §9 requires, and the alternative (a lenient parser
   that tries to recover from partial corruption) reintroduces the ambiguity this whole
   review round was about removing. If real runs show this firing too often in practice,
   the mitigation is better prompt engineering and/or few-shot examples in §11's prompts,
   not a more forgiving parser.
6. **Severity-override syntax remains optional and permissive on escalation** — nothing
   enforces that Claude uses it consistently round to round, and an escalation without an
   override simply leaves severity unchanged (no override = no change). This is unchanged
   from the first draft and still worth flagging as a place a future reviewer might want
   stricter consistency checking.

---

## Summary for the user

- **Revised round state machine (§5, §8.3, §8.4):** one decision point per round,
  evaluated right after each Claude review `Cr`, in fixed priority order — `CONVERGED`
  first (skip `Gr`), then `MAX_ROUNDS_REACHED` (skip `Gr`), else produce `Gr` and continue.
  This removes the prior draft's two-checkpoint ambiguity and guarantees the
  `MAX_ROUNDS_REACHED` answer was always reviewed by the final Claude pass.
- **Exact clean-round definition (§8.1):** zero `OPEN` HIGH, zero `OPEN` MEDIUM, zero new
  HIGH/MEDIUM this round, zero reopened HIGH/MEDIUM this round — proven to reduce to just
  "zero open HIGH and zero open MEDIUM after ingest," since a same-round new/reopened
  blocker can never also be resolved in that same round.
- **Objection matching safety policy (§6.5):** merge only on a high absolute score
  (`≥0.85`), a clear margin over the next-best candidate (`≥0.15`), and a minimum shared-
  token count (`≥3`) — all three at once. Anything weaker or ambiguous stays a distinct new
  objection. False-split is the accepted failure mode; false-merge is the one this policy
  is built to avoid, because it can silently erase tracking of a real, unresolved issue and
  produce false convergence.
- **Severity downgrade/reopen policy (§6.6):** escalation is always honored; a downgrade
  attempt on an `OPEN` HIGH/MEDIUM objection is logged and ignored (only explicit
  `RESOLVED` clears it); a reopened objection is floored at its historical peak severity
  regardless of how mild the reappearance is described.
- **Structured-review grammar (§7):** a sentinel-wrapped JSON payload
  (`BEGIN_STRUCTURED_REVIEW` / `END_STRUCTURED_REVIEW`) with strict schema validation,
  replacing the first draft's line-based format — this makes delimiter-collision and
  multiline-text handling exact rather than heuristic.
- **Invalid-ID behavior (§7.2):** unknown ids in any bucket, ids referenced in
  contradictory buckets, duplicate ids within a bucket, and any bucket non-empty in round 1
  are all `INVALID_REVIEW`; an `OPEN` id simply absent from every bucket is never invalid —
  it stays `IMPLICITLY_CARRIED_OPEN`.
- **maxRounds semantics (§8.4):** bounds Claude review rounds, not ChatGPT turns; hitting
  the bound stops the run immediately after the final Claude review with no trailing
  unreviewed ChatGPT revision.
- **Newly added test cases (§15.2–§15.6):** 5 conservative-matching tests, 5 severity-rule
  tests, ledger-id validation tests covering every §7.2 row, 6 JSON-grammar tests, and 4
  explicit state-machine sequence tests matching the review's exact scenarios — all design-
  level, none implemented yet.
- **Remaining open questions (§16):** lexical-only matching can still miss some true
  paraphrases (accepted tradeoff); no repair-turn implementation; no independent
  verification that ChatGPT actually fixed what Claude marks resolved; `maxRounds` still
  not config-backed; JSON's all-or-nothing strictness is an accepted brittleness tradeoff;
  severity-override usage isn't enforced for consistency.
