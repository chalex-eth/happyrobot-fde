# Carrier OTP: local app, Twin and HappyRobot

## Current flow and policy

Start a voice call → confirm MC → authority check → agent creates the screen code → caller dictates six digits → backend verifies → search loads.

The backend derives the demo code from a random challenge and server secret; the browser displays it and recovers it after refresh. It never appears in agent tool results. Mock delivery is enabled only for development with `OTP_DEMO_MODE=true` and `OTP_DELIVERY_MODE=mock`. The code is delivered on screen, not by email or SMS. The legacy local manual-registration endpoint remains available for diagnostics and follows the same policy.

- Generation and verification share **one retry per call**. The first failure leaves one opportunity to succeed; the second failure ends verification. Successful generation does not reset failures.
- Pending codes have no expiry and are reused. No cooldown or rolling send limit applies.
- A correct code grants verification for the rest of the call. Carrier changes invalidate the challenge and verification while retaining spent failures. Only a new call resets the budget.
- The call retains its one-hour lifetime; negotiation offers retain their separate two-minute lifetime.
- Incomplete spoken digits are clarified before verification and do not consume a failure. Wrong six-digit codes, confirmed delivery failures and recorded verification/configuration service failures share the budget.
- Twin enforces the budget under a row lock. Private operation receipts reconcile lost mutation responses and deduplicate transport retries. Unresolved outcomes fail closed rather than issuing another mutation automatically.
- Failed/uncertain email delivery invalidates that code before allowing a retry. A webhook 2xx establishes acceptance, not actual receipt by the inbox.
- Authority, session binding, challenge matching and HMAC comparison remain required. There is no persistence fallback or caller-supplied approval.

## Twin setup and contracts

Fresh databases apply `twin-m3.sql`, `twin-m3.1.sql`, `twin-m3.2.sql`, `twin-m3.5.sql`, then `twin-m3.6.sql`. Existing workspaces apply only the new forward migration after checking the installed schema. Never replay the historical CREATE scripts.

`otp_failures` is call-wide and bounded at two. `poc_private.otp_receipts` stores safe results for backend-generated operation IDs; it does not expose code digits. Historical events and legacy columns remain for evidence. Active legacy calls retain spent failures; consumed or expired challenges are never resurrected.

Local session responses expose `otpFailuresRemaining` and `otpRetryAllowed`; MCP exposes `failures_remaining` and `retry_allowed`. OTP expiry/verified-until fields are removed. A first wrong answer returns `OTP_INVALID`, a delivery failure `OTP_DELIVERY_FAILED`, and a recorded service failure `OTP_SERVICE_FAILED`. The second failure returns `OTP_FAILED` and disallows retry. These internal codes are not spoken to the caller.

Local OTP requests may send `Idempotency-Key` for transport retries; reuse it only with the same operation. MCP derives operation identity from the authenticated run and JSON-RPC request ID, outside model arguments. Repeated model requests are new attempts. Expected digits and verifier digests never cross the agent boundary.

The cookie-authenticated `/api/local/calls` status response alone delivers `demoOtp` to the matching browser. Mock recipient markers and audit events describe simulated readiness, not email delivery.

## Historical email-provider setup (delivery still pending)

Draft workflow created: **Carrier OTP — Demo email**

[Open the workflow](https://platform.happyrobot.ai/fdealexandrechalard/workflows/uftarwoauwrl/editor/i69kgdmrm986)

Current draft: predefined webhook → Gmail Send email. The built-in HappyRobot Email action reports that email is disabled for this organization. The user attempted Gmail OAuth and Google blocked the app's sensitive-data access. There is no working sender credential. The exact Google policy reason has not been established from that message alone.

Built-in availability rechecked in the live workspace on 2026-09-05: the Email → Send email action still says, “Email is disabled for this organization. Please contact your account representative to enable email.” Searching the integrations catalog for email shows Gmail, Outlook, Postmark and Sendgrid, with zero connected. No self-service built-in Email enable control was available in the inspected UI. The temporary access-check node was removed using Undo, leaving the original draft intact.

1. Connect a Gmail credential through **Integrations → Gmail → Create**. For a personal Gmail sender, choose **User Mailbox**, name the credential, and complete Google's consent flow. The sender need not be the demo recipient.
2. Select that credential in the Gmail action. Set the recipient statically to `chalard.alex@gmail.com`; never accept a caller-provided override.
3. Use a fixed subject, `Your carrier verification code`, and a fixed body containing the webhook `code` variable selected through HappyRobot's variable picker. Explain that the code is valid for this call and that delivery is a demo. No text agent or AI-generated body is needed.
4. Keep **Enhanced Security** on for the webhook. Create or select an authorized HappyRobot API key, then put it in `.env.local` as `OTP_WEBHOOK_API_KEY`. Do not paste it into source files or `.env.example`.
5. Confirm sensitive run-data handling before publishing/testing real OTPs: the webhook input and Gmail node may otherwise retain the code in run history. No field-redaction mechanism has been verified yet. A short retention period alone does not prevent disclosure in logs.
6. Once configured, publish the intended workflow version, verify unauthorized triggers are rejected, then send one real demo code and validate it in the local app.

The draft is not published, and no demo email has been sent as of this checkpoint. Credential connection, template fields, retry configuration, run-data masking and live delivery remain to be verified. After the Gmail block, the user chose to use an existing SendGrid or Postmark sender. The specific provider and verified From address are still needed before replacing the Gmail action and opening the correct credential form. A Gmail service account requires a Workspace mailbox and administrator delegation; it does not replace OAuth for a personal Gmail sender.

Backend webhook contract (code shown here is illustrative, not an active challenge):

```json
{
  "to": "chalard.alex@gmail.com",
  "code": "000000",
  "call_id": "<call UUID>",
  "challenge_id": "<challenge UUID>",
  "mc_number": "133654",
  "demo": true
}
```

This payload is server-to-server only. The local API returns the challenge reference, state, remaining shared failure allowance and retry eligibility, never the code. The template must use the actual variable, not the illustrative literal.

## Local routes

- `/api/local/calls`: start or restore the bound call; an explicit new call invalidates the previous session.
- `/api/local/carriers`: verify authority; reset verification/load state but retain OTP failures.
- `/api/local/otp`: status, retained email send, manual mock registration, and six-digit verification against the current challenge.
- `/api/local/tms`: load search/detail gated by current authority and verification.

Loopback Origin/Host and development-only checks remain. The managed agent uses authenticated MCP with automatic provider-run binding, not the operator diagnostic endpoints.

## Validation

See `otp-simplification-validation.md` for the current rollout and verification evidence. Unit tests and the complete disposable PostgreSQL migration/transition suite cover the shared budget, all agreed paths, duplicate/concurrent attempts, and removal of the old time windows. Adversarial definitions require actual isolated session binding and private code delivery to the caller actor before successful paths can be claimed.
