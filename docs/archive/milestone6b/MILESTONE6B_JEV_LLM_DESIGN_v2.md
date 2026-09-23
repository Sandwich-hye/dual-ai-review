# MILESTONE6B_JEV_LLM_DESIGN_v2.md — Optional LLM-Based JEV Supervisor Adapter (Audit-Augmentation Model)

Design-only document for Phase 2A Milestone 6B. **No production TypeScript is changed or
written by this document.** This revision **replaces** `MILESTONE6B_JEV_LLM_DESIGN.md`
after an architect review found three BLOCKING and five MEDIUM issues in it. Milestone 6A
(`MILESTONE6_JEV_DESIGN_v3.md`, commit `fd86859`) remains completed, frozen, and — as of
this revision — touched by **zero** exceptions (v1 had proposed one narrow, additive
`loadConfig.ts` edit; §14.2 below replaces it with a fully standalone file).

---

## Revision history

**v2 (this revision) — resolves every BLOCKING and MEDIUM finding from the v1 review, not a
patch:**

1. **Chose and documented one execution model, explicitly (§1, §3): Option A — the LLM
   Supervisor is advisory-only audit augmentation.** It never participates in real-time
   human supervision, never blocks a round, and its output is never guaranteed to reach a
   human before any decision. v1 claimed both a real-time "composite merge" and a
   non-blocking default simultaneously, which was self-contradictory (BLOCKING #1 in the
   review). This revision states the chosen model once, up front, and every downstream
   section is written to be consistent with it — resolved, not merely documented as a
   trade-off.
2. **Renamed the composition primitive** from `createCompositeSupervisor`/"Composite
   Supervisor" to `createAugmentedSupervisor`/"Augmented Supervisor," specifically because
   the old name and its "merge" framing were part of what made the v1 contradiction possible
   to write without immediately looking wrong. The new contract states, as its first line,
   that `assess()`'s return value is always, unconditionally, byte-identical to what the
   deterministic Supervisor alone would return — not approximately, not "unless blocking
   mode is on."
