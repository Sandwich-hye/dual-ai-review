# MILESTONE6B_JEV_LLM_DESIGN_v4.md — Optional LLM-Based JEV Supervisor Adapter (Audit-Augmentation Model)

Design document for Phase 2A Milestone 6B. The post-v4 blocking correction adds only the
outcome helper described below; the rest of 6B remains unimplemented. This revision
**replaces** `MILESTONE6B_JEV_LLM_DESIGN_v3.md`
after a final architect review found that v3's own new failure-recovery mechanism (added to
fix a MEDIUM issue) reintroduced a narrower instance of the concurrency-bug class the
previous BLOCKING fix had closed. Milestone 6A remains completed, frozen, and touched by
zero exceptions, unchanged across every revision to date.

**Post-v4 final-review blocking correction:** `Supervisor.assess()` may fulfill with
`SupervisorUnavailable`. The outcome helper now classifies that value as a failure before
the timeout race, so both an immediate result and a late result after timeout take the same
audit and session-recovery path as a rejected adapter call. The helper and its focused tests
are implemented; the rest of Milestone 6B remains a design, with no change to the 6A gate.

---

## Revision history

**v4 (this revision) — fixes the final review's one BLOCKING and two MEDIUM findings, plus
its two named LOW polish items:**

1. **Fixed the lock-order bug (BLOCKING).** v3's `.finally()` released the busy-lock
   (`busy = false`) *before* dispatching the failure-recovery health check, so a new trigger
   could fire and dispatch a fresh browser operation against the shared page while the
   recovery check was still in flight against it — the same bug class as the original
   BLOCKING #2, reintroduced by its own fix. §6 is restructured around a single sequential
   `async` function (`runLlmLegAndRelease`) with one `try/finally`, so "the lock is released
   only after everything else has completed" is now a structural property of control flow
   (a `finally` block that runs after every `await` in its `try`), not something that has to
   be reasoned about across multiple independently-scheduled `.then()` callbacks the way v3's
   design required.
