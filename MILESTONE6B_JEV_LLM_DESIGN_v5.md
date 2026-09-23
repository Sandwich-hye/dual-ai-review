# Milestone 6B — Optional LLM JEV Supervisor, design v5

Design only. No production code, tests, configuration, or Milestone 6A/5 source files are
changed by this revision. This document supersedes [v4](docs/archive/milestone6b/MILESTONE6B_JEV_LLM_DESIGN_v4.md).
Sections not replaced below retain v4's decisions, including the closed `SupervisorInput`,
the internal LLM adapter, the isolation attestation, prompt/grounding rules, and the
standalone configuration loader. Sections 2–6 below replace v4 §§6, 9.4, 12, the
corresponding testing and implementation instructions, and §18's audit-type placement.

## 1. Non-negotiable boundaries

- `AugmentedSupervisor.assess(input)` returns the exact result of the deterministic
  supervisor. LLM dispatch occurs only after that result is fixed. LLM output never changes
  flags presented to the Human Gate, legal outcomes, or the base audited review result.
- The LLM is an audit-only side channel. Its records are surfaced only in the final
  versioned 6B result; there is no live console notice or alternate supervisor path.
- The LLM uses one dedicated, run-scoped page. At most one 6B browser operation or recovery
  probe may touch that page at a time. A logical timeout does not cancel a browser operation.
- Milestone 5 and frozen Milestone 6A source files remain untouched. The existing
  `supervisedHumanGate.ts`, `supervisor/types.ts`, deterministic supervisor, Human Gate,
  audited loop, browser/site adapters, and Milestone 5 files are not changed. All new 6B
  audit/result types live in a new 6B-only module and import 6A types without editing them.
  Opting out continues to produce the original 6A result and schema version; an opted-in
  6B result has its own versioned type. This replaces v4's additive `types.ts` edit plan.

## 2. Blocking fix 1 — an ownership-scoped page lease

### 2.1 Lease state and lifecycle

Replace the global `busy: boolean`/`busyRound` release protocol with a run-local
`activeLease: Lease | undefined`. A lease contains an opaque identity token, the unique
audit-record ID, its round, and a `completion` promise. The token is an object or `Symbol`,
never just a round number, because round numbers are audit data rather than lock ownership.
Each dispatch receives a fresh token. Audit IDs use a run-local monotonic sequence (for
example `llm-1`, `llm-2`), so repeated assessments or skipped attempts cannot collide.
Tokens are internal and never serialized.

Acquisition is synchronous: after the session/finalization guards, inspect `activeLease`;
if occupied, record a skip. Otherwise create the token and record, install `activeLease`,
then start the LLM operation. A later trigger can acquire only after the current lease's
completion has reached its release point. No queued browser work is introduced.

The only release operation is `releaseIfOwner(token)`: it clears `activeLease` **only if**
`activeLease?.token === token`. The runner calls it once, from its `finally`, after real
operation settlement, timeout/late-result bookkeeping, any recovery probe, and session-state
updates. A stale `finally`, callback, or error handler holding an older token is a no-op;
it cannot clear a successor's lease. The v4 outer `.catch` must never write lock state.

| Lease phase | Page may be touched by another 6B dispatch? | Release condition |
|---|---|---|
| Call in progress | No | Real call settles; then record/recovery completes |
| Logical timeout, real call active | No | Real call later settles; then record/recovery completes |
| Recovery probe active | No | Probe settles and session state is updated |
| Finalization deadline exceeded, call/probe active | No; run is sealed | The original work eventually settles; otherwise the lease remains held until process teardown |
| Complete | Yes, if run remains open and session is ready | Owner token is released once |

The runner owns a non-rejecting `completion` promise covering the entire lease, not merely
the adapter call. It catches internal recording errors **inside** the lease, records an
`unavailable` result, and performs or conservatively fails recovery before release. If an
internal error occurs while an already-started browser call is still active, the runner
continues to await its safe settlement before release. A synchronous adapter throw before
returning a promise is normalized to a
failure; it must not create an untracked browser operation. A final defensive observer may
record an unexpected error, but it cannot release a token or overwrite a sealed audit.