3. **Added explicit browser concurrency control (§6, new section).** v1 had no
   serialization mechanism for the shared LLM-Supervisor browser tab across rounds and its
   `Promise.race` timeout didn't stop the underlying operation — a real, demonstrated race
   condition (BLOCKING #2). §6 adds a run-scoped single session, a busy-lock held until the
   real operation settles (not until a timeout race loses), a skip-not-queue policy, and
   audit records for skipped/timed-out/late-resolved calls.
4. **Added mandatory, config-enforced context-isolation preconditions (§7, rewritten).**
   v1 asserted "fresh conversation" isolation was sufficient without addressing
   account-level memory/history-reference features that could defeat it (BLOCKING #3). §7
   now requires an explicit `isolationPreconditionsAcknowledged: true` config attestation
   before LLM mode can run at all — reusing this project's own existing precedent for an
   approval gate (`DECISIONS.md` §10's Phase 2 compliance gate) — plus an optional automated
   nonce-based leakage smoke test (§15.3).
5. **Resolved all five MEDIUM findings:** M1 — `createLlmSupervisor` is now internal-only,
   enforced by an isolation test (§4.1); M2 — the `loadConfig.ts` edit is replaced by a
   fully standalone config loader that touches no frozen file (§14.2); M3 — dissolved as a
   direct consequence of Option A: there is no "merged escalation reason" to compose,
   because nothing from the LLM leg is ever merged into `assess()`'s return value (§8); M4 —
   explicit login/session-expiry handling, checked once per run with a first-class
   `llmSessionStatus` audit field (§9.5); M5 — every resolved LLM audit record now carries a
   denormalized snapshot of the raw numeric signal its narrative cites, so a later auditor
   never has to trust the prose alone (§12).

**Unchanged in substance from v1:** §2 (6A recap), §5 (input contract — still the same
closed `SupervisorInput`), §8/§7-in-v1 (prompt design and grounding-checked parsing), §10
(API/authentication strategy — the no-paid-API rule is unaffected by any of this), and the
overall non-goals (§1). These are cited by section number below rather than restated in
full, per this project's own established revision convention.

---

## 1. Goal / Non-goals

**Goal:** design an optional, off-by-default `Supervisor` **audit augmentation** — an LLM
web-session-backed process that observes the same structured `SupervisorInput` the
deterministic Supervisor sees, and records its own advisory judgment to the run's audit
trail, without ever participating in, delaying, or being visible during the live human
decision loop.

**Chosen execution model — stated once, here, and never contradicted downstream:**

> **Option A: advisory-only audit augmentation.** `Supervisor.assess()` — the one method the
> frozen `supervisedHumanGate.ts` ever calls — always returns exactly what the deterministic
> Supervisor alone computes. The LLM leg, when configured and triggered, runs as a fully
> decoupled, fire-and-forget background operation whose result is recorded to a separate,
> explicitly-asynchronous audit channel (§11, §12). It is never awaited by, merged into, or
> capable of altering what any human sees before making a decision. Anyone who never inspects
> `SupervisedReviewResult.llmSupervisorAssessments` after (or during, via logs — §11.2) a run
> will simply never see LLM output at all, and that is correct, intended behavior, not a gap.

Option B (LLM participates in real-time supervision, blocking with a bounded timeout before
each triggered gate opens) was considered and rejected: it would reintroduce exactly the
latency-before-every-gate-open problem §0.1 documents as a property of the frozen 6A code,
and would keep the shared-browser-tab concurrency risk live under time pressure during the
one scenario (sustained deterministic flagging) where reliability matters most. Option A
sidesteps both by construction.

**Preserved invariants — restated as a checklist, matching the task's explicit preserve
list:**

| Invariant | How this design guarantees it |
|---|---|
| Milestone 6A frozen | Zero files in 6A's frozen list are edited (§14.1) — a strict improvement over v1, which had one exception. |
| Deterministic Supervisor remains the authoritative safety layer | `assess()`'s return value is *always* the deterministic result, unconditionally, by construction (§3.3) — not a priority rule to be checked, a structural fact. |
| LLM cannot influence the Decision Agent | Unchanged from v1: the composition happens entirely inside the `Supervisor` slot; nothing touches `evaluateDecision`/`DecisionRecommendation`. |
| LLM cannot directly modify the Human Gate outcome | Stronger than v1: since the LLM leg's output never reaches `assess()`'s return value, it cannot even indirectly shape what `supervisedHumanGate.ts` renders to the human, let alone the gate's outcome. |
| No production code | This document remains design-only. |

**Non-goals:** unchanged from v1 §1 — no new browser-automation mechanism, no API keys, no
change to the Generator, Reviewer, Claim Ledger, Decision Agent, or Human Gate.

---

## 2. Current state recap (6A, frozen)

Unchanged from v1 §2 and `MILESTONE6_JEV_DESIGN_v3.md` — the `Supervisor` interface,
`createDeterministicSupervisor()`, and `supervisedHumanGate.ts`'s call order (assess, then
render, then delegate to the real gate — §0.1's correction, still load-bearing here) are
exactly as documented there and are not repeated.

---

## 3. Architecture placement

### 3.1 Diagram — LLM leg drawn explicitly as a side channel, not a stage in the live path

```
Decision Agent                       (frozen, 6A/5 — unchanged)
      |
      v
Augmented Supervisor  (NEW, 6B)  ──── assess() returns EXACTLY the Deterministic
      |                               Supervisor's own result. Full stop. No exception,
      |                               no mode, no configuration changes this.
      |
      ·  (side effect, decoupled from the return above — §6, §9)
      ·  dispatch, maybe ──────────► LLM Supervisor Adapter (optional, fire-and-forget)
      ·                                     |
      ·                                     v
      ·                              writes ONLY to an internal, out-of-band log
      ·                              (§11, §12) — never read by, or able to affect,
      ·                              anything above this line
      v
Supervised Human Gate Wrapper        (frozen, 6A — unmodified; receives a plain
      |                                `Supervisor`; has no knowledge an LLM leg exists)
      v
Original Human Gate                  (frozen, 5 — unmodified)
```

The dotted-line side channel is deliberately drawn disconnected from the solid live path —
this is the diagram-level fix for the exact ambiguity that let v1's text claim both "the
composite merges LLM flags" and "the default doesn't wait for the LLM leg" without either
statement's author (this project, in its previous turn) noticing they couldn't both be true.

### 3.2 What "Augmented" means, precisely

`Supervisor` (§2, frozen) is unchanged. `AugmentedSupervisor` is a new type — a `Supervisor`
plus one additional, audit-only accessor:

```ts
// design sketch — src/orchestration/supervisor/augmentedSupervisor.ts (new;
// replaces v1's compositeSupervisor.ts — renamed, not just moved, per the revision history)
export interface AugmentedSupervisor extends Supervisor {
  getAccumulatedLlmAssessments(): LlmSupervisorAssessmentRecord[];   // §12 — read by the
                                                                       // entry point AFTER
                                                                       // the run, exactly
                                                                       // like 6A's own
                                                                       // getAccumulatedAssessments()
  getLlmSessionStatus(): LlmSessionStatus;                            // §9.5 — was the LLM
                                                                       // session ever usable
                                                                       // this run at all?
}
```

`supervisedHumanGate.ts` receives an `AugmentedSupervisor` through its existing `Supervisor`
parameter (structural typing — no change to the frozen decorator's own type is needed, since
`AugmentedSupervisor` satisfies `Supervisor` by extension) and never calls, or knows about,
either new method. Only the entry point (§11.1) calls them, after the run.

### 3.3 The one-line contract that resolves BLOCKING #1

```ts
// design sketch — src/orchestration/supervisor/augmentedSupervisor.ts
export function createAugmentedSupervisor(
  deterministic: Supervisor,               // ALWAYS createDeterministicSupervisor() in
                                            // production
  options: AugmentedSupervisorOptions,     // §6, §7 — llm leg is optional and, even when
                                            // configured, never touches the return below
): AugmentedSupervisor {
  // ... internal state for §6's lock/records ...
  return {
    async assess(input: SupervisorInput): Promise<SupervisorAssessment | SupervisorUnavailable> {
      const result = await deterministic.assess(input);
      // The return value is now fixed. Everything below this line is a side effect that
      // cannot, by construction, change `result` or delay this function's resolution any
      // further — `maybeDispatchLlmLeg` never awaits anything it starts.
      maybeDispatchLlmLeg(result, input);
      return result;
    },
    getAccumulatedLlmAssessments: () => /* §12 */,
    getLlmSessionStatus: () => /* §9.5 */,
  };
}
```

**This is the structural fix, not a convention to remember:** there is no code path,
configuration value, or mode flag anywhere in this design under which `assess()`'s `await`
depends on anything the LLM leg does. A reviewer checking this design for BLOCKING #1's
resolution needs to check exactly one thing — that `maybeDispatchLlmLeg` is called after
`result` is already computed and is never itself `await`-ed — rather than reasoning through
a matrix of blocking/non-blocking/triggered/untriggered states as v1 required.

---

## 4. LLM Supervisor adapter interface

Unchanged in signature from v1 §4/6A's own §7 sketch — reusing the existing
`ConversationalSiteAdapter` contract, no new browser-automation code:

```ts
// design sketch — src/orchestration/supervisor/llmSupervisorAdapter.ts
export function createLlmSupervisor(
  adapter: ConversationalSiteAdapter,
  page: Page,                              // the run-scoped, dedicated tab — §6.1
): Supervisor {
  // unchanged from v1 §4 — send/wait/extract via the existing adapter contract, parse via
  // §8's grounding-checked grammar, degrade to SupervisorUnavailable on any failure.
}
```

### 4.1 Resolving MEDIUM M1 — this constructor is internal, not a public replacement path

**v1's gap:** nothing stopped a future entry point from constructing
`createLlmSupervisor(...)` directly and wiring it in place of the deterministic Supervisor —
the literal "LLM replaces deterministic Supervisor" scenario the task explicitly rules out,
guarded in v1 only by documentation.

**Fix:** `createLlmSupervisor` is documented and enforced as **internal to
`src/orchestration/supervisor/`, callable only from `augmentedSupervisor.ts`.** Two
enforcement layers, matching this project's existing isolation-test convention (§15.1):

1. `llmSupervisorAdapter.ts` is not re-exported from any barrel/index the entry point
   imports from — the entry point's own import surface for this module is
   `augmentedSupervisor.ts` only.
2. `tests/unit/supervisorIsolation.spec.ts` (extended, §15.1) asserts by source scan that no
   file outside `src/orchestration/supervisor/augmentedSupervisor.ts` imports
   `llmSupervisorAdapter.ts` — including the entry point itself. This makes "replace the
   deterministic Supervisor with the LLM one" a CI-caught violation, not a code-review-time
   hope.

---

## 5. Input contract

Unchanged from v1 §5. `SupervisorInput` remains the same closed contract of numbers,
booleans, and small enums (`src/orchestration/supervisor/types.ts`, frozen). Both the
deterministic leg and — when triggered — the LLM leg are called with the identical object;
there is no second, wider contract introduced anywhere in this revision.

---

## 6. Browser concurrency control (new section — resolves BLOCKING #2)

### 6.1 One session per run

The LLM Supervisor's `Page` (tab) and its single conversation thread are opened **exactly
once, at run start**, and reused for every triggered `assess()` call across the whole run —
never re-opened per round, never per call. This was already v1's intent (§6.2 there) but is
now stated as a hard requirement this section's locking mechanism depends on, not an
incidental detail.

### 6.2 Serialization: a busy-lock held until real settlement, not until a timeout race loses

```ts
// design sketch — inside createAugmentedSupervisor, §3.3
let busy = false;
let busyRound: number | undefined;

function maybeDispatchLlmLeg(result: SupervisorAssessment | SupervisorUnavailable, input: SupervisorInput): void {
  if (!options.llm) return;
  let round: number;
  try {
    if (!shouldTrigger(options.llm.trigger, result)) return;   // §11.2's trigger policy
    round = input.rounds.at(-1)!.roundNumber;
  } catch (error) {
    // Even the trigger-decision itself is guarded — a bug here must never propagate into
    // assess()'s caller, which has already returned by the time this function runs, but a
    // synchronous throw here would still be an unhandled path if this guard were absent.
    recordSkip(round, `trigger evaluation failed: ${describeError(error)}`);
    return;
  }

  if (busy) {
    // SKIP, not queue. Rationale (§6.4): queueing under sustained flagging (the exact
    // scenario `on-deterministic-flag` is designed to catch) would make LLM commentary lag
    // further and further behind real time, indefinitely — a skip-and-record policy stays
    // bounded and honest about what didn't happen, rather than accumulating a backlog.
    recordSkip(round, `llm leg busy with round ${busyRound}`);
    return;
  }

  busy = true;
  busyRound = round;
  const record: LlmSupervisorAssessmentRecord = { round, status: "pending", dispatchedAt: nowIso() };
  records.push(record);

  const real = options.llm.supervisor.assess(input);          // the actual browser operation —
                                                                // NEVER cancelled (Playwright has
                                                                // no true cancellation of an
                                                                // in-flight page action)
  const timedOut = raceTimeout(real, options.llm.timeoutMs);

  timedOut.then((outcome) => {
    if (outcome.kind === "timeout") {
      record.status = "timed_out";
      record.resolvedAt = nowIso();
      record.reason = `exceeded ${options.llm!.timeoutMs}ms`;
      // NOTE: the lock is NOT released here. `busy` stays true until `real` itself settles,
      // below — this is the entire fix for the v1 race condition.
    }
    // the "resolved" case is handled by the `real.then(...)` chain below, which also
    // covers the (more common) case where `real` settles before the timeout at all.
  });

  real
    .then((assessment) => {
      if (record.status === "timed_out") {
        // A logical timeout already recorded this round as timed_out; this is a late
        // arrival, kept for completeness, never re-triggering any live behavior (§12).
        record.lateResolution = { resolvedAt: nowIso(), assessment: toRecordedAssessment(assessment) };
      } else {
        applyResolved(record, assessment, input);              // §12 — includes grounded-signal
                                                                  // denormalization (M5 fix)
      }
    })
    .catch((error) => {
      if (record.status === "pending") {
        record.status = "unavailable";
        record.resolvedAt = nowIso();
        record.reason = describeError(error);
      }
    })
    .finally(() => {
      busy = false;                                            // released ONLY on real
      busyRound = undefined;                                    // settlement — never on the
                                                                  // timeout race alone
    });
}
```

### 6.3 Why the timeout "does not leave uncontrolled background browser operations" — precisely

The underlying Playwright operation is **not cancelled** by the timeout — this is a real
constraint of the platform, not something this design can wish away. What changes from v1 is
that it is no longer *uncontrolled*: because `busy` stays `true` until `real` itself settles
(§6.2), no other trigger can touch the shared page while that operation is still running,
regardless of whether a logical timeout has already been recorded. A slow round's real
operation finishing late no longer risks corrupting a subsequently-dispatched round's
`sendPrompt`/`waitForGenerationComplete` calls, because there is no "subsequently dispatched"
call — later triggers are skipped-and-recorded (§6.2) for exactly as long as the page is
genuinely still busy, converting an uncontrolled race into a controlled, serialized wait.

### 6.4 Audit record for skipped and failed calls

`LlmSupervisorAssessmentRecord.status` is extended with `"skipped"` (§12's full type). Every
skip, timeout, and late resolution is recorded with a `reason` — an auditor reading
`llmSupervisorAssessments` after a run sees not just what the LLM leg concluded, but a
complete account of every round it was eligible to run, whether it actually ran, and why not
when it didn't.

---

## 7. Context isolation strategy (rewritten — resolves BLOCKING #3)

v1 §6 established dedicated-tab, fresh-conversation isolation and correctly identified this
as necessary. The review found it insufficient as stated, because it didn't address
account-level features (memory / cross-conversation reference) that can defeat conversation-
level isolation regardless of how carefully the tab/thread separation is implemented. This
section makes every precondition explicit and, where the project's no-API constraint allows,
enforced rather than merely documented.

### 7.1 Mandatory preconditions

1. **Dedicated automation browser profile.** Inherited, not new — this project already
   requires a dedicated profile, never the user's daily browser profile
   (`DECISIONS.md` §5a). Restated here because it remains a precondition for isolation, not
   because 6B changes it.
2. **A separate, run-scoped conversation** for the LLM Supervisor's tab (§6.1) — never the
   Generator's or Reviewer's own tab or thread.
3. **Account-level "memory" (or equivalent persistent-facts-across-chats feature) disabled**
   on whichever site's account is used for the LLM Supervisor role.
4. **"Reference chat history" (or equivalent cross-conversation-context feature) disabled**
   on the same account. Named separately from #3 because these are typically distinct
   product settings, and both must be off for tab-level isolation to actually mean
   context-level isolation.
5. **One-time manual verification before first enabling LLM mode.** Because this project has
   no API access to any vendor account (§10) and therefore cannot programmatically query
   these settings, verification is necessarily a manual step: the operator checks the
   product's own settings UI, confirms #3 and #4 are off, and only then opts in.

### 7.2 The verification is enforced by configuration, not left to memory

```ts
// design sketch — SupervisorConfig shape, §14.2
export interface SupervisorConfig {
  mode: "deterministic" | "deterministic+llm-audit";   // renamed from v1's
                                                          // "deterministic+llm" to name the
                                                          // chosen model (§1) precisely
  llm?: {
    site: "chatgpt" | "claude";
    trigger: LlmTriggerPolicy;
    timeoutMs: number;
    isolationPreconditionsAcknowledged: true;    // MUST be the literal boolean `true`.
                                                    // loadSupervisorConfig (§14.2) fails
                                                    // loudly if `llm` is present and this
                                                    // field is missing or `false` — an
                                                    // explicit, auditable attestation gate,
                                                    // not a technical guarantee that #3/#4
                                                    // are actually off (this project cannot
                                                    // verify that programmatically), but a
                                                    // deliberate speed bump forcing the
                                                    // operator to have done §7.1 step 5
                                                    // before the feature can run at all.
                                                    // Mirrors this project's own existing
                                                    // precedent for exactly this kind of
                                                    // gate (`DECISIONS.md` §10's Phase 2
                                                    // compliance approval gate).
  };
}
```

An operator who sets `mode: "deterministic+llm-audit"` without setting
`isolationPreconditionsAcknowledged: true` gets a loud, immediate config-load failure, in
the same style `loadConfig.ts` already uses for every other malformed field — never a silent
fallback to deterministic-only, which would hide a misconfiguration rather than surface it.

### 7.3 Recommended automated check (not a substitute for §7.1, a supplement)

§15.3 adds an optional real-browser smoke test that mechanically probes for cross-
conversation leakage: seed the Generator's or Reviewer's own conversation with a unique,
randomly generated marker string, then — via a diagnostic prompt separate from the real
`assess()` flow — ask the LLM Supervisor's fresh conversation whether it has seen that
marker, and assert the answer indicates no. This cannot prove isolation is perfect (a
negative result doesn't rule out subtler leakage), but it is a real, mechanical regression
check reusing existing browser-automation capability, worth running whenever this feature's
implementation changes.

---

## 8. Prompt design and parsing

Unchanged from v1 §7 (renumbered) — the fixed instruction template, closed-data-only
interpolation, sentinel-delimited JSON grammar, strict no-partial-result parsing, and the
grounding check rejecting any flag whose `evidenceRounds` cites a round absent from the
`SupervisorInput` it was given. Nothing about the execution-model change in §1/§3 affects
prompt content or parsing — the prompt is still built from, and only from, the same
`SupervisorInput` any triggered call receives.

---

## 9. Failure handling

### 9.1 Boundary — deterministic assessment

Unchanged from 6A — outside this milestone's scope, and, per §3.3, structurally
unreachable by anything this milestone adds (the LLM leg is dispatched only *after*
`deterministic.assess()` has already resolved).

### 9.2 Boundary — trigger evaluation

New, small, but explicit given the review's emphasis on race conditions: `shouldTrigger(...)`
is called inside its own `try/catch` (§6.2's sketch) so a bug in the trigger-policy logic
itself degrades to a recorded skip rather than an unhandled exception in a fire-and-forget
context (which would otherwise be a silent, untraceable failure mode).

### 9.3 Boundary — LLM adapter invocation

Unchanged in mechanism from v1 §9.1 — typed adapter errors and non-`"complete"`
`GenerationOutcome`s degrade uniformly, content-independent of *why*. Now feeds into
`applyResolved`'s `"unavailable"` path via the `.catch()` in §6.2's sketch.

### 9.4 Boundary — response parsing and grounding

Unchanged from §8/v1 §7.1–7.2 — malformed grammar or an ungrounded `evidenceRounds`
reference both degrade to an explicit invalid result, never a partially-trusted object.

### 9.5 Login/session expiry (resolves MEDIUM M4)

**v1's gap:** no explicit handling — reliance on incidentally catching whatever error a
logged-out composer happened to produce.

**Fix:** once, at run start, after opening the LLM Supervisor's dedicated tab (§6.1), the
entry point calls `adapter.checkReady(page)`. If the result is not `"ready"`
(`"login_required"`, `"navigation_failed"`, or `"unknown_state"`), the LLM leg is disabled
for the **entire run** — no dispatch is ever attempted, regardless of trigger policy — and
`AugmentedSupervisor.getLlmSessionStatus()` returns
`{ status: "not_ready", detail: "<the SiteLoadStatus and any detail>" }`. This is surfaced as
a first-class, top-level field on `SupervisedReviewResult` (§12), not left to be inferred
from an empty `llmSupervisorAssessments` array, which would otherwise be ambiguous between
"never triggered" and "could never have run at all."

A session that degrades **mid-run** (rather than being unready at start) needs no separate
mechanism: every dispatch already goes through §9.3's per-call error handling, which records
the failure on that specific round's record — the same path, not a new one.

### 9.6 The resulting, testable invariant

No code this milestone adds — trigger evaluation, LLM dispatch, adapter invocation, parsing,
locking — can cause `assess()` to reject, hang, or return anything other than exactly what
`deterministic.assess(input)` alone would have returned. This is strictly simpler to state
and to test than v1's equivalent (§9.6 there), because Option A removes the entire class of
"what does the merged result look like when X fails" cases — there is no merged result.

---

## 10. API/authentication strategy

Unchanged from v1 §10. This project's standing rule against any paid or private LLM vendor
API (`DECISIONS.md` §§2–4) is unrelated to and unaffected by this revision; the LLM
Supervisor authenticates exactly as the Generator and Reviewer already do, via the user's own
session in the dedicated automation browser profile.

---

## 11. When and how LLM results are surfaced (new section — Option A's required answer)

Per the task's requirement that Option A "define when and how LLM results are surfaced":

### 11.1 Primary channel: the audit trail, read after the run

The authoritative surfacing mechanism is `SupervisedReviewResult.llmSupervisorAssessments`
(§12), assembled by the entry point from `getAccumulatedLlmAssessments()` after
`runAuditedReviewLoop()` returns — mirroring exactly how 6A's own
`supervisorAssessments` is assembled from `getAccumulatedAssessments()` today. This is a
**post-hoc, complete, and durable** record: every round the LLM leg was eligible for, and
what happened (resolved / unavailable / timed out / skipped / late-resolved), all captured
whether or not anyone was watching the terminal at the time.

### 11.2 Secondary, non-authoritative channel: an asynchronous console notice

The entry point *may* additionally print a plainly-labeled, asynchronous line to the console
whenever a pending LLM assessment resolves — e.g.
`[JEV-LLM, round 4, resolved 00:02:17 after dispatch] STAGNATION (advisory)`. This is
explicitly **decoupled from any round boundary**: it can print while the human is mid-decision
on a completely different, later round, or after the run has already finished. It is a
convenience for an operator watching the terminal live, never a mechanism anything depends on
for correctness, and never required reading — §11.3 states this plainly so a future reader
isn't misled into treating it as supervision.

### 11.3 What is explicitly not provided, stated plainly per the task's requirement

**A human who never reads `llmSupervisorAssessments` and isn't watching the console at the
exact moment a background call resolves will never see LLM output during a live run.** This
is the direct, honest consequence of Option A (§1) and is intended, not a gap to be
apologized for — the LLM leg's value is in the durable audit record (§12) and, secondarily, a
best-effort live notice, not in gating or informing any specific decision in real time.

---

## 12. Audit requirements

```ts
// design sketch — src/orchestration/supervisor/types.ts, additive extension
export const SUPERVISED_REVIEW_RESULT_SCHEMA_VERSION = 2;   // unchanged reasoning from v1 §12

export interface SupervisedReviewResult {
  schemaVersion: number;
  base: AuditedReviewResult;                                        // unchanged
  supervisorAssessments: (SupervisorAssessment | SupervisorUnavailable)[];  // unchanged —
                                                                       // ALWAYS deterministic-
                                                                       // only content, by §3.3
  llmSupervisorAssessments?: LlmSupervisorAssessmentRecord[];        // NEW, optional
  llmSessionStatus?: LlmSessionStatus;                                // NEW, optional — §9.5
}

export type LlmSessionStatus =
  | { status: "not_configured" }
  | { status: "not_ready"; detail: string }
  | { status: "ready" };

export interface LlmSupervisorAssessmentRecord {
  round: number;
  status: "pending" | "resolved" | "unavailable" | "timed_out" | "skipped";
  dispatchedAt?: string;               // absent only for "skipped" (never actually sent)
  resolvedAt?: string;
  assessment?: SupervisorAssessment;    // present only when status === "resolved"
  groundedSignals?: SupervisorRecommendationSignal[];   // NEW (resolves MEDIUM M5) —
                                          // the raw SupervisorRecommendationSignal for every
                                          // round cited in assessment.flags[*].evidenceRounds,
                                          // denormalized directly onto the record so a later
                                          // auditor can fact-check the LLM's narrative
                                          // against the real numbers without separately
                                          // cross-referencing base.rounds
  reason?: string;                      // for unavailable / timed_out / skipped
  prompt?: string;                      // verbatim; absent for "skipped"
  rawResponse?: string;
  lateResolution?: { resolvedAt: string; assessment?: SupervisorAssessment };  // §6.2 —
                                          // a real operation that finished after its round
                                          // was already recorded "timed_out"; kept for audit
                                          // completeness, never re-triggers anything live
}
```

**Assembly**, mirroring 6A's own §8.1/§12 pattern: after `runAuditedReviewLoop()` returns
(and after briefly awaiting any still-`"pending"` records, bounded by `timeoutMs`, so the
final result never ships with a record permanently stuck at `"pending"`), the entry point
reads `augmentedSupervisor.getAccumulatedLlmAssessments()` and
`.getLlmSessionStatus()` and assembles both into the result alongside 6A's own untouched
`base`/`supervisorAssessments`.

A run with `mode: "deterministic"` (the default) produces `llmSupervisorAssessments:
undefined` and `llmSessionStatus: undefined` — indistinguishable, field-for-field, from a
plain 6A-only result except for the schema version, exactly as v1 intended.

---

## 13. Security considerations

### 13.1 Prompt injection

Unchanged from v1 §13.1 — the closed `SupervisorInput` contract (§5) means there is no
attacker-controlled free text available to embed into the prompt's instruction position
today; the residual risk is contract drift in a future milestone, mitigated by the
prompt-contract isolation test (§15.1).

### 13.2 Context leakage

Rewritten to match §7's strengthened preconditions: cross-conversation leakage via a shared
tab/thread is prevented by §6.1's dedicated, run-scoped session; the account-level
memory/history-reference risk v1 missed is now a mandatory, config-gated precondition (§7),
not an assumption. Vendor-side retention of whatever is sent (an accepted, pre-existing risk
class for every existing Generator/Reviewer turn, per `DECISIONS.md` §§2–4) is unchanged and
restated: this is why LLM mode remains off by default, requiring the explicit `mode` and
`isolationPreconditionsAcknowledged` opt-in.

### 13.3 Hallucinated assessments and fabricated evidence

Unchanged core mechanisms from v1 §13.3 (structural containment via Option A's "LLM can
never touch the live result" property — now even stronger than v1's "can only add" framing,
since it can no longer add to the live result at all, only to the audit trail; the
mechanical grounding check in the parser), **plus** the new denormalization requirement
(§12's `groundedSignals`) resolving MEDIUM M5: any free-text `detail`/`escalationReason`
narrative now travels through the audit trail permanently paired with the actual raw numbers
it was supposedly describing, so a narrative that mischaracterizes real data is checkable by
a human or a future automated auditor without additional lookups.

### 13.4 Model authority escalation

Unchanged from v1's analysis: no path exists for LLM output to gain authority beyond an
audit-trail entry and (optionally) a best-effort console notice (§11.2). Since the LLM leg no
longer reaches `assess()`'s return value at all under this revision (§3.3), this is, if
anything, a strictly stronger guarantee than v1's already-adequate answer on this point.

---

## 14. Backward compatibility with Milestone 6A

### 14.1 Frozen list — now zero exceptions

`src/orchestration/supervisor/{types.ts (additive-only, §5), deterministicSupervisor.ts,
supervisorEngine.ts, inference.ts, supervisedHumanGate.ts}`,
`src/orchestration/humanGate/humanGate.ts`, `src/orchestration/runAuditedReviewLoop.ts`,
everything under `src/orchestration/claims/`, `src/sites/`, `src/browser/` — untouched. Per
§14.2 below, **`src/config/loadConfig.ts` and `config/config.json` are now also fully
untouched as source files**, resolving MEDIUM M2 by elimination rather than justification.

### 14.2 Resolving MEDIUM M2 — a fully standalone config loader

**v1's gap:** proposed an additive edit to `loadConfig.ts`, which 6A's own design doc lists
under its "Explicitly untouched" commitment — a real, if narrow, boundary violation under a
strict reading.

**Fix:** a new, independent file reads the same config path a second time, entirely outside
`loadConfig.ts`'s own function body and `AppConfig` type:

```ts
// design sketch — src/config/loadSupervisorConfig.ts (new file — loadConfig.ts is not
// imported, edited, or extended by this file; it independently parses the same
// config/config.json path, tolerant of the "supervisor" key being entirely absent)
export function loadSupervisorConfig(configPath?: string): SupervisorConfig | undefined {
  // reads the same JSON file loadConfig.ts reads, looks only at an optional top-level
  // "supervisor" key, returns undefined if absent (⇒ 6A-only behavior, unchanged), and
  // applies the same fail-loudly discipline loadConfig.ts uses for any field that IS
  // present but malformed (§7.2's isolationPreconditionsAcknowledged gate included).
}
```

An operator opting into LLM mode adds a `"supervisor": { ... }` key to their own
`config/config.json` **data file** — a per-deployment configuration change, not an edit to
any TypeScript source file this project treats as frozen. This distinction (source-code
integrity vs. deployment data) is the resolution: 6A's frozen-file guarantee is about code
this milestone must not alter, and no code is altered.

### 14.3 The default remains 6A, unconditionally

Unchanged from v1 §14.3 — no existing call site changes behavior unless an operator both
sets `supervisor.mode` in their own config data and the entry point is updated to read
`loadSupervisorConfig()` and construct `createAugmentedSupervisor(...)` accordingly.

---

## 15. Testing strategy

### 15.1 Unit tests (offline, pure functions and fakes, no Playwright)

| Test file | Covers |
|---|---|
| `tests/unit/supervisorPrompts.spec.ts`, `supervisorAssessmentParser.spec.ts` | Unchanged from v1 §15.1. |
| `tests/unit/llmSupervisorAdapter.spec.ts` | Unchanged from v1 §15.1. |
| `tests/unit/augmentedSupervisor.spec.ts` (**renamed from `compositeSupervisor.spec.ts`**) | **`assess()`'s return value is byte-identical to the deterministic leg's own result in every scenario, including LLM success, failure, and timeout** (the direct test of §3.3's structural guarantee); §6.2's lock — a second trigger while `busy` is skipped-and-recorded, not queued or dropped silently; the lock is released only on real settlement, not on the timeout race (a fake adapter that resolves *after* its configured timeout, asserting the record transitions `timed_out` and later gains a `lateResolution`, and that a trigger arriving between those two moments is still correctly skipped); §9.2's trigger-evaluation guard; §9.5's session-not-ready short-circuit (no dispatch is ever attempted). |
| `tests/unit/loadSupervisorConfig.spec.ts` (**new**) | Absent `supervisor` key ⇒ `undefined`; present-but-malformed fields fail loudly; `llm` present without `isolationPreconditionsAcknowledged: true` fails loudly (§7.2). |
| `tests/unit/supervisorIsolation.spec.ts` (**extended**) | 6A's existing assertions, plus: no file outside `augmentedSupervisor.ts` imports `llmSupervisorAdapter.ts` (§4.1, MEDIUM M1's enforcement); the §13.1 prompt-contract check. |

### 15.2 Simulation tests

Unchanged in scope from v1 §15.2 — a fake `ConversationalSiteAdapter` driven through the
real `createAugmentedSupervisor` + real `createSupervisedHumanGate`, now additionally
scripted to exercise overlapping-trigger timing (two triggers scheduled close enough
together to exercise §6.2's skip path) without a real browser.

### 15.3 Real browser tests

Extends `scripts/smoke-llm-supervisor.ts` (v1 §15.3, unchanged in basic shape) with the
optional nonce-based cross-conversation-leakage check described in §7.3, gated the same way
existing real-browser smoke scripts already are.

### 15.4 Compatibility/regression checks

Unchanged from v1 §15.4, strengthened: `git diff --stat` against every file in §14.1's now
fully-untouched frozen list (including `loadConfig.ts`/`config.json`) must show no output.

---

## 16. Implementation phases

**6B-1 — Adapter, prompt, parser (offline-testable):** unchanged scope from v1 6B-1.

**6B-2 — Augmented Supervisor (offline-testable):** `augmentedSupervisor.ts` implementing
§3.3's fixed-return-value contract, §6's lock/skip/timeout mechanics, §9's failure
boundaries; `tests/unit/augmentedSupervisor.spec.ts`.

**6B-3 — Standalone config and entry-point wiring:** `loadSupervisorConfig.ts` (§14.2);
entry-point construction of the augmented Supervisor when opted in; `llmSessionStatus` /
`llmSupervisorAssessments` assembly (§12).

**6B-4 — Simulation tests:** §15.2, including the overlapping-trigger scenario.

**6B-5 — Isolation and compatibility checks:** extended `supervisorIsolation.spec.ts`
(§4.1, §13.1); the full compatibility/regression pass (§15.4).

**6B-6 — Real-browser smoke verification (deferred, gated per `DECISIONS.md` §10's
precedent):** `scripts/smoke-llm-supervisor.ts`, including the §7.3 leakage check, run only
after §7.1's manual verification has actually been performed against the real accounts in
use.

---

## 17. Open questions (explicitly deferred, not decided here)

1. Should `llm.site` eventually support a genuinely separate, third automation
   profile/account, beyond reusing one of the two existing `sites.*` entries? Unchanged from
   v1 §17 — still a config extension point, not required now.
2. Should a `SupervisorFlag` ever carry a confidence/severity score from the LLM leg?
   Unchanged from v1 §17 — purely additive if added later.
3. **(New)** Is a skip-and-record policy (§6.2) the right choice over a bounded queue (e.g.,
   depth 1) for operators who would rather wait slightly longer for LLM coverage on every
   flagged round than miss some entirely during a sustained-stagnation episode? Left as a
   configuration extension point (`AugmentedSupervisorOptions.llm.overflowPolicy?:
   "skip" | "queue-depth-1"`) for a future revision if real usage shows skip-only is too
   lossy — not designed further here, since it has no bearing on the correctness properties
   this revision exists to establish.

---

## 18. File / module plan

**New files (none created by this design turn — design only):**

- `src/orchestration/supervisor/llmSupervisorAdapter.ts` (§4)
- `src/orchestration/supervisor/supervisorPrompts.ts`, `supervisorAssessmentParser.ts` (§8)
- `src/orchestration/supervisor/augmentedSupervisor.ts` (§3, §6, §9 — replaces v1's
  `compositeSupervisor.ts`, which is dropped from the plan under its old name)
- `src/config/loadSupervisorConfig.ts` (§14.2 — resolves MEDIUM M2 by never touching
  `loadConfig.ts`)
- `tests/unit/{supervisorPrompts,supervisorAssessmentParser,llmSupervisorAdapter,augmentedSupervisor,loadSupervisorConfig}.spec.ts`
- `scripts/smoke-llm-supervisor.ts` (§15.3, 6B-6)

**Additive-only edits:**

- `src/orchestration/supervisor/types.ts` — add `AugmentedSupervisor`,
  `LlmSupervisorAssessmentRecord`, `LlmSessionStatus`, extend `SupervisedReviewResult` with
  the two new optional fields, bump `SUPERVISED_REVIEW_RESULT_SCHEMA_VERSION` to `2`.
- `tests/unit/supervisorIsolation.spec.ts` — extend per §4.1, §13.1.
- The Milestone 6A entry point — updated to optionally call `loadSupervisorConfig()` and
  construct `createAugmentedSupervisor(...)` instead of the bare deterministic Supervisor,
  and to assemble `llmSupervisorAssessments`/`llmSessionStatus` into the result.

**Explicitly untouched — now with zero exceptions:** every file under
`src/orchestration/supervisor/` except the additive `types.ts` extension above,
`humanGate.ts`, `runAuditedReviewLoop.ts`, every file under `src/orchestration/claims/`,
`src/orchestration/convergence/`, `src/sites/`, `src/browser/`, **`src/config/loadConfig.ts`,
`config/config.json`** (as source files — §14.2), every existing script, every existing test
file.