2. **Added the degraded-session dispatch guard (MEDIUM #1, resolved).** `maybeDispatchLlmLeg`
   now checks `sessionStatus` before ever reaching the busy-lock check, and short-circuits
   with an audited skip if the session is `"not_ready"` or `"degraded"`. Combined with the
   lock-order fix, `sinceRound`/the new `triggeringRecordId` are now genuinely set exactly
   once — the dispatch guard prevents the retries that were overwriting them in v3.
3. **Simplified session-health handling (MEDIUM #2, resolved).** `recheckSessionHealth` no
   longer manufactures a `Promise.reject(...)` from a `checkReady()` result that never
   actually rejects for a "not ready" condition. It reads `SiteAdapter.checkReady`'s real
   return value (a `SiteLoadStatus`) directly and branches on it — no invented rejection, no
   detour through a helper typed for `SupervisorAssessment`.
4. **Both LOW items resolved.** An explicit, local defensive `try/catch` now wraps the
   recovery-check call specifically (not just relying on the outer safety-net catch), and
   `LlmSessionStatus`'s `"degraded"` variant now carries a `triggeringRecordId` pointing
   directly at the `LlmSupervisorAssessmentRecord` (now given an explicit `id`) whose failure
   caused the degradation, rather than relying on matching round numbers.

**Unchanged in substance from v3:** §1 (Option A, the chosen execution model), §2 (6A
recap), §3 (architecture placement, the `assess()`-always-returns-deterministic-result
contract), §4 (adapter interface, internal-only), §5 (input contract; `SupervisorFlag.source`
remains removed), §7 (context isolation, including the dated attestation), §8 (prompt/parsing),
§10 (API/authentication strategy), §11 (audit trail as the sole surfacing channel, no console
notice), §13 (security), §14 (backward compatibility — still zero frozen-file exceptions).
Cited by section number, not restated.

---

## 1. Goal / Non-goals

Unchanged from v3 §1. Option A stands: `Supervisor.assess()` always returns exactly the
deterministic result; the LLM leg is a fully decoupled, fire-and-forget audit augmentation.
This revision changes nothing about that decision — it corrects the internal mechanics of
the decoupled leg itself.

---

## 2. Current state recap (6A, frozen)

Unchanged from v3 §2.

---

## 3. Architecture placement

Unchanged from v3 §3. The concrete dispatch mechanism §3.3 refers to is fully respecified in
§6 below.

---

## 4. LLM Supervisor adapter interface

Unchanged from v3 §4.

---

## 5. Input contract

Unchanged from v3 §5 — `SupervisorFlag.source` remains removed; not reintroduced by this
revision.

---

## 6. Browser concurrency control (rewritten — resolves the BLOCKING lock-order issue)

### 6.1 One session per run

Unchanged from v3 §6.1.

### 6.2 The fix: one sequential function owns the entire lock lifetime

**The structural problem with v3's design, stated precisely:** v3 expressed "settle → handle
timeout → attach late resolution → recover if needed → release lock" as a sequence of
independently-scheduled `.then()`/`.finally()` callbacks. Because JavaScript schedules each
callback as its own microtask, "do X, then release the lock" is only actually guaranteed if
every intermediate step is *chained into the same promise*, not merely *called from within*
an earlier step's callback (which is what v3's `.finally(() => { busy = false; ...;
maybeRecheckSessionHealth(...); })` did — the health check was *started* from inside the
`finally` callback, but nothing made the lock's release wait for it).

**The fix: replace the callback chain with one `async` function containing a single
`try/finally`, where every step is an `await`ed statement inside the `try` block, and the
lock is released exactly once, in the `finally`, which by JavaScript's own semantics cannot
run until every `await` above it — and everything each of those awaited calls does — has
completed.** This turns "the lock is held until everything is done" from a property that has
to be verified by tracing callback registration order into a property that is true by
construction: there is no code path through this function that reaches `finally` before the
`try` block's awaits have all resolved.

```ts
// design sketch — src/orchestration/supervisor/augmentedSupervisor.ts;
// raceWithTimeout/toSafeSupervisorOutcome live in llmSupervisorOutcome.ts

type SettledOutcome<T> =
  | { kind: "resolved"; value: T }
  | { kind: "rejected"; error: unknown };

type RaceOutcome<T> =
  | SettledOutcome<T>
  | { kind: "timeout"; awaitRealSettlement: () => Promise<SettledOutcome<T>> };

// The ONLY place a rejection from the LLM adapter call is observed. A fulfilled
// SupervisorUnavailable is also converted to the same failure outcome, using its reason.
// Every branch fulfills; the success branch contains only SupervisorAssessment.
function toSafeSupervisorOutcome(
  real: Promise<SupervisorAssessment | SupervisorUnavailable>,
): Promise<SettledOutcome<SupervisorAssessment>> {
  return real.then(
    (value) => "unavailable" in value
      ? { kind: "rejected", error: value.reason } as const
      : { kind: "resolved", value } as const,
    (error) => ({ kind: "rejected", error } as const),
  );
}

function raceWithTimeout(
  real: Promise<SupervisorAssessment | SupervisorUnavailable>,
  timeoutMs: number,
): Promise<RaceOutcome<SupervisorAssessment>> {
  const safeReal = toSafeSupervisorOutcome(real);             // never rejects, by construction
  const safeTimeout: Promise<{ kind: "timeout-signal" }> =
    delay(timeoutMs).then(() => ({ kind: "timeout-signal" } as const));   // a timer; never
                                                                             // rejects
  return Promise.race([safeReal, safeTimeout]).then((first) =>
    first.kind === "timeout-signal"
      ? { kind: "timeout", awaitRealSettlement: () => safeReal }    // hand back the SAME
                                                                        // safeReal promise —
                                                                        // awaiting it again
                                                                        // just waits for the
                                                                        // real operation's
                                                                        // eventual outcome,
                                                                        // it does not
                                                                        // re-dispatch anything
      : first,                                                       // safeReal itself won —
                                                                        // "resolved" or
                                                                        // "rejected"
  );
  // Both racers are provably non-rejecting, so Promise.race is provably non-rejecting, so
  // this function's returned promise is provably non-rejecting — no .catch() is needed or
  // safe to omit accidentally. (Unchanged reasoning from v3 §6.2/§6.3 — restated here
  // against the new, cleaner shape.)
}

function recordIndicatesFailure(record: LlmSupervisorAssessmentRecord): boolean {
  return record.status === "unavailable"
    || (record.status === "timed_out" && record.lateResolution?.kind === "failure");
}

async function runLlmLegAndRelease(
  record: LlmSupervisorAssessmentRecord,
  input: SupervisorInput,
): Promise<void> {
  try {
    const outcome = await raceWithTimeout(options.llm!.supervisor.assess(input), options.llm!.timeoutMs);

    if (outcome.kind === "resolved") {
      applyResolved(record, outcome.value, input);                    // §12 — includes §13's
                                                                          // grounded-signal
                                                                          // denormalization;
                                                                          // value is guaranteed
                                                                          // SupervisorAssessment
    } else if (outcome.kind === "rejected") {
      record.status = "unavailable";
      record.resolvedAt = nowIso();
      record.reason = describeError(outcome.error);
    } else {
      // outcome.kind === "timeout" — the browser operation is STILL RUNNING. The lock must
      // not be released until it actually finishes, so we await it here, inside the same
      // try block, before anything else happens.
      record.status = "timed_out";
      record.resolvedAt = nowIso();
      record.reason = `exceeded ${options.llm!.timeoutMs}ms`;

      const late = await outcome.awaitRealSettlement();               // NEVER rejects
      record.lateResolution = late.kind === "resolved"
        ? { kind: "success", resolvedAt: nowIso(), assessment: toRecordedAssessment(late.value) }
        : { kind: "failure", resolvedAt: nowIso(), reason: describeError(late.error) };
    }

    // Recovery check — INSIDE the same try block, i.e. inside the same lock boundary, and
    // therefore guaranteed to complete before `finally` releases the lock (this is the
    // direct fix for the BLOCKING finding: v3 started this same check AFTER releasing the
    // lock). Runs only when this dispatch's final outcome was a failure — never on success,
    // including a late success. A resolved SupervisorUnavailable is a failure both before
    // and after timeout, and therefore also reaches this recovery check.
    if (recordIndicatesFailure(record)) {
      try {
        await recheckSessionHealth(record);                            // §9.4 — rewritten;
                                                                          // never throws on
                                                                          // its own, but see
                                                                          // the local catch
                                                                          // below (LOW fix 1)
      } catch (error) {
        // Defensive, local to the recovery step specifically (not just the outer safety
        // net below): recheckSessionHealth is written so every path through it returns
        // normally (§9.4), so reaching this catch would indicate a bug in ITS OWN control
        // flow. Caught anyway, per this project's established "defense in depth even when
        // structurally guaranteed" convention (§7's prompt-injection framing uses the same
        // reasoning) — kept trivial so this handler's own risk of throwing is negligible.
        record.reason = `${record.reason ?? ""} [recovery check failed: ${describeError(error)}]`.trim();
      }
    }
  } finally {
    // Reached ONLY after: the LLM operation has settled (on time or late, success or
    // failure), timeout bookkeeping is complete, lateResolution (if any) is attached, AND
    // any recovery check triggered by a failure has itself completed (§6.3 below states why
    // this is guaranteed, not merely intended). This is the single, unconditional release
    // point for the lock — there is no other `busy = false` anywhere in this module.
    busy = false;
    busyRound = undefined;
  }
}

function maybeDispatchLlmLeg(result: SupervisorAssessment | SupervisorUnavailable, input: SupervisorInput): void {
  if (!options.llm) return;
  let round: number;
  try {
    if (!shouldTrigger(options.llm.trigger, result)) return;
    round = input.rounds.at(-1)!.roundNumber;
  } catch (error) {
    recordSkip(undefined, `trigger evaluation failed: ${describeError(error)}`);
    return;
  }

  // §6.5 (Fix #2) — checked BEFORE the busy-lock, so a degraded/not-ready session is
  // reported with its own specific reason rather than being conflated with "busy."
  if (sessionStatus.status === "not_ready" || sessionStatus.status === "degraded") {
    recordSkip(round, `llm session ${sessionStatus.status}: ${sessionStatus.detail}`);
    return;
  }
  if (busy) {
    recordSkip(round, `llm leg busy with round ${busyRound}`);
    return;
  }

  busy = true;
  busyRound = round;
  const record: LlmSupervisorAssessmentRecord = {
    id: `round-${round}`, round, status: "pending", dispatchedAt: nowIso(),
  };
  records.push(record);

  // Fire-and-forget from the caller's perspective — `assess()` (§3.3) has already returned
  // by the time this line runs. The `.catch()` here is the LAST-RESORT safety net: given
  // runLlmLegAndRelease's own try/finally and recheckSessionHealth's own internal handling,
  // reaching this catch would mean a genuinely unanticipated bug in this module's control
  // flow — it exists so that even such a bug can never produce an unhandled rejection or
  // leave the lock stuck.
  runLlmLegAndRelease(record, input).catch((internalError) => {
    record.status = "unavailable";
    record.resolvedAt = nowIso();
    record.reason = `unexpected internal error: ${describeError(internalError)}`;
    busy = false;
    busyRound = undefined;
  });
}
```

### 6.3 Why the ordering requirement is now guaranteed, not just intended

`runLlmLegAndRelease`'s `finally` block is lexically the *only* `busy = false` statement in
the normal control-flow path, and it sits after a single, unbroken `try` block containing
every step in sequence: the race/settle (`await raceWithTimeout(...)`), the late-settlement
wait when applicable (`await outcome.awaitRealSettlement()`), and the recovery check when
applicable (`await recheckSessionHealth(record)`). JavaScript's `async`/`await`/`finally`
semantics guarantee a `finally` block cannot begin executing until every statement lexically
before it in the same `try` block — including every `await` — has completed. There is no
way to reach the lock-release line early, because there is no other line that releases the
lock: this is the structural difference from v3, where the health check was *invoked from
inside* the callback that released the lock rather than *awaited before* releasing it.

`toSafeSupervisorOutcome` feeds both the immediate race result and the late-settlement
promise. Its `"resolved"` branch contains only a `SupervisorAssessment`; a fulfilled
`SupervisorUnavailable` becomes `"rejected"` with its `reason`. Thus a late unavailable
result sets `lateResolution.kind` to `"failure"`, and `recordIndicatesFailure` invokes the
same lock-scoped recovery check as for a thrown adapter failure.

### 6.4 Skip policy and audit completeness (unchanged from v3 §6.4, now also covering §6.5's new skip reason)

`recordSkip` produces a `status: "skipped"` record for every trigger that doesn't result in
a dispatch — busy, degraded/not-ready session (§6.5), or a trigger-evaluation failure — each
with a distinct, human-readable `reason`, so an auditor can always tell *why* a given round's
LLM leg never ran, not just *that* it didn't.

### 6.5 Degraded-session dispatch guard, stated as its own subsection per the review's checklist

Restated precisely, since this is one of the review's named required fixes: `sessionStatus`
is checked at the very top of `maybeDispatchLlmLeg`, before the busy-lock check. Once
`sessionStatus.status` is `"not_ready"` (never became usable, §9.5) or `"degraded"` (became
unusable partway through, §9.4), **every subsequent trigger for the rest of the run is
skipped-and-recorded, unconditionally** — no dispatch is ever attempted again. This is what
makes `sinceRound`/`triggeringRecordId` (§9.4, §12) stable: once set, nothing can trigger a
second write to them, because nothing can trigger a second recovery check at all.

---

## 7. Context isolation strategy

Unchanged from v3 §7.

---

## 8. Prompt design and parsing

Unchanged from v3 §8.

---

## 9. Failure handling

### 9.1–9.3 Deterministic assessment, trigger evaluation, parsing/grounding boundaries

Unchanged from v3 §9.1–9.3.

### 9.4 Session recovery — simplified (resolves MEDIUM #2, and now correctly lock-scoped per §6)

**v3's gap:** manufactured a `Promise.reject(...)` from a `checkReady()` result that, per the
real `SiteAdapter.checkReady(page: Page): Promise<SiteLoadStatus>` contract, resolves to a
status value — including "not ready" states — rather than rejecting for them. Routing that
synthetic rejection through `toSafeOutcome` (a helper typed for
`SupervisorAssessment | SupervisorUnavailable`) worked, but was needless indirection built on
a failure mode `checkReady` doesn't actually have.

**Fix — read the real return value directly, no manufactured rejection:**

```ts
// design sketch — src/orchestration/supervisor/augmentedSupervisor.ts
async function recheckSessionHealth(triggeringRecord: LlmSupervisorAssessmentRecord): Promise<void> {
  if (sessionStatus.status === "degraded") return;    // already degraded — §6.5 guarantees
                                                        // this function is never even called
                                                        // again after that, but the guard is
                                                        // kept anyway as a cheap, explicit
                                                        // statement of the immutability
                                                        // requirement (Fix #2's "sinceRound
                                                        // is immutable after first failure")
  let status: SiteLoadStatus | undefined;
  let checkError: unknown;
  try {
    status = await adapter.checkReady(page);           // resolves to a SiteLoadStatus even
                                                        // for "not ready" conditions; only a
                                                        // genuine unexpected failure (e.g.
                                                        // the page itself is gone) reaches
                                                        // the catch below
  } catch (error) {
    checkError = error;
  }

  if (checkError !== undefined) {
    degradeSession(`checkReady threw: ${describeError(checkError)}`, triggeringRecord);
  } else if (status !== "ready") {
    degradeSession(`checkReady returned "${status}"`, triggeringRecord);
  }
  // status === "ready": no action. The existing adapter's own navigation/composer-recovery
  // behavior (already required to be idempotent per 4A/4B/5's site-adapter conventions) is
  // trusted to have left the page reusable; this check only confirms the page is at least
  // minimally responsive before the NEXT dispatch is permitted to proceed.
}

function degradeSession(detail: string, triggeringRecord: LlmSupervisorAssessmentRecord): void {
  sessionStatus = {
    status: "degraded",
    detail,
    sinceRound: triggeringRecord.round,
    triggeringRecordId: triggeringRecord.id,            // NEW — LOW fix #2, §12
  };
}
```

This function has exactly two exit paths — the early-return guard, and falling off the end
after the try/catch — and every statement inside is a plain `await`, a property read, or a
call to `degradeSession` (itself two property writes). There is no `.then()`/`.catch()`
chain left to reason about, and — per §6.2/§6.3 — this entire function now runs, and
completes, strictly before `runLlmLegAndRelease`'s `finally` releases the lock.

### 9.5 Login/session expiry (unchanged from v3 §9.5)

Start-of-run `checkReady()` still gates whether the LLM leg is ever attempted at all;
`llmSessionStatus` still unifies "never ready" and "degraded mid-run" into one accessor.

### 9.6 The resulting, testable invariant

Unchanged claim from v3 §9.6, now additionally covering the ordering property: no code this
milestone adds can cause `assess()` to deviate from the deterministic result, produce an
unhandled promise rejection, **or release the browser-page lock before every step that
touches the page — including recovery — has completed.** §15.1 tests all three properties
when the augmented supervisor is implemented. The outcome-helper tests already cover the
resolved-unavailable, rejected, timed-out, and normal-assessment branches.

---

## 10. API/authentication strategy

Unchanged from v3 §10.

---

## 11. When and how LLM results are surfaced

Unchanged from v3 §11 — the audit trail remains the sole channel; no console notice.

---

## 12. Audit requirements

```ts
// design sketch — src/orchestration/supervisor/types.ts, additive extension
export const SUPERVISED_REVIEW_RESULT_SCHEMA_VERSION = 2;   // unchanged

export interface SupervisedReviewResult {
  schemaVersion: number;
  base: AuditedReviewResult;
  supervisorAssessments: (SupervisorAssessment | SupervisorUnavailable)[];
  llmSupervisorAssessments?: LlmSupervisorAssessmentRecord[];
  llmSessionStatus?: LlmSessionStatus;
}

export type LlmSessionStatus =
  | { status: "not_configured" }
  | { status: "not_ready"; detail: string }
  | { status: "ready" }
  | { status: "degraded"; detail: string; sinceRound: number; triggeringRecordId: string };
                                                          // triggeringRecordId is NEW (LOW
                                                          // fix #2) — points directly at the
                                                          // LlmSupervisorAssessmentRecord.id
                                                          // whose failure caused this
                                                          // transition, rather than relying
                                                          // on matching sinceRound against
                                                          // round numbers by convention

export interface LlmSupervisorAssessmentRecord {
  id: string;                                             // NEW — `round-${round}`, unique
                                                          // within a run; the cross-reference
                                                          // target for triggeringRecordId
  round: number;
  status: "pending" | "resolved" | "unavailable" | "timed_out" | "skipped";
  dispatchedAt?: string;
  resolvedAt?: string;
  assessment?: SupervisorAssessment;
  groundedSignals?: SupervisorRecommendationSignal[];
  reason?: string;
  prompt?: string;
  rawResponse?: string;
  lateResolution?:
    | { kind: "success"; resolvedAt: string; assessment?: SupervisorAssessment }
    | { kind: "failure"; resolvedAt: string; reason: string };
}
```

**Reconstruction, restated against the review's exact ask:** given
`llmSessionStatus.status === "degraded"`, an auditor reads `triggeringRecordId`, looks up
that exact record in `llmSupervisorAssessments`, and sees precisely what failed (an
`"unavailable"` record's `reason`, or a `"timed_out"` record's `lateResolution` of
`kind: "failure"`) — a direct pointer, not an inference from matching round numbers. Because
§6.5's dispatch guard makes degradation a one-time transition, this pointer is guaranteed
stable for the rest of the run: nothing can overwrite `sinceRound`/`triggeringRecordId` after
they're first set.

Assembly (entry point, after the run) is otherwise unchanged from v3 §12.

---

## 13. Security considerations

Unchanged from v3 §13.

---

## 14. Backward compatibility with Milestone 6A

Unchanged from v3 §14 — zero frozen-file exceptions; `types.ts`'s additive surface grows
(new `id` field, new `triggeringRecordId` field) but still never touches `SupervisorFlag` or
any other 6A-frozen type.

---

## 15. Testing strategy

### 15.1 Unit tests — updated for the new structure

| Test file | Covers |
|---|---|
| `tests/unit/llmSupervisorOutcome.spec.ts` (**implemented**) | Resolved `SupervisorUnavailable` and rejected adapter promises both become failure outcomes; timeout retains the real operation and classifies late unavailability as failure; normal `SupervisorAssessment` remains a success. |
| `tests/unit/supervisorPrompts.spec.ts`, `supervisorAssessmentParser.spec.ts`, `llmSupervisorAdapter.spec.ts` | Unchanged from v3. |
| `tests/unit/augmentedSupervisor.spec.ts` | The five scenarios from v3 §15.1, **retargeted at the new `runLlmLegAndRelease`/`raceWithTimeout` shape**: (1) resolves normally; (2) timeout, with `busy`/`getLlmSessionStatus()` asserted to still reflect "in progress" until the fake adapter's promise is manually settled in the test, at which point `lateResolution` and the lock release both become observable in the same tick's worth of awaited assertions; (3) rejects before timeout, with a `process.on("unhandledRejection")` listener installed for the test's duration asserting none fires; (4) rejects after timeout, asserting `lateResolution.kind === "failure"` and, again, no unhandled rejection; (5) session failure at start (`checkReady` returns non-`"ready"` before the run begins — no dispatch ever attempted) and mid-run (a dispatch fails, triggering `recheckSessionHealth`, asserting `sessionStatus` transitions to `"degraded"` with the correct `triggeringRecordId`). **New test (direct check of the BLOCKING fix):** a fake adapter that fails, and whose `recheckSessionHealth`-triggered `checkReady()` call is held pending by the test via a manually-resolved promise; asserts that a trigger fired *while `checkReady()` is still pending* is skipped (`busy` is still `true`), proving the lock is held through the recovery check, not just through the main operation. **New test (Fix #2):** after a session is marked `"degraded"`, assert every subsequent triggered round is skipped with a `sessionStatus`-referencing reason and that `sessionStatus.sinceRound`/`triggeringRecordId` are unchanged across those later skips. |
| `tests/unit/loadSupervisorConfig.spec.ts`, `tests/unit/supervisorIsolation.spec.ts` | Unchanged from v3. |

When `augmentedSupervisor.ts` is implemented, its integration tests must also assert that
both immediate and late resolved `SupervisorUnavailable` records trigger the same
`recheckSessionHealth` path as rejected calls, with the lock held until recovery completes.

### 15.2–15.4 Simulation, real browser, compatibility/regression checks

Unchanged from v3 §15.2–15.4.

---

## 16. Implementation phases

Unchanged in overall shape from v3 §16. The outcome normalization and timeout race are
implemented in `llmSupervisorOutcome.ts`. 6B-2 ("Augmented Supervisor") still must wire
that helper into `runLlmLegAndRelease` and its lock-scoped `recheckSessionHealth` in one
`try/finally` structure; §6.3's ordering guarantee depends on that structure.

---

## 17. Open questions

Unchanged from v3 §17.

---

## 18. File / module plan

The blocking correction adds `src/orchestration/supervisor/llmSupervisorOutcome.ts` and
`tests/unit/llmSupervisorOutcome.spec.ts`. The future augmented supervisor imports the
helper, so fulfilled `SupervisorUnavailable` never reaches `applyResolved` or
`toRecordedAssessment`.

Unchanged file list from v3 §18. Type additions on `src/orchestration/supervisor/types.ts`
now also include `LlmSupervisorAssessmentRecord.id` and
`LlmSessionStatus`'s `"degraded"` variant's `triggeringRecordId` field — still additive-only,
still never touching `SupervisorFlag` or any other 6A-frozen type.

**Explicitly untouched — zero exceptions:** unchanged from v3.