### 2.2 Required lock tests

Use deferred promises to force these orderings in `augmentedSupervisor.spec.ts`:

1. A second trigger while the first real call is pending is skipped and recorded.
2. A logical timeout leaves the lease owned until the real call settles; a late failure
   keeps it owned through the recovery probe and session update.
3. Hold `checkReady`/the recovery probe pending. A trigger during that interval is skipped.
4. Force an internal recording error. Queue the next trigger between the former owner's
   `finally` and a stale continuation; assert the stale token cannot clear the new lease.
   Directly exercise `releaseIfOwner(oldToken)` after a new token is installed.
5. A synchronous adapter throw and a rejected adapter promise yield one failure record,
   no unhandled rejection, and no stuck or double-released lease.
6. After finalization seals the run, no trigger can acquire a lease even if a late old
   continuation eventually releases its own token.

## 3. Promise outcomes and timeout cleanup

The v4 intent remains: a fulfilled `SupervisorUnavailable` and a rejected adapter promise
enter the same failure branch. Both immediate and late failures set the appropriate
`unavailable` or `timed_out`/`lateResolution.kind: "failure"` audit fields and require the
same recovery policy. A valid `SupervisorAssessment` is the only success branch.

`toSafeSupervisorOutcome` must treat the fulfilled value as `unknown` at runtime. It first
checks that the value is a non-null object, then validates the complete required shape and
the expected round. A valid `{ unavailable: true, round, reason }` becomes a failure using
its reason. A valid assessment becomes success. `null`, primitives, missing fields, wrong
rounds, invalid flags, or other malformed objects become a stable, content-independent
`invalid supervisor outcome` failure. The raw malformed value is not interpolated into an
audit reason. Validation and error-description code must itself be guarded so the safe
settlement promise always fulfills. Invoke the adapter inside that normalization boundary
so synchronous throws are also captured. TypeScript's return type alone is not a runtime
validation boundary.

The per-call timeout timer is canceled and its handle cleared as soon as the real call
settles before the deadline. If the timer fires first, mark the logical timeout, clear the
timer handle, and continue awaiting the same real-call promise under the lease. Canceling
the timer never cancels the browser call. Cleanup also runs for synchronous throws,
malformed outcomes, internal errors, and a sealed finalization snapshot. The separate
finalization timer is cleared when lease completion wins. A settled fast call must leave no
timer keeping the Node process alive until `timeoutMs`.

## 4. Recovery and degraded sessions

Recovery remains within the owning lease. `SiteAdapter.checkReady(page) === "ready"` is a
necessary first check, not proof that a page is reusable: the current site adapters can
report `ready` from a visible textbox while a generation is active or a composer contains
partial text. A new 6B-only, read-only recovery probe must also establish all of the
following for the selected site: the page is open, no login/security state is visible, no
generation is active, the composer is empty, and the relevant assistant turn is stable and
unambiguous over a bounded observation window. The probe must use 6B code or existing
read-only adapter capabilities; it must not edit frozen 6A/site modules or submit a prompt.

If any check fails, throws, times out, or cannot establish a clean idle state, mark the
session `degraded` and forbid every later dispatch in this run. A site-specific status
alone never upgrades a degraded session. If a probe's own browser operation remains
unsettled, the lease stays owned; the finalization deadline handles the unresolved state
as §5 describes. The first degradation stores a stable `sinceRound` and
`triggeringRecordId`; later skips and late continuations cannot overwrite them. A recovered
`ready` session may dispatch again only after the probe has finished and its owner releases
the lease. The audit reason distinguishes actual failed checks from conservative
quarantine because recovery could not be verified.

## 5. Blocking fix 2 — finalization is a barrier over work, not record status

### 5.1 One finalization API

