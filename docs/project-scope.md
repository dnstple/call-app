# Project scope and roadmap

This document records the authoritative forward scope for the Call App after the
Stage 3C financial-operations work. It complements `docs/OPERATIONS_RUNBOOKS.md`
(operational procedures), `docs/payments-architecture.md` (payment design) and
`ARCHITECTURE.md` (system architecture).

Current position: Stage 3C2-C3 — controlled Stripe TEST-MODE Companion transfer
rollout (migrations 0001–0079 applied; environment `hosted_test`; all financial
controls disabled; provider transfer ceiling 0; `scoped-stripe-transfers`
deployed only through the controlled rollout runbook). Nothing below is
implemented during Stage 3C2-C3 unless it directly blocks the controlled Stripe
test transfer; the C3 fixture uses authorised backend test helpers, so nothing
below blocks it.

## Design direction

All product work below follows the established direction:

- minimalist and Preply-inspired;
- warm ivory and apricot visual system;
- clean typography and restrained borders;
- clear primary actions;
- simple mobile-first navigation;
- reduced clutter and repeated explanatory text.

---

## Stage 3D — Customer payment reliability (LAUNCH BLOCKER)

Production launch blockers concerning **customer payments** (not Companion
payout transfers).

Stage 3D-A audit (root causes, exactly-once matrix, target architecture and
the 3D-B/C/D plan): see `docs/stage-3d-payment-reliability-audit.md`.

Observed issues:

1. When bank authentication is required, the customer does not always see a
   clear banking-app, popup or browser authentication handoff.
2. Stripe may take the payment while the application remains stuck in a loading
   or pending state and never confirms the booking.

Required work: audit the PaymentIntent, return-URL and webhook lifecycle;
handle `requires_action` and Strong Customer Authentication correctly; clearly
redirect customers to their bank or authentication page; resume payment
confirmation after returning to the app; make Stripe webhooks authoritative;
add safe client polling/status refresh; recover when Stripe succeeds but local
booking finalisation fails; prevent duplicate charges, bookings, orders and
credit deductions; persist payment state so closing and reopening the app does
not lose progress; replace indefinite loading with explicit states — **Bank
authentication required · Payment processing · Payment received, confirming
your booking · Payment failed · Payment received, confirmation delayed**;
provide a safe "Check payment status" action; test webhook-first and
browser-first event ordering, abandoned authentication and delayed
confirmation.

Acceptance criteria: a successful payment always produces the correct booking
exactly once; customers are never encouraged to pay again when Stripe already
succeeded; authentication handoff works clearly on desktop and mobile; no
payment screen spins indefinitely.

**Must be completed before production activation.**

## Stage 3E — Three-person video calls

Replace the current audio-only, two-participant restriction with an optional
three-person video-call model. Maximum participants: **Member, Companion, and
the booking's authorised Coordinator**.

Participation behaviour: Coordinator participation is optional; the Coordinator
must have valid access to the Member and booking; everyone is visibly informed
when a Coordinator joins (no hidden participation); unrelated Coordinators
cannot enter; Member and Companion remain the two primary conversation
participants; Coordinator presence is never mistaken for Member attendance;
attendance, completion and payout evidence are updated accordingly; existing
tests that prohibit Coordinator entry are updated.

Video requirements: camera preview before joining; explicit camera consent;
camera on/off; microphone mute/unmute; audio-only fallback (audio-only calls
remain possible); up to three responsive participant tiles; mobile and desktop
layouts; camera/microphone permission recovery; connection-quality feedback;
device switching; reconnect behaviour; LiveKit token and room isolation;
updated support diagnostics.

**Product decision required:** whether Coordinator attendance must be approved
by the Member, requested when booking, or enabled through an explicit
booking-level setting.

Coordinator participation and video are implemented **together** because they
alter the same LiveKit room, token, attendance, privacy and participant model.

## Stage 3F — Messaging, notifications and in-conversation support

### A. Message notifications

Observed issue: new messages do not create sufficiently clear application
notifications.

Implement now: in-app notification for new messages; unread badge in
navigation; notification-centre entry; deep link directly to the conversation;
real-time update where available; no notification to the sender for their own
message; deduplication; read/unread state; Coordinator notifications only where
they hold message permission; mobile bottom-navigation unread badge.

Future delivery channels (designed into the notification model now, delivered
later): email notifications; SMS notifications; user notification preferences;
quiet hours; digest versus immediate delivery.

