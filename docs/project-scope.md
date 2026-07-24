# Project scope and roadmap

This document records the authoritative forward scope for the Call App after the
Stage 3C financial-operations work. It complements `docs/OPERATIONS_RUNBOOKS.md`
(operational procedures), `docs/payments-architecture.md` (payment design) and
`ARCHITECTURE.md` (system architecture).

Current position: Stage 3C2-C3 — controlled Stripe TEST-MODE Companion transfer
rollout (migrations 0001–0079 applied; environment `hosted_test`; all financial
controls disabled; provider transfer ceiling 0; `scoped-stripe-transfers`
prepared but deployed only through the controlled rollout runbook).

---

## Post-Stage-3C launch blockers and product improvements

Newly identified issues, recorded 2026-07 during the Stage 3C2-C2/C3 window.
Only an issue that directly prevents the controlled test-mode transfer rollout
may be implemented inside Stage 3C2-C3; everything else belongs to its
designated stage below. (None of A–G blocks C3: the C3 fixture is created
through authorised backend test helpers, not the customer payment UI.)

### A. Customer payment reliability — LAUNCH BLOCKER → Stage 3D

Observed problems:

1. When a payment needs bank authentication (SCA/3-D Secure), there is
   sometimes no visible handoff or popup to the customer's banking application
   or authentication page.
2. A payment can be taken successfully while the application remains stuck in a
   pending/loading state and never confirms the booking or purchase.

This is distinct from Companion payout transfers (Stage 3C2-C). It is a
customer-facing PaymentIntent/checkout lifecycle problem.

**Stage 3D — Customer payment confirmation and SCA reliability.** Scope:

- audit the complete PaymentIntent and checkout lifecycle (create → confirm →
  requires_action → succeeded/failed), including how `requires_action` and
  `requires_confirmation` are currently handled;
- support Strong Customer Authentication with a real banking-app/browser
  handoff, return URLs, and resuming the application after authentication;
- treat Stripe webhook state as authoritative; add client polling/status
  refresh after returning from the bank; recover when Stripe succeeds but the
  browser misses the response;
- prevent duplicate orders, bookings, credit deductions and PaymentIntents;
- show explicit customer states: awaiting bank authentication · processing ·
  payment succeeded and booking being confirmed · payment failed · payment
  received but local confirmation delayed;
- provide a safe manual refresh/recovery action; persist enough state that the
  customer can close and reopen the app mid-payment;
- timeout and retry handling that can never charge twice;
- test matrix: card, credit-only and mixed payment; abandoned authentication;
  webhook-before-client and client-before-webhook ordering; payment succeeded
  but local finalisation initially failed.

Acceptance criteria: the customer is always clearly sent to the correct bank
flow when authentication is required; returning to the application resumes
confirmation; a successful Stripe payment always eventually produces the
correct local order and booking exactly once; the UI never spins indefinitely;
no successful payment is ever presented as unpaid; no retry can double-charge.

**Stage 3D must be completed before production activation.**

### B. Reviews after a call → Stage 3F

Observed problem: the Member or Coordinator cannot leave a review for the
Companion when confirming that a call took place.

Scope: a clear review step inside the call-confirmation flow; the Member or the
booking's authorised Coordinator may submit the member-side review; explicit
product decision on cardinality — **recommended default: one member-side review
per booking, submittable by either the Member or the authorised booking
Coordinator; the first valid submission owns the booking's review unless an
explicit edit policy is implemented** (never silently count two reviews for one
call); eligibility limited to completed/confirmed bookings (requested, declined
and cancelled bookings rejected); unrelated Coordinators/users rejected;
idempotent submission; rating plus optional written feedback; preserve the
existing unique-reviewer rating rules unless deliberately replaced; allow later
submission when the prompt is skipped.

### C. Coordinator participation in calls → Stage 3E

Observed problem: the Coordinator cannot join a call; an authorised Coordinator
should be able to sit in when appropriate.

