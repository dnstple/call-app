# Stage 3F-A — messaging notifications and in-conversation support: audit

Branch `stage-3f-messaging-notifications-support`, base tag
`stage-3e-companion-payout-execution-validated` (= `ab3bbfa`, migrations
0001–0086 applied). Additive only; no applied migration edited; no payment /
booking / earning / transfer invariant touched.

## 1. Authoritative stage definition

`docs/project-scope.md` §"Stage 3F — Messaging, notifications and
in-conversation support" (roadmap order item 4). Two parts are implementable
now; part C is explicitly deferred:

- **3F-A Message notifications** — in-app notification for new messages;
  unread badge in navigation; notification-centre entry; deep link to the
  conversation; real-time where available; **no notification to the sender**;
  deduplication; read/unread state; Coordinator notifications **only where they
  hold message permission**; mobile bottom-nav unread badge. Future channels
  (email/SMS/preferences/quiet-hours/digest) are *designed into the model now,
  delivered later*.
- **3F-B Report an issue from the conversation** — a visible "Report an issue"
  action on the conversation header/overflow, available before/during/after a
  booked call; category taxonomy (messages/behaviour, scheduled call,
  attendance, payment, safety, technical, other); optional link to a booking or
  a specific message; concise description; reuse the existing support queue +
  audit trail; notify the reporter; RLS prevents unrelated users reporting into
  private conversations; **never** auto-refund/cancel/move money; apply the
  existing financial hold only when validly booking-linked and policy requires.
- **3F-C Help bot** — backlog, **not implemented now**.

## 2. Existing infrastructure (reused, not rebuilt)

- **Notifications model** (0023): `public.notifications` (user_id → accounts,
  `type`, `title`, `body`, `conversation_id`, `related_booking_id`, `plan_id`,
  `dedupe_key`, `read`, `read_at`); `mark_notification_read`,
  `mark_all_notifications_read`; RLS "own rows only"; the notifications page +
  bell badge (2F2C). `app_private.notify_conversation_participants` already
  computes the correct recipient set — companion owner, member owner, and
  member coordinators with `can_message` and non-withdrawn consent — and
  **excludes the actor** (`account_id is distinct from auth.uid()`), deduping
  by `(user_id, dedupe_key)`.
- **Messaging** (0019/0020/0027): `send_message` (definer, rate-limited,
  `can_access_conversation`-gated) and `send_message_request` (pre-booking).
  Neither currently emits a message notification — the 3F-A gap.
- **Conversations unread** (0019): `conversation_read_state` +
  `mark_conversation_read`; the Conversations list already shows per-thread
  unread. Nav bell badge exists (0023 UI).
- **Issue/support** (0034/0038): `conversation_issues` (booking-scoped,
  `booking_id NOT NULL`, role-specific category checks),
  `report_conversation_issue(p_booking,p_category,p_description)` which sets a
  `pending_completion` earning to `held_for_issue` (never moves money); the
  internal issue queue + audit (0038); support authorisation `is_support_admin`.

## 3. Gap analysis and additive design

| # | Gap | Substage / migration |
|---|-----|----------------------|
| A1 | `send_message`/`send_message_request` emit no notification | 0087: `app_private.notify_new_message` (coalesced, one unread per conversation per recipient, refreshed on each new message, cleared on read); redefine both senders to call it |
| A2 | Message notifications need a recognisable type + deep link + mobile badge in the UI | frontend + repo |
| B1 | No conversation-scoped concern report; `conversation_issues` is booking-only | 0088: `report_conversation_concern` + `conversation_concerns` (conversation-scoped, booking/message optional, broad taxonomy) feeding the support queue; booking-linked+policy path delegates to the EXISTING booking hold — single authority, no new money path |
| B2 | No "Report an issue" action in the conversation UI | frontend + repo |
| C | docs, runbook, production blockers, 3D/3E verifier reruns, tag | closeout |

## 4. Invariants preserved

Message notifications are additive inserts into an existing RLS-scoped table;
they never touch payments/bookings/earnings/transfers. The conversation
concern report never moves money — a booking-linked concern reuses the
existing `report_conversation_issue` hold (which only sets a
`pending_completion` earning to `held_for_issue`); pure conversation/safety
concerns create no financial effect at all. All new RPCs are definer +
`can_access_conversation`/`is_support_admin`-gated; no client may write
notifications, issues or concerns directly. Stage 3D and Stage 3E verifiers
are rerun at closeout to confirm zero payment/earning/transfer impact.

## 5. Deferred-but-designed (future channels)

The notification row already carries `type`, per-recipient rows and
`dedupe_key`; email/SMS/preferences/quiet-hours/digest can later read this
model without schema change. No delivery-channel code is added now.
