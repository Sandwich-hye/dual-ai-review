# MILESTONE7A_DUAL_AI_CONVERSATION_ENGINE_DESIGN_v2.md — Dual AI Conversation Engine

Design-only document. **No production code is written by this document.** This revision
**replaces** `MILESTONE7A_DUAL_AI_CONVERSATION_ENGINE_DESIGN.md` after reassessing whether a
"thin facade" is actually sufficient — it is not, for a concrete, previously-unstated reason
found while re-checking v1 against the real `runAuditedReviewLoop.ts`. Sections 0, 4, 5 are
unchanged from v1; §1–§3 and §6 are revised; a new §3.5 (migration path) is added.

---

## Revision history

**v2 (this revision):**

1. **v1's `onStateChange` design was not actually buildable, and this revision explains why
   and fixes it.** `runAuditedReviewLoop` (frozen) is a single monolithic `async` function
   with no per-round hook — it loops internally and returns only the final
   `AuditedReviewResult` once the whole run ends. A pure "call it once, read the result"
   facade has no way to observe intermediate rounds at all, so v1's stated goal of firing
   `onStateChange` after every round was not achievable by the design v1 actually described.
   §1 below answers "thin facade or lifecycle controller?" precisely: neither — the correct
   shape is a **composition root with an observation decorator**, reusing the exact same
   `HumanGate`-wrapping technique Milestone 6A already established and proved, rather than
   inventing a new hook or touching the frozen loop.
2. **`JevConvergenceSignal`'s capture mechanism is now specified precisely** (§2), reusing
   `createSupervisedHumanGate`'s existing `renderAssessment` customization point — an
   already-sanctioned extension seam, not a new interception mechanism.
3. **A concrete migration path from the existing smoke scripts to one production entry point
   is added** (§3.5), where v1 only gestured at this as a risk-mitigation note.
4. **Two correctness requirements are made explicit** that v1's sketch left implicit and
   which a careless implementation would get wrong: `onStateChange` must be failure-isolated
   exactly like 6A's own two-boundary discipline (§2.3), and the facade must read
   `getAccumulatedAssessments()`/`getAccumulatedLlmAssessments()` off the *inner* supervised
   gate object, not off the further-wrapped plain `HumanGate` the loop actually receives
   (§2.4) — getting this backwards would silently ship an empty audit trail.

---

## 0. What this milestone actually is

Unchanged from v1 §0. Every piece this milestone needs already exists and already works
together; this milestone gives it one name, one documented entry point, and a state
projection for live rendering — it does not reimplement any control flow. The clarification
that "JEV-controlled convergence" means JEV's signal becomes integral to how convergence is
*displayed and judged*, never a new decision authority, stands unchanged.

---

## 1. Should `runDualAiConversation` be a thin facade or a lifecycle controller?

**Neither.** Both framings imply a false choice. A pure thin facade (call `runAuditedReviewLoop`
once, await the final result) cannot deliver per-round state, for the concrete reason above. A
lifecycle controller — something that owns round-by-round control flow itself — would mean
reimplementing logic that already lives, correctly and frozen, inside `runAuditedReviewLoop`,
which directly violates this milestone's own constraint to keep existing orchestration
boundaries unchanged.

**The correct shape: a composition root that installs one additional, purely observational
`HumanGate` decorator around the existing 6A/6B-supervised gate**, before handing the result to
the frozen loop's own `humanGate` input parameter. This is not a new mechanism — it is the
exact same technique `MILESTONE6_JEV_DESIGN_v3.md` used to add JEV itself: `HumanGate` is this
project's established, sanctioned dependency-injection seam for exactly this kind of
cross-cutting, per-round concern, precisely because `presentAndAwaitDecision` is the *only*
point the frozen loop calls out once per round.

```ts
// design sketch — src/orchestration/conversationEngine.ts (new)
function createProgressObservingHumanGate(
  inner: HumanGate,                              // the 6A/6B-supervised gate — see §2.4 for
                                                    // why the CALLER must keep its own
                                                    // separate reference to `inner`, not just
                                                    // to this wrapper
  originalTask: string,
  hardMaxRounds: number,
  latestJevSignal: { current?: JevConvergenceSignal },   // populated via §2's renderAssessment
                                                            // hook, read here only
  onStateChange: (state: ConversationState) => void,
): HumanGate {
  return {
    async presentAndAwaitDecision(presentation: HumanGatePresentation): Promise<HumanGateRawResponse> {
      // Observe, never alter — the same discipline supervisedHumanGate.ts itself follows.
      safeNotify(deriveConversationState(presentation, "awaiting_human", originalTask, hardMaxRounds, latestJevSignal.current), onStateChange);
      const response = await inner.presentAndAwaitDecision(presentation);   // unmodified
                                                                               // delegation —
                                                                               // this call is
                                                                               // never wrapped
                                                                               // in a try/catch
                                                                               // of this
                                                                               // decorator's
                                                                               // own, exactly
                                                                               // mirroring
                                                                               // supervisedHumanGate.ts's
                                                                               // own §9.3 rule
      safeNotify(deriveConversationState(presentation, response, originalTask, hardMaxRounds, latestJevSignal.current), onStateChange);
      return response;
    },
  };
}

function safeNotify(state: ConversationState, onStateChange: (state: ConversationState) => void): void {
  try { onStateChange(state); }
  catch { /* a caller-supplied rendering callback must never be able to break the review loop */ }
}
```