**Stage 3E — Three-person video call experience.** Participation model: at most
three logical participants — Member, Companion, and the booking's authorised
Coordinator (optional). Only a Coordinator with valid access to that Member and
booking may join; no unrelated Coordinator; all participants are visibly told
when the Coordinator is present (no hidden or silent joining); all active
participants displayed; explicit product decision on whether the Member or
Coordinator must request/approve Coordinator presence; room and booking
isolation preserved; Coordinator presence included in call diagnostics and
attendance evidence but **never** counted as Member attendance; Companion
earnings and completion rules stay based on the correct Member/Companion
participation policy; every test currently asserting the Coordinator can never
join is updated. This is a deliberate change to the two-participant
architecture — the complete authorisation, attendance and privacy model changes
with it; no patching around the current restriction.

### D. Video calls → Stage 3E (with C)

Observed problem: the call experience is audio-only.

Scope (implemented together with C because both change the same LiveKit room,
token, attendance and participant model): camera and microphone permissions;
video publishing/subscription; camera on/off and mic mute/unmute controls;
audio-only fallback (the ability to make audio-only calls is retained);
participant tiles for up to three users; responsive desktop and mobile layouts;
connection-quality feedback; recovery after camera/device changes; no automatic
camera publishing before consent; privacy-safe pre-join previews; test all
Member/Companion/optional-Coordinator combinations; maintain LiveKit room
isolation and token scoping; review the increased LiveKit bandwidth and cost
implications.

### E. Application header icon → Stage 3F (UI polish)

Observed problem: the top-left header shows both the icon and the brand name.

Required: icon only in the top-left navigation; remove the adjacent brand-name
text; size appropriately for a modern header (visible, not dominating);
preserve accessible labelling for screen readers; proportionate on desktop and
mobile; use the existing approved brand icon — no new logo.

### F. Profile section order → Stage 3F

Observed problem: when a Coordinator views the relevant profile, Availability
and Rates is in the wrong position.

Required order: **1. About · 2. Availability and Rates · 3. Interests** for the
Coordinator-facing profile view. Confirm during implementation whether the same
order applies to Member and public Companion-profile views; do not duplicate
the section or create inconsistent mobile/desktop ordering.

### G. Rates and offers → Stage 3F

Observed problem: there is no appropriate action for changing or adding
pricing; the current standard-price action is presented as an "Update" button.

Required: remove/replace the standard-price "Update" button; make **"Add
offer"** the primary action; support multiple clearly defined offers where
permitted; show existing offers separately with their own edit/deactivate
actions; never imply that one mutable standard price represents all pricing;
keep trial, single-call and package/plan offers distinguishable; retain
server-side validation (amount, currency, duration, active status, duplicate
active offers, supported payment methods); the UI must reflect the existing
authoritative `conversation_offers` model; no offer is created until the user
explicitly confirms the form. Scope clarification to resolve during
implementation: "Availability and Rates" appears both as the Companion's
editable settings section and as a profile section viewed by a Coordinator —
the offer-management actions belong to the Companion settings surface; the
Coordinator profile view stays read-only.

---

## Roadmap order

1. **Stage 3C2-C3** — Controlled Stripe test-mode Companion transfer rollout
   (runbook: `docs/OPERATIONS_RUNBOOKS.md`, "Scoped provider transfer rollout").
2. **Stage 3D** — Customer payment confirmation, banking authentication and
   webhook recovery (**launch blocker**).
3. **Stage 3E** — Video calling and optional Coordinator participation,
   maximum three users (C + D together — same LiveKit room/token/attendance
   model).
4. **Stage 3F** — Reviews after a call, profile section order, offer
   management, and navigation-icon polish (B, E, F, G).
5. Scoped refunds (refund_claim / refund_finalise through the hardened scoped
   operation architecture).
6. Financial reconciliation and recovery (incl. the deliberate, reviewed
   handling of reconciliation-required scoped transfer jobs and the 177
   historical findings).
7. Production activation, monitoring and launch hardening (production_live
   environment, master control, provider ceiling configuration, alerting).

Payment reliability (Stage 3D) must be completed before production activation.
