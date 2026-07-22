# One-booking repair assessment — ba4f943c-3e8d-4d4c-900d-fa551ccc5387

**Do not auto-repair.** The current rows are internally inconsistent, so the
outcome must not be inferred from them. This is a decision brief; no mutation was
executed.

## What the rows say (inconsistent)
- Booking `status = requested` (never accepted by the Companion).
- Payment order `947a359a…` `succeeded`, £10.00 captured (PI `pi_3Tvh2ED8sYiWjL8N1iPlYHaa`).
- `conversation_attendance 63a1ab7a…`: `took_place`, `source=companion`, `finalised=true`, submitted by the Companion owner (`d6e2eaed…`).
- `companion_earnings 71ecc62b…`: `payable`, `net 950`, `transfer_state=processing`.
- `companion_transfer_attempts 080b51bb…`: `processing`, `amount 950`, `attempt_count=1`, **`stripe_transfer_id=null`**, idem key `transfer-71ecc62b-cfd5-4e46-9fd1-ae00223dc2a2`.
- No completion_confirmation, no review, no rating, no issue.
- Notifications: Coordinator got `review_prompt`; Companion got `attendance_reminder` + `earning_payable`.

## Root cause (see 0067)
The booking was funded but **never accepted**. The pre-0067 attendance/earning/
automation paths gated only on `status not in ('cancelled','declined')` (which
includes `requested`) + a succeeded payment + elapsed `ends_at`, so the request
was swept into the completion workflow and produced a payable earning + a claimed
transfer. 0067 makes `status='confirmed'` a hard precondition everywhere.

## Did the conversation actually take place?
**Undetermined from these rows.** The Companion asserted `took_place`, but the
booking was never accepted, so there is no confirmed appointment it corresponds
to. Check the **call record** for a real audio session for this booking:
`select * from public.call_attendance_segments where booking_id = 'ba4f943c-…';`
and any `call_sessions`/`call_participants` for it. If there are no non-trivial
segments, the "took_place" assertion has no supporting evidence.

## Should the Coordinator confirm it?
**No — not in the current state.** A `requested` booking has nothing to confirm.
If the parties agree the conversation genuinely happened, the correct path is to
first move the booking to a legitimately **accepted** state (a support action /
re-issue), not to confirm completion on an unaccepted request.

## Is the earning legitimate?
**No, as it stands.** Under the adopted policy an earning may exist only for a
confirmed booking. This earning was created for a `requested` booking, so it is
premature. Options (support decision, not automated):
- **Void the earning** (`reversed`) and cancel the transfer intent if no provider
  transfer exists; leave payment captured pending the payment decision below; **or**
- If it is decided the service truly occurred and both parties accept it, first
  legitimise the booking (accepted), then let the normal completion flow produce
  the earning — do not retro-bless the current one.

## Was the transfer actually created at Stripe?
**Cannot be determined from the database** — `stripe_transfer_id` is null and the
attempt is `processing`. See the Stripe reconciliation section below. Do **not**
retry or finalise it until the provider state is known.

## Should the booking remain requested, be treated as confirmed, or be reversed?
Three coherent outcomes; pick one deliberately:
1. **Treat as never-happened** (most consistent with the data): keep the booking
   `requested` (or move to `cancelled`), reverse the earning, and refund or credit
   the payment (see below). This matches "it was never accepted".
2. **Legitimise** (only if both parties confirm it really happened): via a support
   action, record acceptance, then run the normal confirmed-completion path.
3. **Leave frozen** pending the parties' statements — but the stuck transfer must
   still be reconciled so no payout goes out on an unaccepted booking.

## Payment: captured, credit, or refund?
Since the booking was never accepted, the default fair outcome is **refund to the
Coordinator** (or convert to account credit) unless outcome (2) is chosen and both
parties confirm the service occurred, in which case the payment stays captured.
Do not decide from the current rows.

---

# Stripe transfer reconciliation (idempotency key `transfer-71ecc62b-cfd5-4e46-9fd1-ae00223dc2a2`)

**Result from this environment: provider state CANNOT be determined safely.**
- This sandbox has no Stripe API access and no secret key, and the task forbids
  executing a new transfer or retrying — so I did not call Stripe.
- The DB shows the attempt `processing` with **no** `stripe_transfer_id`, which in
  the 2G6B model means the claim committed but the Edge Function either never
  reached Stripe, or reached it and the webhook confirmation was never recorded.
  Either is possible; the null id alone does not prove absence.

**How to determine it safely (read-only), without exposing secrets or transferring:**
1. In Stripe **test mode** dashboard/API, list Transfers and filter by metadata /
   idempotency. LiveKit/2G6B transfers are created with the idempotency key
   `transfer-71ecc62b-cfd5-4e46-9fd1-ae00223dc2a2`; re-issuing a **create** with
   the *same* idempotency key returns the existing transfer if one was made
   (idempotent GET-like behaviour) — but do this only via a controlled,
   read-oriented check, never as a fresh transfer.
2. Cross-check destination connected account (`companion_earnings.companion_account_id`
   → `connected_accounts.stripe_account_id`), amount `950`, and created time near
   `payable_at 2026-07-22 13:25:37Z`.
3. Report exactly one of: **exists** (store the `tr_…` id via the normal webhook/
   finalise path), **does not exist** (mark the attempt terminal via the existing
   recovery RPC — do not create a new one), or **indeterminate** (leave frozen).

Because this booking should likely not pay out at all (unaccepted), the practical
recommendation is: **freeze this transfer** (do not finalise/retry) until the
booking outcome (above) is decided; if the outcome is "never happened", reverse
the earning and, if a provider transfer exists, reverse it via the existing
dispute/reversal path — otherwise mark the attempt terminal with no payout.