This is the entirety of the "controller-like" surface this milestone adds: one decorator, no
state beyond what it needs to build a `ConversationState` snapshot from data already present
on `presentation`/`response`, and zero decisions of its own. `runDualAiConversation` itself
remains a composition root — it constructs this decorator, the 6A/6B supervisor stack, and
calls the real `runAuditedReviewLoop` exactly once, exactly as v1 described.

---

## 2. `JevConvergenceSignal` schema, and how it stays advisory-only under the real wiring

The schema itself is unchanged from v1 §2.2 — a pure, deterministic relabeling of
`SupervisorAssessment`/`SupervisorUnavailable` (`riskLevel: "none" | "advisory" | "elevated"`,
derived only from fields those types already carry). What v2 adds is the precise, buildable
capture mechanism, since v1 left it implicit.

### 2.1 Capture via the existing `renderAssessment` extension point

`createSupervisedHumanGate` (frozen, 6A) already exposes exactly the seam needed:
`SupervisedHumanGateOptions.renderAssessment?: (assessment, presentation) => void | Promise<void>`.
The facade supplies its own implementation of this option instead of the default:

```ts
// design sketch — src/orchestration/conversationEngine.ts (new)
function createStateCapturingRenderer(
  latestJevSignal: { current?: JevConvergenceSignal },
): SupervisedHumanGateOptions["renderAssessment"] {
  return (assessment, presentation) => {
    latestJevSignal.current = toJevConvergenceSignal(assessment);   // side effect: capture
    printSupervisorBanner(assessment);                               // SAME visible behavior
                                                                        // as 6A's own default
                                                                        // renderer — capturing
                                                                        // a copy must never
                                                                        // change what a user
                                                                        // already sees
  };
}
```

### 2.2 Why this preserves advisory-only authority, stated precisely against the real wiring

- The assessment itself is still computed by, and only by, `supervisor.assess()` — the
  deterministic (6A) or augmented (6B) `Supervisor` implementation, entirely untouched.
- `renderAssessment` is called by `supervisedHumanGate.ts` **after** `assess()` and **before**
  delegating to the inner gate (the as-built 6A order established across this project's prior
  review rounds) — the facade's renderer runs inside that exact same slot, observes the same
  value everyone else observes, and cannot see or influence `presentation`/`rawResponse`.
- Nothing computed inside `createStateCapturingRenderer` ever flows back into
  `supervisedHumanGate.ts`'s own state, the Decision Agent, or the Claim Ledger — `latestJevSignal`
  is read only by `createProgressObservingHumanGate` (§1) to build a rendering snapshot.
- 6A's own two-boundary failure isolation (`supervisor.assess()` and rendering, both
  independently caught, neither able to affect the delegated gate call) is completely
  unaffected — the facade's renderer runs *inside* the existing rendering boundary, so a bug
  in `createStateCapturingRenderer` degrades exactly the way any other rendering failure
  already does (a recorded `renderingFailure`, never a broken round).

### 2.3 `onStateChange` failure isolation — an explicit new requirement