After `runAuditedReviewLoop()` returns, the 6B entry point calls
`await augmentedSupervisor.finalizeAudit(finalizationTimeoutMs)` **before** constructing,
serializing, logging, or returning the 6B result. This replaces v4's bounded wait for
records whose `status === "pending"` followed by separate accessor reads. `finalizeAudit`
atomically changes the run from `open` to `finalizing`; new LLM triggers are then skipped
or rejected without dispatch. It waits on the active lease's `completion` promise, whose
definition includes:

1. settlement of the actual adapter/browser operation, even if the per-call timeout fired;
2. classification and recording of normal, unavailable, rejected, malformed, or late result;
3. completion of any required recovery probe;
4. the resulting `ready`/`degraded` session transition and ownership-scoped release.

Waiting only for `pending` records is prohibited. A record may already say `timed_out`
while the call is active, or `unavailable` while recovery is active. The barrier observes
the lease completion, not those record labels. If no lease is active, finalization can
snapshot immediately. A completed normal path returns `{ status: "complete" }` only after
all four steps above. The result's records and session status are copied together into an
immutable, JSON-serializable snapshot; later internal changes cannot alter it. Repeated
`finalizeAudit` calls return the same sealed snapshot.

### 5.2 Bounded deadline and honest incomplete result

An arbitrary browser promise cannot be guaranteed to settle within a finite bound. The
entry point therefore waits until lease completion **or** one run-level finalization
deadline, measured with a monotonic clock. The standalone 6B config uses a 60-second
default and a 300-second hard maximum; any explicit value must be a positive finite
integer within that maximum. The deadline is independent of the per-call timeout, which
does not count as lease completion. There is exactly one finalization deadline per run;
it is not reset by late activity or recovery.

If the deadline wins, finalization synchronously seals an **incomplete** snapshot before
returning. It records `finalizedAt`, the active record ID, and whether the unresolved phase
was `operation` or `recovery`. The active record keeps its truthful call status and gains
`finalizationIncomplete: { phase, at }`. Thus `pending` or `timed_out` plus an operation
marker means its real outcome was unknown at serialization; `unavailable` plus a recovery
marker means the failure was known but page health was not. An absent `lateResolution` is
never presented as a late success or failure. This is an explicit limit of the audit,
not a claim that work finished.

Before copying the snapshot, the run enters a permanently sealed/quarantined state. If
health is not yet established, its 6B `llmSessionStatus` becomes operationally `degraded`
with detail `unverified at finalization` and a pointer to the active record. Here
`degraded` means the page is ineligible for reuse; it does not claim proof of login failure.
If degradation was already recorded, preserve its first `sinceRound` and
`triggeringRecordId`. The top-level finalization field explains whether health was known
or was conservatively quarantined. No further dispatch or audit mutation may change the
sealed result. The underlying safe promise remains observed; its owner keeps the lease
until settlement and any still-running page probe finishes. The dedicated page can then be
closed by bounded teardown, but finalization never pretends that closing was a successful
LLM assessment or a proven recovery. Teardown failure cannot trigger another dispatch.

This gives a finite result-assembly wait without falsely promising that an unresponsive
external operation has settled. An incomplete result is valid audit evidence of exactly
what was known at the cutoff. Consumers must treat it as incomplete, not as a completed
LLM verdict. The deterministic base result and human outcome remain available regardless.

### 5.3 Snapshot contract and reconstruction

The opted-in 6B result adds an audit-finalization field alongside v4's separate LLM
records and session status. These new types belong to a new 6B-only module, not the frozen
6A `supervisor/types.ts`. The following is the intended shape, not production TypeScript:

```ts
type LlmAuditFinalization =
  | { status: "complete"; finalizedAt: string }
  | { status: "incomplete"; finalizedAt: string; activeRecordId: string;
      phase: "operation" | "recovery"; reason: "finalization_deadline_exceeded" };

interface LlmSupervisorAssessmentRecord {
  // v4 fields remain, including id, status, reason, and lateResolution.
  finalizationIncomplete?: { phase: "operation" | "recovery"; at: string };
}

interface AugmentedSupervisedReviewResult extends SupervisedReviewResult {
  schemaVersion: 2;
  llmSupervisorAssessments: LlmSupervisorAssessmentRecord[];
  llmSessionStatus: LlmSessionStatus;
  llmAuditFinalization: LlmAuditFinalization;
}
```

