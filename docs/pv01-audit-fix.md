# PV01 audit correction — 2026-09-05

## Change

Draft Version 6 (`01a071ef-5b39-7f72-bb75-229ad2cee595`, slug `csggqbo6zd0q`, name `PV01 technical-error closure`) was forked from live Version 5. Only the conversation prompt was changed. The local source is `scripts/happyrobot/workflow-spec.ts`; its text matches the saved draft after whitespace normalization. Version 6 has not been published.

The previous prompt said both to stop protected actions after a binding error and to finalize before ending. The revised prompt gives an explicit sequence: explain the incomplete step, make one best-effort `finalize_call` attempt with `technical_error`, wait for the result, request a new demo call, and thank the caller. It forbids further calls after denied finalization and prohibits claiming the outcome was saved without a successful response. `CALL_FINALIZED` permits no further tool calls.

## Observed validation

- Test: `PV01 - MC to successful OTP verification` (`01a071da-c592-7e87-877c-f27f62a4cb69`).
- Before: Version 5 run `d6a0a404-d185-407a-af5b-dd46bf96b729`, created 2026-09-05 14:10:54 UTC; 4 failed, 11 passed, 22 not applicable.
- After: Version 6 run `a9a7c49d-de02-4999-b151-70c94cb5ed04`, created 2026-09-05 14:19:37 UTC; completed with 0 failed, 15 passed, 22 not applicable.
- All 37 grading criteria were preserved by the fork; no criteria were weakened or disabled.
- The four previously failed checks now pass: finalize_call Tool Invocation, Finalization Before Closure, Authority Outcome Accuracy, Professional Thankful Close.
- The 11-message transcript shows the authority action rejected with `VOICE_BINDING_REQUIRED`, an explanation that the authority check could not complete, one closing tool attempt also rejected with that error, and a request for a new demo call followed by thanks. No successful saved finalization is claimed.

## Remaining integration blocker

PV01 is still **SETUP_BLOCKED** at authority checking. OTP creation and successful verification were not reached. Passing the behavioral audit proves only the observed error-handling branch in this single run. It does not establish successful OTP verification or persisted finalization. The simulator still needs its own bound app/Twin session and private delivery of the actual current OTP to the caller actor. The backend binding guard was not changed.