### B. Report an issue from the conversation

Observed issue: a user can report an issue after a call, but not conveniently
from the active conversation panel.

Add a visible **"Report an issue"** action to the conversation header or
overflow menu, available before, during and after a booked call. The flow lets
the user identify whether the issue concerns: messages or behaviour; a
scheduled call; attendance; payment; safety; technical problems; another
concern.

Requirements: link the case to the conversation and optionally to a booking or
specific message; allow a concise description; preserve the existing support
queue and audit trail; notify the reporter that the case was received; prevent
unrelated users from reporting against private conversations; **never**
automatically refund, cancel or move money; apply existing financial holds only
when the report is validly linked to a booking and the authoritative policy
requires it; give support the relevant safe context without exposing unrelated
private information.

### C. Future help bot (backlog)

An in-app help assistant: answer common product questions; explain booking and
payment statuses; guide users to support actions; suggest relevant help
articles; escalate to human support. **Not implemented now** — build only after
support workflows are stable, issue categories are established, a maintained
help-content source exists, and privacy boundaries are defined.

## Stage 3G — Mobile navigation and Coordinator information architecture

### A. Restore mobile bottom navigation

Observed issue: the responsive layout no longer preserves the preferred mobile
app navigation.

Restore the fixed mobile bottom navigation with clear role-aware destinations:
**Home · Explore · Conversations · Profile** (Settings may live within Profile
rather than occupying a permanent tab). Requirements: compact icon and text
labels; active-state indication; unread message/notification badges; safe-area
spacing on modern phones; no content hidden behind the navigation; consistent
navigation between mobile pages; desktop may continue using the quiet sidebar.

### B. Remove the Coordinator "Members" tab

Observed issue: the standalone Members tab does not justify a main-navigation
position.

Required: remove Members as a permanent main-navigation tab for Coordinators;
add a **"Your members"** section inside the Coordinator's Profile; place
relationship permissions and management controls inside Settings; allow
switching between managed Members from Profile; show the relevant Member status
and available actions; retain direct links from Home where action is required;
remove **no** existing Coordinator access or booking capability.

Recommended structure — Coordinator Profile: Coordinator details · Your members
· Current permissions · Account preferences. Coordinator Settings: Member
access and permissions · Notifications · Privacy and security · Billing/payment
methods.

## Stage 3H — Companion profile and marketplace redesign

Redesign the Companion profile (per the supplied reference image). The current
page has weak visual hierarchy, excessive empty space, repeated explanatory
text, and under-sells the trial and available call offers. The redesign must be
cleaner, sleeker and more visually engaging while remaining simple and
accessible.

### A. Profile hero

Compact, photo-led hero: Companion photo/avatar; name; short profile headline;
selected languages; favourite button; availability/status indicator where
useful; rating and review count when reviews exist. No prominent internal
profile-state text.

### B. Primary trial action

**"Book a trial conversation" is the strongest action on the page**: prominent
apricot primary button; trial duration and price beside or beneath it; short
"No commitment" explanation; sticky/persistent booking action on mobile where
appropriate; no repetition of the same trial information across multiple large
cards.

### C. Page order

1. Profile hero and trial action
2. About
3. Availability and call offers
4. Interests
5. Reviews
6. Boundaries and reliability

(Preserves the requirement that Availability and Rates sit below About and
above Interests.)

### D. Call offers

Show all active single-call offers clearly — compact cards or selectable chips,
never hidden behind a vague "See more". Each offer displays duration, total
price, effective price per minute, and a clear booking action, e.g.:

> 30 minutes — £10 — 33p per minute — [Book]
> 45 minutes — £10 — 22p per minute — [Book]

Comparison should be easy without feeling like a pricing table.

### E. Interests

Show **all** selected interests (never just one when more exist) as compact
chips/tags wrapping cleanly; sensible maximum layout height for very long
lists; collapse only when there are genuinely many, using **"Show all
interests"** rather than "See more".

### F. Responsive design

Desktop: balanced two-column layout where helpful; booking summary visible
without excessive empty width; comfortable reading lengths. Mobile:
single-column; trial action near the top; fixed bottom navigation; optional
sticky booking button; large accessible touch targets; no horizontal overflow.

## Stage 3I — Rate and offer management UX

A Companion rate-management feature (even when inspected through Coordinator
test accounts). The existing Add-offer control is technically understandable
but not simple enough.

