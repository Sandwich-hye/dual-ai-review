# MILESTONE6B_JEV_LLM_DESIGN_v3.md — Optional LLM-Based JEV Supervisor Adapter (Audit-Augmentation Model)

Design-only document for Phase 2A Milestone 6B. **No production TypeScript is changed or
written by this document.** This revision **replaces** `MILESTONE6B_JEV_LLM_DESIGN_v2.md`
after an architect review found one remaining BLOCKING issue (a concrete unhandled-promise-
rejection bug in v2's own concurrency sketch) and four MEDIUM issues. Milestone 6A
(`MILESTONE6_JEV_DESIGN_v3.md`, commit `fd86859`) remains completed, frozen, and touched by
zero exceptions, exactly as v2 established.

---

## Revision history

**v3 (this revision) — fixes the last BLOCKING issue and all four MEDIUM issues from the v2
review; the execution model (Option A, advisory-only audit augmentation) chosen in v2 is
unchanged and not revisited:**

1. **Fixed the async promise-handling bug (BLOCKING).** v2's timeout race used
   `real.then((a) => ({kind:"resolved", a}))` as a `Promise.race` participant with no
   rejection handler — if the LLM adapter call rejected *before* its timeout elapsed, that
   rejection propagated into `Promise.race` and out through an unhandled `.then()`, which in
   modern Node.js terminates the process. §6 is rewritten around one structural rule: **no
   promise this module ever constructs is allowed to reject** — every derived promise
   translates rejection into a value via two-argument `.then(onFulfilled, onRejected)`,
   eliminating the entire bug *class*, not just the one instance found. Five explicit test
   cases are named (§15.1) matching the five scenarios the review required.
2. **Late-failure audit symmetry (MEDIUM #2, resolved).** `lateResolution` is now a
   discriminated union (`kind: "success" | "failure"`) — a real operation that finishes
   *after* its round was already recorded `"timed_out"` is now recorded whether it
   eventually succeeds or fails, closing the asymmetry v2 had.
3. **`SupervisorFlag.source` removed (MEDIUM #3, resolved by removal).** Under the
   audit-augmentation model, deterministic flags and LLM assessment records were already
   fully separate types (§5) — the field had no remaining consumer. It is deleted from the
   type plan rather than re-justified.
4. **Console notice removed (MEDIUM #4, resolved — Option A chosen).** §11 no longer
   describes an asynchronous console notice at all. The audit trail
   (`SupervisedReviewResult`) is the sole surfacing mechanism for LLM output. §11.3 states
   the rationale for not choosing the alternative (an always-auditable notice, Option B).
5. **Two low-risk clarifications added (MEDIUM #5).** §9.4: failed-call page recovery is
   handled by re-checking `checkReady()` before the next dispatch and permanently disabling
   the LLM leg for the rest of the run if the session is found degraded, rather than
   silently retrying against a possibly-broken page. §7.2: the isolation attestation is
   strengthened from a bare `isolationPreconditionsAcknowledged: true` boolean to a dated
   `isolationAttestedAt` string with a bounded maximum age, forcing periodic re-verification
   instead of a value that could sit unattended in a config template indefinitely.

**Unchanged in substance from v2:** §1's chosen execution model (Option A), §2 (6A recap),
§3's architecture placement and the `AugmentedSupervisor`/`assess()`-always-returns-
deterministic-result contract, §4 (adapter interface, still internal-only per MEDIUM M1's
resolution), §8 (prompt design and grounding-checked parsing), §10 (API/authentication
strategy), §14.2's standalone config loader (still touches zero frozen files). These are
cited by section number, not restated in full.

---

## 1. Goal / Non-goals

Unchanged from v2 §1. The chosen execution model — **Option A: advisory-only audit
augmentation** — stands: `Supervisor.assess()` always returns exactly what the deterministic
Supervisor alone computes; the LLM leg runs as a fully decoupled background operation whose
result lands only in the audit trail. Nothing in this revision touches that decision; every
change here is about making the *mechanism* underneath it (concurrency, audit completeness,
isolation attestation) correct and complete.

The preserved-invariants table from v2 §1 is unchanged and, if anything, now more airtight:
with the console notice removed (§11), there is no longer even a best-effort, unaudited
channel through which LLM output could reach a human during a live run — the audit trail,
read after the fact, is the only path, full stop.

---

## 2. Current state recap (6A, frozen)

Unchanged from v2 §2.

---

## 3. Architecture placement

Unchanged from v2 §3 — the diagram (§3.1), the `AugmentedSupervisor` type (§3.2), and the
one-line contract (§3.3: `assess()`'s return value is fixed before the LLM leg is ever
dispatched) are all still correct and are not revised here. The concrete dispatch mechanism
§3.3 refers to is now specified precisely in §6, which is fully rewritten in this revision.

---

## 4. LLM Supervisor adapter interface

Unchanged from v2 §4 — `createLlmSupervisor` remains internal to
`src/orchestration/supervisor/`, enforced by the isolation test (§15.1's extended
`supervisorIsolation.spec.ts`).

---

## 5. Input contract, and the removal of `SupervisorFlag.source`

The input contract itself is unchanged from v2 §5 — still the same closed `SupervisorInput`.

### 5.1 `SupervisorFlag.source` is removed (resolves MEDIUM #3)

v1 proposed an optional `source?: "LLM"` tag on `SupervisorFlag`, intended to let a caller
distinguish deterministic-origin flags from LLM-origin flags inside a single, merged
`flags[]` array. v2's architecture (§3.3) never produces such a merged array — deterministic
flags live only in `supervisorAssessments[i].flags` (6A's own, untouched type) and LLM flags
live only inside `LlmSupervisorAssessmentRecord.assessment.flags` (§12), a completely
separate structure. Provenance is therefore already unambiguous by *which array a flag
appears in*, not by a per-flag tag. `source` has no remaining reader or writer anywhere in
this design.

**Decision: remove it.** It is not carried forward into the type plan (§18). This also
strengthens §14's backward-compatibility claim: `SupervisorFlag` (a 6A/frozen type) is no
longer touched by this milestone's additive changes *at all* — the only additive surface on
`types.ts` is now entirely new types (`AugmentedSupervisor`, `LlmSupervisorAssessmentRecord`,
`LlmSessionStatus`) plus the two new optional fields on `SupervisedReviewResult`.

---

## 6. Browser concurrency control (rewritten — resolves the remaining BLOCKING issue)

### 6.1 One session per run, lock released only on real settlement

Unchanged framing from v2 §6.1/§6.3: one dedicated `Page`/conversation opened once at run
start; the busy-lock is released only when the underlying browser operation itself finishes,
never merely when a timeout is logically declared. What changes in this revision is *how*
that is implemented, to eliminate the promise-rejection bug the v2 review found.

### 6.2 The structural rule: no promise this module constructs may ever reject

**This is the fix, stated as a rule an implementer can check mechanically, not as a patch to
one call site:** every promise `augmentedSupervisor.ts` derives from the LLM adapter's
`assess()` call is converted, immediately, into a promise that **always fulfills** — never
rejects — by using the two-argument form of `.then(onFulfilled, onRejected)` to turn a
rejection into an ordinary value. Once every derived promise in the chain is rejection-free
by construction, `Promise.race` over them cannot reject either, and there is no path left for
an unhandled rejection to occur from adapter failure, timing, or ordering.

```ts
// design sketch — src/orchestration/supervisor/augmentedSupervisor.ts

type LlmCallOutcome =
  | { kind: "resolved"; value: SupervisorAssessment | SupervisorUnavailable }
  | { kind: "rejected"; error: unknown };

// The ONLY place a rejection from the LLM leg is ever observed. From this point on, in this
// module, "the LLM call failed" is a VALUE (LlmCallOutcome), never a promise rejection.
function toSafeOutcome(
  real: Promise<SupervisorAssessment | SupervisorUnavailable>,
): Promise<LlmCallOutcome> {
  return real.then(
    (value) => ({ kind: "resolved", value } as const),
    (error) => ({ kind: "rejected", error } as const),
  );
}

function maybeDispatchLlmLeg(
  result: SupervisorAssessment | SupervisorUnavailable,
  input: SupervisorInput,
): void {
  if (!options.llm) return;
  let round: number;
  try {
    if (!shouldTrigger(options.llm.trigger, result)) return;
    round = input.rounds.at(-1)!.roundNumber;
  } catch (error) {
    recordSkip(round, `trigger evaluation failed: ${describeError(error)}`);
    return;
  }
  if (busy) {
    recordSkip(round, `llm leg busy with round ${busyRound}`);   // §6.4, unchanged from v2
    return;
  }

  busy = true;
  busyRound = round;
  const record: LlmSupervisorAssessmentRecord = { round, status: "pending", dispatchedAt: nowIso() };
  records.push(record);

  const real = options.llm.supervisor.assess(input);      // the actual browser operation —
                                                            // never cancelled; kept as the
                                                            // single source of truth for
                                                            // "has the browser op finished"
  const safeReal = toSafeOutcome(real);                    // STRUCTURALLY cannot reject

  const safeTimeout: Promise<{ kind: "timeout" }> =
    delay(options.llm.timeoutMs).then(() => ({ kind: "timeout" } as const));  // a timer, not
                                                                                 // an I/O op —
                                                                                 // also cannot
                                                                                 // reject

  // Both racers are now guaranteed non-rejecting, so Promise.race over them is guaranteed
  // non-rejecting too — the exact class of bug the v2 review found is structurally excluded
  // here, not just absent from this one call site.
  Promise.race([safeReal, safeTimeout]).then((first) => {
    // This handler ONLY ever writes "timed_out", and only when the TIMEOUT promise is the
    // one that settled the race — which, by construction, can only happen while `safeReal`
    // is still pending. There is therefore no overlap or ordering dependency with the
    // settlement handler below: the two handlers can never both be reacting to the same
    // underlying event, so no additional synchronization is needed between them.
    if (first.kind === "timeout" && record.status === "pending") {
      record.status = "timed_out";
      record.resolvedAt = nowIso();
      record.reason = `exceeded ${options.llm!.timeoutMs}ms`;
      // The lock is deliberately NOT released here. Release is driven solely by the
      // settlement handler below, attached directly to `safeReal` — the one thing that
      // actually reflects whether the browser operation has finished.
    }
  });   // no .catch() needed, and none is safe to omit accidentally: this promise is
        // guaranteed non-rejecting by construction (both racers are), so there is nothing
        // for a .catch() to do here.

  // Settlement tracking — the sole authority on when the real browser operation has
  // finished, and the sole place §6.4's late-success/late-failure records (resolving
  // MEDIUM #2) and the busy-lock release are written.
  safeReal
    .then((outcome) => {
      if (outcome.kind === "resolved") {
        if (record.status === "timed_out") {
          record.lateResolution = { kind: "success", resolvedAt: nowIso(),
                                     assessment: toRecordedAssessment(outcome.value) };
        } else {
          applyResolved(record, outcome.value, input);          // §12 — includes §13.3's
                                                                    // grounded-signal
                                                                    // denormalization
        }
      } else {
        // outcome.kind === "rejected" — reached uniformly whether the adapter call failed
        // before or after any logical timeout; only `record.status` (written above, if the
        // timeout race ran first) distinguishes the two cases.
        const reason = describeError(outcome.error);
        if (record.status === "timed_out") {
          record.lateResolution = { kind: "failure", resolvedAt: nowIso(), reason };  // NEW —
                                                                                          // the
                                                                                          // late-
                                                                                          // failure
                                                                                          // case
                                                                                          // v2
                                                                                          // dropped
        } else {
          record.status = "unavailable";
          record.resolvedAt = nowIso();
          record.reason = reason;
        }
      }
    })
    .catch((internalError) => {
      // Defense in depth: `outcome` above can never itself be a rejection (toSafeOutcome
      // guarantees that), so this catches only a hypothetical bug in THIS module's own
      // record-writing code, not the adapter. Kept deliberately trivial (plain property
      // assignment) so this handler's own risk of throwing is as close to zero as this
      // language allows.
      record.status = "unavailable";
      record.resolvedAt = nowIso();
      record.reason = `internal error recording LLM result: ${describeError(internalError)}`;
    })
    .finally(() => {
      busy = false;              // released ONLY once the real operation has genuinely
      busyRound = undefined;      // settled — independent of the timeout race outcome
      maybeRecheckSessionHealth(outcome_was_failure); // §9.4 — page-recovery check
    });
}
```

### 6.3 Why this closes the bug class, not just the one instance

Every promise this function creates or reads from is now provably non-rejecting except one:
`real` itself (the raw adapter call), and the very first thing done with it is to wrap it via
`toSafeOutcome`, which is the *only* place in the module a rejection from `real` is ever
observed, and it converts that rejection into a value on the spot. Every promise derived
after that point (`safeReal`, `safeTimeout`, the `Promise.race` over them, and the
`.then().catch().finally()` chain) is either provably non-rejecting by construction, or — for
the one remaining internal `.catch()` — guarded defensively against the module's own bugs.
**No `.then()` anywhere in this function is missing a corresponding rejection path**, which
is the precise, mechanically-checkable property the v2 sketch violated.

### 6.4 Skip policy, late resolution semantics (mostly unchanged from v2, restated for completeness)

Skip-not-queue for overlapping triggers (`recordSkip`), and `lateResolution` now covering
both success and failure (§6.2 above), are the complete set of outcomes a
`LlmSupervisorAssessmentRecord` can reach: `pending → {resolved | unavailable | timed_out |
skipped}`, with `timed_out` optionally gaining a `lateResolution` of either kind once the
real operation actually finishes. This is the full state machine — no other transitions are
possible, which §15.1's test matrix (§15.1) exercises exhaustively.

---

## 7. Context isolation strategy

### 7.1 Mandatory preconditions

Unchanged from v2 §7.1 (dedicated profile, separate conversation, memory/history-reference
disabled, manual one-time verification).

### 7.2 Stronger isolation attestation (resolves MEDIUM #5, second half)

**v2's gap:** `isolationPreconditionsAcknowledged: true` was a bare boolean — trivially
satisfied once and then left, unattended and unchanged, in a config file indefinitely, even
if the underlying account setting it attests to were later re-enabled (e.g., a product
update turns a memory feature back on, or a different operator reuses the same profile
without knowing this attestation exists).

**Fix:** replace the boolean with a dated attestation, bounded to a maximum age:

```ts
// design sketch — SupervisorConfig, §14.2
export const ISOLATION_ATTESTATION_MAX_AGE_DAYS = 30;

llm?: {
  site: "chatgpt" | "claude";
  trigger: LlmTriggerPolicy;
  timeoutMs: number;
  isolationAttestedAt: string;    // REQUIRED ISO date string. loadSupervisorConfig (§14.2)
                                    // fails loudly if `llm` is present and this field is
                                    // absent, malformed, in the future, or more than
                                    // ISOLATION_ATTESTATION_MAX_AGE_DAYS old at load time.
                                    // Still not a technical guarantee that the underlying
                                    // account settings are actually off (unchanged limitation
                                    // from v2 — this project has no API to verify that), but
                                    // now a periodically-expiring one rather than a
                                    // permanent, unattended `true`, forcing the operator to
                                    // deliberately re-confirm §7.1 on a bounded cadence.
};
```

Thirty days is a design-time default, not a hardcoded requirement of the underlying idea —
chosen as long enough not to be an operational burden for a single run or short project, and
short enough that a re-verification is a realistic, recurring habit rather than a one-time
box ticked years ago.

### 7.3 Leakage test strategy

Unchanged from v2 §7.3 — the nonce-based cross-conversation smoke test, run in the real-
browser test tier (§15.3).

---

## 8. Prompt design and parsing

Unchanged from v2 §8.

---

## 9. Failure handling

### 9.1–9.3 Deterministic assessment, trigger evaluation, parsing/grounding boundaries

Unchanged from v2 §9.1, §9.2, §9.4 (renumbered here as 9.1–9.3 for this revision's flow).

### 9.4 Failed-call page recovery (resolves MEDIUM #5, first half)

**v2's gap:** no explicit handling for whether the shared page is safe to reuse for the next
dispatch after a failure (e.g., a half-submitted composer from an interrupted `sendPrompt`).

**Fix:** every time the settlement handler in §6.2 records an `"unavailable"` outcome (either
directly, or via a `lateResolution` of `kind: "failure"`), the `.finally()` block calls a
small recovery check before releasing full future eligibility:

```ts
// design sketch — inside the .finally() block in §6.2
function maybeRecheckSessionHealth(wasFailure: boolean): void {
  if (!wasFailure) return;
  // Fire-and-forget itself, using the same non-rejecting pattern as §6.2 — a health check
  // must never be able to introduce a NEW unhandled rejection while recovering from one.
  toSafeOutcome(adapter.checkReady(page).then((status) => status === "ready"
    ? Promise.resolve({} as SupervisorAssessment)     // placeholder success marker; the
                                                          // actual check only cares about
                                                          // fulfil vs. reject/false below
    : Promise.reject(new Error(`session not ready: not "ready"`))))
    .then((outcome) => {
      if (outcome.kind === "rejected") {
        sessionStatus = { status: "degraded", detail: describeError(outcome.error) };  // §12 —
                                                                                           // ALL
                                                                                           // future
                                                                                           // triggers
                                                                                           // short-
                                                                                           // circuit
                                                                                           // from
                                                                                           // here on
      }
      // If ready: no action needed. The existing adapter's own navigation/composer-recovery
      // behavior (already required to be idempotent per 4A/4B/5's own site-adapter
      // conventions) is trusted to have left the page in a reusable state; this check only
      // needs to confirm the page is at least minimally responsive before the next dispatch.
    });
}
```

A session found `"degraded"` this way behaves exactly like a session that was never
`"ready"` at run start (§9.5 below) — no further dispatches are attempted for the rest of the
run, and this is recorded once, not repeated per subsequent skipped trigger.

### 9.5 Login/session expiry, now unified with mid-run degradation

Unchanged in its start-of-run form from v2 §9.5 (`checkReady()` once before the run begins;
`"not_ready"` disables the LLM leg entirely). §9.4 above extends the *same*
`getLlmSessionStatus()` accessor to also report `"degraded"` if a mid-run failure's recovery
check comes back unhealthy — an auditor reading the final result sees one coherent status
field either way, distinguishing "never usable this run" from "usable, then degraded" (with
the specific round/reason recoverable by cross-referencing the last non-skipped
`LlmSupervisorAssessmentRecord` before the degradation).

### 9.6 The resulting, testable invariant — now precisely and completely checkable

No code this milestone adds can cause `assess()` to reject, hang, or deviate from exactly
what `deterministic.assess(input)` alone would return — unchanged from v2's claim — **and, as
of this revision, no code this milestone adds can produce an unhandled promise rejection
under any adapter behavior**, which is the specific, additional guarantee §6 exists to
provide and which v2's sketch did not actually satisfy despite claiming to. §15.1's five
required test cases are the direct check of this.

---

## 10. API/authentication strategy

Unchanged from v2 §10.

---

## 11. When and how LLM results are surfaced (rewritten — resolves MEDIUM #4)

### 11.1 The sole channel: the audit trail, read after the run

Unchanged from v2 §11.1 — `SupervisedReviewResult.llmSupervisorAssessments`, assembled by
the entry point after `runAuditedReviewLoop()` returns.

### 11.2 The console notice is removed

v2 §11.2 described an asynchronous, round-decoupled console print whenever a pending LLM
assessment resolved. The v2 review correctly identified this as a real, if narrow, side
channel: untimed, unassociated with any specific round's official presentation, and capable
of interleaving with the frozen Human Gate's own terminal output during an in-progress
prompt — none of which was reflected in the audit trail, so there was no way to reconstruct
afterward whether, or when, such a notice might have been visible to the deciding human.

**Decision: removed entirely (Option A).** There is no console notice, best-effort or
otherwise, in this design. The audit trail (§12) is the only mechanism by which LLM output
is ever surfaced, at all, live or retrospectively.

### 11.3 Why Option B (an always-auditable notice) was not chosen instead

Option B — keeping the notice but requiring a timestamp, round association, and a recorded
"visibility" entry per notice — was considered. It was rejected for this revision because it
would require either (a) writing to the audit record from a callback that fires at an
arbitrary point relative to the *next* round's own gate-open (reintroducing exactly the kind
of "what does the human already know when this round opens" reasoning §0.1/§3 exist to avoid
having to answer precisely), or (b) touching `supervisedHumanGate.ts` to correlate a
console-timed event with its own round boundaries, which is frozen (§14.1). Since §11.1's
audit trail already satisfies every actual requirement this milestone has (a complete,
reconstructable record of what the LLM concluded and when) without either of those costs,
there is no live requirement Option B uniquely serves. §17 notes it as a possible future
extension, not a gap in this design.

---

## 12. Audit requirements

```ts
// design sketch — src/orchestration/supervisor/types.ts, additive extension
export const SUPERVISED_REVIEW_RESULT_SCHEMA_VERSION = 2;   // unchanged reasoning from v2

export interface SupervisedReviewResult {
  schemaVersion: number;
  base: AuditedReviewResult;                                          // unchanged
  supervisorAssessments: (SupervisorAssessment | SupervisorUnavailable)[];   // unchanged
  llmSupervisorAssessments?: LlmSupervisorAssessmentRecord[];
  llmSessionStatus?: LlmSessionStatus;
}

export type LlmSessionStatus =
  | { status: "not_configured" }
  | { status: "not_ready"; detail: string }                            // never became usable
  | { status: "ready" }                                                 // usable for the
                                                                          // whole run
  | { status: "degraded"; detail: string; sinceRound: number };         // NEW — became
                                                                          // unusable partway
                                                                          // through (§9.4)

export interface LlmSupervisorAssessmentRecord {
  round: number;
  status: "pending" | "resolved" | "unavailable" | "timed_out" | "skipped";
  dispatchedAt?: string;
  resolvedAt?: string;
  assessment?: SupervisorAssessment;
  groundedSignals?: SupervisorRecommendationSignal[];    // unchanged from v2 — denormalized
                                                           // raw numbers for §13.3
  reason?: string;
  prompt?: string;
  rawResponse?: string;
  lateResolution?:                                        // REVISED — now symmetric
    | { kind: "success"; resolvedAt: string; assessment?: SupervisorAssessment }
    | { kind: "failure"; resolvedAt: string; reason: string };
}
```

**Reconstruction, restated precisely against the review's explicit ask** — a future auditor
reading one `LlmSupervisorAssessmentRecord` can always answer:

- *Did this round's LLM leg run at all?* — `status !== "skipped"`, with `reason` naming which
  in-flight round it was blocked behind if it was skipped.
- *Did it time out?* — `status === "timed_out"`.
- *If it timed out, did the real operation later succeed?* — `lateResolution?.kind ===
  "success"`, with the resolved `assessment` attached.
- *If it timed out, did the real operation later fail instead?* — `lateResolution?.kind ===
  "failure"`, with `reason`.
- *Was the session itself ever the problem, and from when?* — the top-level
  `llmSessionStatus`, including the new `"degraded"`/`sinceRound` case.

Assembly (entry point, after the run, bounded await on any still-`"pending"` records) is
otherwise unchanged from v2 §12.

---

## 13. Security considerations

Unchanged from v2 §13 in substance. §13.3's denormalized-signal auditability requirement is
now visibly satisfied by the same `groundedSignals` field carried over unchanged; §13.4's
"no path for LLM output to gain authority" claim is, if anything, further strengthened by
§11's removal of the console notice — there is now exactly one channel (§11.1) through which
LLM output can ever reach anyone, and it is inherently retrospective.

---

## 14. Backward compatibility with Milestone 6A

### 14.1 Frozen list — still zero exceptions

Unchanged from v2 §14.1. §5.1's removal of `SupervisorFlag.source` means `types.ts`'s
additive surface no longer touches `SupervisorFlag` at all — strictly less additive surface
than v2, not more.

### 14.2 Standalone config loader

Unchanged from v2 §14.2 — `loadSupervisorConfig.ts` remains a fully independent file;
`isolationAttestedAt`'s stronger validation (§7.2) is additional logic *inside* that new
file, not a change to `loadConfig.ts`.

### 14.3 The default remains 6A, unconditionally

Unchanged from v2 §14.3.

---

## 15. Testing strategy

### 15.1 Unit tests (offline, pure functions and fakes, no Playwright)

| Test file | Covers |
|---|---|
| `tests/unit/supervisorPrompts.spec.ts`, `supervisorAssessmentParser.spec.ts`, `llmSupervisorAdapter.spec.ts` | Unchanged from v2 §15.1. |
| `tests/unit/augmentedSupervisor.spec.ts` | **The five scenarios required by this revision's review, each as an explicit test case:** (1) **LLM resolves normally** — before the timeout, `status` reaches `"resolved"` with `assessment`/`groundedSignals` populated, lock released. (2) **LLM timeout** — a fake adapter that never settles within `timeoutMs`; `status` reaches `"timed_out"`, `busy` remains `true` (verified by asserting a concurrently-triggered round is skipped) until the fake adapter's underlying promise is later manually resolved/rejected in the test, at which point the lock releases. (3) **LLM rejects before timeout** — a fake adapter whose promise rejects immediately; asserts `status` reaches `"unavailable"` with the rejection's reason, **and asserts no unhandled rejection is observed during the test run** (via a `process.on("unhandledRejection")` listener installed for the duration of the test, matching how the v2 bug would have been caught had this case existed then). (4) **LLM rejects after timeout** — a fake adapter that first exceeds `timeoutMs` (case 2's shape) and is then manually rejected; asserts `status` stays `"timed_out"` and `lateResolution` reaches `{ kind: "failure", reason }`, again with the unhandled-rejection listener asserting none occurred. (5) **Browser/session failure** — both the start-of-run `checkReady()` returning non-`"ready"` (asserts `llmSessionStatus.status === "not_ready"`, zero dispatch attempts made) and a mid-run failure whose recovery check (§9.4) also comes back non-ready (asserts `llmSessionStatus` transitions to `"degraded"` with the correct `sinceRound`, and that no further dispatches are attempted for the remainder of the run). Additionally: the skip policy (a trigger firing while `busy`), the trigger-evaluation guard (§9.2), and — unchanged from v2 — `assess()`'s return value being byte-identical to the deterministic leg's own result in every one of the above scenarios (§3.3's structural guarantee, now checked against a fuller scenario matrix). |
| `tests/unit/loadSupervisorConfig.spec.ts` | Unchanged from v2 §15.1, plus: `isolationAttestedAt` absent, malformed, in the future, or older than `ISOLATION_ATTESTATION_MAX_AGE_DAYS` all fail loudly (§7.2). |
| `tests/unit/supervisorIsolation.spec.ts` | Unchanged from v2 §15.1. |

### 15.2 Simulation tests

Unchanged from v2 §15.2.

### 15.3 Real browser tests

Unchanged from v2 §15.3.

### 15.4 Compatibility/regression checks

Unchanged from v2 §15.4.

---

## 16. Implementation phases

Unchanged in overall shape from v2 §16. 6B-2 ("Augmented Supervisor") now explicitly includes
§6's rejection-free promise construction and §9.4's recovery check as required, not optional,
parts of that phase's deliverable; 6B-4 ("Simulation tests") explicitly includes the five
scenarios named in §15.1.

---

## 17. Open questions (explicitly deferred, not decided here)

Unchanged from v2 §17 items 1–3, plus:

4. **(New)** Should a future revision reintroduce a live notice mechanism satisfying §11.3's
   Option B bar (timestamped, round-associated, recorded as its own audit entry), if real
   usage shows operators want live visibility badly enough to justify the added complexity?
   Deliberately not designed here — §11's removal is this revision's answer for now, not a
   permanent foreclosure.
5. **(New)** Is 30 days the right default for `ISOLATION_ATTESTATION_MAX_AGE_DAYS` (§7.2), or
   should it be operator-configurable? Left as a constant for this design; making it
   configurable would be a small, purely additive change if requested later.

---

## 18. File / module plan

**New files (none created by this design turn — design only):**

- `src/orchestration/supervisor/llmSupervisorAdapter.ts` (§4)
- `src/orchestration/supervisor/supervisorPrompts.ts`, `supervisorAssessmentParser.ts` (§8)
- `src/orchestration/supervisor/augmentedSupervisor.ts` (§3, §6, §9)
- `src/config/loadSupervisorConfig.ts` (§7.2, §14.2)
- `tests/unit/{supervisorPrompts,supervisorAssessmentParser,llmSupervisorAdapter,augmentedSupervisor,loadSupervisorConfig}.spec.ts`
- `scripts/smoke-llm-supervisor.ts` (§15.3)

**Additive-only edits:**

- `src/orchestration/supervisor/types.ts` — add `AugmentedSupervisor`,
  `LlmSupervisorAssessmentRecord` (with the symmetric `lateResolution` union), `LlmSessionStatus`
  (with the new `"degraded"` variant), extend `SupervisedReviewResult` with the two optional
  fields, bump `SUPERVISED_REVIEW_RESULT_SCHEMA_VERSION` to `2`. **`SupervisorFlag` itself is
  no longer touched at all** (§5.1 — `source` removed from the plan).
- `tests/unit/supervisorIsolation.spec.ts` — unchanged extension from v2.
- The Milestone 6A entry point — unchanged scope from v2 §18.

**Explicitly untouched — zero exceptions:** unchanged list from v2 §14.1/§18, including
`src/config/loadConfig.ts` and `config/config.json` as source files.
