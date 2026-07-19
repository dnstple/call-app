# 2G4 — completion, reviews, issues, earnings: architecture audit

Latest migration: **0033**. Next: `0034_completion_reviews_earnings.sql`.

## Reuse vs supersede

**Reused:** payment_orders snapshots (0030–0032) — the ONLY money source for earnings
(commission_rate_pct, commission_minor, subtotal, fee; never current prices/config);
credit ledger + `issue_account_credit` (idempotent, 12-month expiry) for issue resolutions;
notifications (0023 dedupe) + post_system_message; ratings tables (0007) and the
3-unique-reviewer public gate — new reviews write a compatible rating row per funded
occurrence (unique on booking_id prevents inflation); Connect readiness (0033);
booking timezone-safe starts/ends.
**Superseded (Supabase paid mode only):** two-sided completion_confirmations (0006) UI +
`confirm_completion` write path → replaced by Companion attendance + Coordinator review.
Historical rows stay readable; the old RPC gets revoked for stripe-funded bookings only
(guard inside, not dropped). Mock mode keeps the old flow untouched; provider guard
(`payment_orders.provider='stripe_test'` + status `succeeded`) is the single eligibility
test — mock/simulated/unfunded records can never create earnings.

## 0034 schema (all RLS'd, no client writes)

- `companion_earnings` — one immutable row per funded occurrence (unique booking_id):
  ids (booking, payment_order, companion account+profile, member, payer), GBP minor
  units, basis/commission/net snapshots copied from the order, `state` in
  (pending_completion, held_for_issue, payable, transfer_pending, transferred, reversed),
  payable_at (written once), idempotency key. Created at acceptance (booking confirmed)
  via trigger from the 0031 order.
- `conversation_attendance` — Companion-submitted: outcome (took_place, member_no_show,
  technical, other) + required explanation for non-yes; system-derived rows flagged
  `source='system'` distinctly.
- `call_attendance_segments` — LiveKit-trusted join/leave per identity (companion-/
  member-/guest_member-), reconnect-safe accumulation, unique (booking, identity,
  joined_at) for replay-safety. Fed by a new `livekit-webhook` Edge Function
  (participant_joined/participant_left only; signature via livekit-server-sdk
  WebhookReceiver; room `booking-{id}` parsed server-side; nothing else stored).
- `conversation_issues` — reporter role-checked categories, required description,
  priority (conduct=high), lifecycle open→reviewing→resolved, `resolution` audit fields
  (actor, note, companion_amount_minor, credit_amount_minor, resolved_at) with
  sum ≤ source checks; complaint text never leaves reporter+support RLS.
- `support_admins` — minimal DB-backed role (service-role managed) gating
  `/internal/issues` + `resolve_conversation_issue`.

## RPCs / functions

- `submit_companion_attendance` (owner-only, post-end enforced server-side, idempotent);
- `submit_conversation_review` (coordinator w/ live member access; stars null|1–5;
  24h edit window; one per occurrence; optional single thread message via existing
  send path under Coordinator identity; approval flag drives release);
- `report_conversation_issue` (role-scoped categories, sets earning held_for_issue,
  neutral counterpart notification, high-priority conduct marker);
- `release_eligible_earnings` (service-role cron; end+12h, attendance yes, no open
  issue; FOR UPDATE SKIP LOCKED, batch 100, payable_at once);
- `resolve_unconfirmed_attendance` (service-role cron; end+24h; both≥2min → system
  apparent-completion path; companion≥10min & member absent → payable member-no-show;
  unclear → manual-review issue; safety/open issues always win);
- `resolve_conversation_issue` (support-only; full pay / full credit incl. fee /
  partial with validated amounts / dismiss; exactly-once; immutable audit);
- 2-hour reminder inside release cron pass (dedupe key per booking).
- Test-time: fixtures inject `starts_at/ends_at` in the past (as 2G2 live tests do);
  no clock override exposed to clients.

## State machines

Earning: `pending_completion → payable` (approval|12h after companion-yes)
         `→ held_for_issue → payable|reversed(credited)|partial` (resolution)
Issue: `open → reviewing → resolved{pay_full|credit_full|partial|dismissed}`
Attendance: `none → companion_submitted | system_derived | unclear_review`

## Cron

Supabase Cron (pg_cron) every 15 min → `release_eligible_earnings()` +
`resolve_unconfirmed_attendance()`; dev fallback: manual `select` invocations
(documented in deploy steps). No transfers anywhere in 2G4.

## Delivery order

2G4A migration+RPCs → 2G4B attendance+livekit-webhook → 2G4C review UI (Home
attention "How did Mary's conversation with Daniel go?", detail review card,
Companion "Did the conversation take place?") → 2G4D release cron+notifications →
2G4E `/internal/issues`. App stays green after each.