### A. Offer management design

Replace the dense inline form with a simple offer-management panel. Existing
offers appear as individual rows/cards (e.g. "30 minutes — £10 — 33p/min") each
with **Edit**, **Turn off**, optional **Reactivate**, and clear active/inactive
status. Primary action: **"Add another call length"** (clearer than a generic
"Add offer"), opening one compact form — Duration · Total price · Calculated
price per minute · **Save offer** · Cancel. No offer is created until Save
offer is explicitly selected.

### B. Price limits

Enforce an effective per-minute rate of **£0.10 minimum and £0.50 maximum**,
validated server-side as well as in the interface, with a clear inline error
(never silent adjustment). Examples: 30 min → £3.00–£15.00; 45 min →
£4.50–£22.50; 60 min → £6.00–£30.00.

### C. Rate-consistency warning

Calculate and display the effective per-minute rate for every active offer.
Show a **non-blocking** warning when one active offer's per-minute rate differs
by more than 20% from another active offer or from the median active rate,
e.g. "Your 30-minute rate is 50% higher per minute than your 45-minute rate.
This may be intentional, but customers could find the pricing confusing." The
warning never blocks saving while the price stays within the 10p–50p range.

### D. Platform-fee preview

For each draft offer show: customer price; effective per-minute rate; estimated
2% platform fee; estimated Companion earnings — clearly marked as estimates,
with the authoritative snapshot calculated server-side at booking time.

### E. Data and validation

Continue using the authoritative `conversation_offers` model. Preserve:
duration; currency; offer type; active status; supported payment methods;
duplicate active-offer constraints; trial/single/package distinction;
server-side price validation. **Never** replace the multi-offer data model with
one mutable "standard price".

## Stage 3J — Reviews and the post-call experience

Observed issue: the Member or authorised Coordinator cannot leave a review for
the Companion when confirming the call.

Policy (recommended): **one member-side review per booking**, submittable by
either the Member or the authorised booking Coordinator; the first valid
submission owns the booking review; separate Member and Coordinator reviews for
the same conversation are never counted unless the product policy is
deliberately changed later.

Required flow: 1) confirm whether the conversation took place; 2) concise
rating prompt; 3) optional written feedback; 4) **Skip for now**; 5) later
submission from the completed conversation. Eligibility: completed eligible
booking; Member or authorised booking Coordinator only; no unrelated user; no
requested, cancelled or declined booking; idempotent submission; current
rating-summary integrity preserved. The review prompt must never prevent call
confirmation when skipped.

## Future profile enhancement — introduction video (backlog)

Companions may record or upload a short introduction video for their public
profile. **Not implemented in the initial profile redesign.** Future scope:
maximum duration (recommended 30–60 s); upload or in-app recording; preview
before publishing; replace/remove controls; moderation/reporting; private draft
state; transcoding and mobile playback; captions/transcript support; consent
and privacy guidance; storage and bandwidth limits; fallback profile image; no
autoplay with sound. The Stage 3H layout reserves an appropriate future
position for this media without displaying an empty placeholder today.

---

## Roadmap order

1. **Stage 3C2-C3** — Controlled Stripe test-mode Companion transfer rollout
   (runbook: `docs/OPERATIONS_RUNBOOKS.md`).
2. **Stage 3D** — Customer payment confirmation, SCA and delayed-finalisation
   recovery (**launch blocker**).
3. **Stage 3E** — Three-person LiveKit video calls with optional Coordinator
   participation.
4. **Stage 3F** — Message notifications and in-conversation issue reporting.
5. **Stage 3G** — Mobile bottom navigation and Coordinator information
   architecture.
6. **Stage 3H** — Companion profile and marketplace redesign.
7. **Stage 3I** — Rate and offer-management UX with 10p–50p per-minute limits.
8. **Stage 3J** — Reviews and the post-call confirmation experience.
9. Scoped refunds.
10. Financial reconciliation and recovery.
11. Production activation, monitoring and launch hardening.

Future backlog: email and SMS notification delivery; Companion introduction
videos; in-app help bot.

Customer payment reliability (Stage 3D) is a production-launch blocker.
Coordinator participation and video (Stage 3E) must be implemented together
because they alter the same LiveKit room, token, attendance, privacy and
participant model. The help bot and introduction video must not delay the core
launch unless they become explicit launch requirements.