Deterministic-only mode continues to return the frozen 6A `SupervisedReviewResult` at schema
version 1, with no LLM fields. LLM mode returns `AugmentedSupervisedReviewResult` at version
2. `status: "complete"` forbids any `pending`
record or unresolved lease/recovery. `status: "incomplete"` requires exactly one active
record reference and matching `finalizationIncomplete` marker. The reference resolves by
unique record ID, including when the session was quarantined. A `degraded` status points
to the first failing or unverified record and is never overwritten. Final result assembly
uses the single sealed snapshot; it must not read records and session status separately.

### 5.4 Required finalization tests

- Final-round call still active when the base loop ends: finalization waits for its real
  settlement, late-result bookkeeping, and recovery before returning `complete`.
- Failure record already `unavailable` but recovery probe pending: finalization waits and
  serializes the resulting degradation, including the correct triggering record ID.
- `timed_out` record with real call still active: finalization does not treat it as done;
  a late success or failure inside the deadline is included before `complete`.
- Deadline during operation and deadline during recovery: each returns a bounded,
  `incomplete` immutable snapshot with the correct phase, active ID, record marker, and
  conservative session quarantine. Settle the deferred promise afterward and assert the
  serialized snapshot does not change and no unhandled rejection occurs.
- Race completion against the deadline in both orders. Exactly one sealed snapshot wins;
  finalization cannot report `complete` with an unresolved lease or `incomplete` without an
  active-record marker. A repeated call returns byte-identical data.
- Human decisions and the deterministic assessment remain byte-identical across all cases.

## 6. Implementation plan and acceptance gate

1. Keep v4's 6B-1 adapter, prompts, and parser scope. Extend the outcome helper during 6B-2
   with runtime validation, synchronous-throw normalization, and timer cleanup. Existing
   helper tests remain; add malformed `null`/primitive/object and early-settlement cleanup
   tests.
2. Implement the token-owned lease, non-rejecting completion promise, recovery probe, and
   finalization barrier together in the new 6B augmented-supervisor module. The lease's
   completion promise is the single source of truth for both lock release and final audit
   readiness. Add §2.2 and §5.4's deferred-promise tests before entry-point wiring.
3. Define the version-2 6B result and audit types in a new 6B-only module. Wire the
   standalone 6B config loader and finalization call at the 6B entry point. Construct the
   base audited result first; add only the sealed LLM audit snapshot afterward. Keep the
   frozen 6A schema/version and Human Gate/audited-loop flow unchanged.
4. Run the isolation, regression, simulation, and gated real-browser checks already planned
   by v4. The acceptance gate requires proof of deterministic result parity, no unhandled
   rejection, single-owner page access, both deadline branches, reconstructable final audit,
   and zero Milestone 5/6A frozen-file behavior changes.

This revision is ready to guide implementation, but the 6B runtime is not implemented by
this document. The current committed outcome helper and four focused tests prove only the
v4 fulfilled-unavailable/rejection/timeout classification path. They do not prove lease
ownership, recovery, finalization, or browser behavior.

## 7. Remaining risks

- An external browser operation may never settle. Bounded finalization then produces an
  explicitly incomplete audit and quarantines the dedicated page; it cannot invent the
  missing outcome. Process shutdown and page teardown need a separate bounded policy.
- A read-only recovery probe can establish observable idle state but cannot prove every
  hidden service-side condition. Ambiguous state must degrade the LLM session, preserving
  deterministic review progress.
- Account-level memory/history isolation still depends on v4's dated operator attestation
  and the gated real-browser leakage test. It is not mechanically guaranteed by a separate
  tab alone.