Unlike `renderAssessment` (already failure-isolated by the frozen decorator that calls it),
`onStateChange` is invoked by the **new** decorator in §1, which this milestone owns and must
therefore isolate itself. `safeNotify` (§1's sketch) wraps every call — a broken CLI rendering
callback must never be able to throw into `presentAndAwaitDecision` and break the review loop
or swallow the human's actual decision. This directly mirrors 6A's own boundary-2 rule
(`MILESTONE6_JEV_DESIGN_v2.md` §9.2) applied to the one new failure surface this milestone
introduces.

### 2.4 A correctness requirement the composition root must get right

`createSupervisedHumanGate(...)` returns a `SupervisedHumanGate` — a `HumanGate` **plus**
`getAccumulatedAssessments()` (and, for 6B, `AugmentedSupervisor` similarly exposes
`getAccumulatedLlmAssessments()`). `createProgressObservingHumanGate` (§1) wraps that value
but returns a *plain* `HumanGate` to satisfy `runAuditedReviewLoop`'s own input type — the
extra accessor methods are not part of that returned shape. **`runDualAiConversation` must
keep its own separate reference to the pre-wrap `SupervisedHumanGate` instance and read
`getAccumulatedAssessments()`/`getAccumulatedLlmAssessments()` off *that* reference after the
loop returns — never off the further-wrapped object actually passed as `humanGate` to
`runAuditedReviewLoop`.** Getting this backwards compiles fine (both are structurally valid
`HumanGate`s at the call site) but silently produces an empty `supervisorAssessments` array in
the final result — exactly the class of bug this project's review discipline exists to catch
before it ships. §6's acceptance criteria name a direct test for this.

---

## 3. Execution sequence

Unchanged from v1 §3 in substance — the round-by-round flow, the responsibilities table, and
the human intervention points are all still accurate. One addition: step 4 of the per-round
sequence (JEV assessment) now explicitly names *how* its result reaches `ConversationState` —
via §2.1's `renderAssessment` override, not an unspecified mechanism.

### 3.5 Migration path from the existing smoke scripts to one production entry point (new)

1. **Build `runDualAiConversation` and prove parity first.** A unit test constructs it with
   fake adapters and a fake human gate and asserts its output is byte-identical to what
   `scripts/smoke-supervised-review.ts`'s/`smoke-augmented-review.ts`'s existing hand-wired
   composition produces given the same inputs. This is the literal proof the facade adds
   nothing and changes nothing — not just an assertion in prose.
2. **Refactor the smoke scripts to call the facade internally, rather than deleting or
   orphaning them.** Once `runDualAiConversation` exists, `smoke-supervised-review.ts`/
   `smoke-augmented-review.ts` become thinner: real browser tab setup, plus one call to the
   facade, plus their existing result assertions. This keeps them as genuine real-browser
   regression fixtures for 6A/6B — now indirectly exercising the facade itself too — rather
   than becoming dead, unmaintained alternative examples.
3. **Wire the CLI (Milestone 7.1) to call the facade** for the browser provider, as v1's
   Phase 7A.2 already planned.
4. **Update documentation only, once 1–3 land:** the README describes
   `runDualAiConversation`/the CLI as *the* way to run a review; the smoke scripts are
   explicitly labeled as real-browser regression tests for the supervisor layer, not as
   alternative usage examples — resolving Milestone 7's own "five entry points to compare"
   finding without deleting any existing test fixture.

---

## 4. Ensuring existing invariants remain unchanged

- **Claim Ledger, Decision Agent:** untouched in every respect — no new code path is
  introduced anywhere near either; this remains as true under v2's decorator-based design as
  it was under v1's plain-facade sketch, since neither approach ever touches
  `src/orchestration/claims/`.
- **Human Gate authority:** strictly preserved and, if anything, more precisely demonstrated
  than in v1 — §1's decorator explicitly *observes, never alters* `presentation`/`response`,
  matching `supervisedHumanGate.ts`'s own stated discipline verbatim, and the frozen gate call
  itself (`inner.presentAndAwaitDecision`) is never wrapped in this milestone's own
  try/catch, exactly mirroring 6A's own §9.3 rule that a real gate's own failures must never
  be absorbed by a supervising layer.
- **Audit completeness:** `SupervisedReviewResult`/`AugmentedSupervisedReviewResult` assembly
  is unchanged in shape; §2.4 names the one concrete implementation detail
  (which object reference to read the accumulated-assessments accessors off) that must be
  gotten right for that assembly to actually contain the JEV audit trail rather than silently
  shipping an empty one.

---

## 5. Frozen list

Unchanged from v1 §5 — nothing under `src/orchestration/runAuditedReviewLoop.ts`,
`humanGate.ts`, `src/orchestration/claims/`, `src/orchestration/supervisor/` (including the 6B
`llm/` module), `src/sites/`, or `src/config/loadConfig.ts` changes. This revision adds no new
files beyond what v1 already named (`conversationEngine.ts`, `conversationState.ts`); it
specifies their internal wiring more precisely.

---

## 6. Minimal implementation plan

**Phase 7A.1 — Composition root + observation decorator + state projection:**
- New: `src/orchestration/conversationEngine.ts` — `runDualAiConversation` (§1's composition
  root), `createProgressObservingHumanGate` (§1), `createStateCapturingRenderer` (§2.1).
- New: `src/orchestration/conversationState.ts` — `ConversationState`, `JevConvergenceSignal`,
  `deriveConversationState`, `toJevConvergenceSignal` (types unchanged from v1 §2.1–§2.2).
- **Required tests, directly targeting this revision's two named correctness requirements:**
  (a) a parity test proving `runDualAiConversation`'s output is byte-identical to hand-wired
  composition given the same fake inputs (§3.5, step 1); (b) a test asserting
  `result.supervisorAssessments.length` matches the real round count even with the
  progress-observing decorator layered on top, directly catching the §2.4 mistake if it's
  ever made; (c) a test with a throwing `onStateChange` callback asserting the round still
  completes and the human's decision is still correctly returned (§2.3).

**Phase 7A.2 — Smoke-script migration (§3.5, steps 2–3):**
- Refactor both existing smoke scripts to call the facade internally.
- Wire `src/cli/index.ts` to call `runDualAiConversation` for the browser provider, JEV
  enabled by default.

**Phase 7A.3 — Live progress polish (unchanged from v1, optional, only after 7A.1/7A.2 land):**
- Stream `ConversationState` to the terminal via `onStateChange` as each round completes.
