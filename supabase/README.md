# Supabase setup (Stages 2A + 2B)

The app runs in two clearly separated data modes:

| Mode | What it does |
|---|---|
| `mock` *(default)* | The complete Stage 1 prototype — seeded fictional data, localStorage, no network, **no authentication required**. |
| `supabase` | Real email/password authentication, accounts, profile access and RLS (Stage 2B). Feature data (bookings, Explore, favourites…) still runs locally until Stage 2C migrates it. |

```
VITE_DATA_SOURCE=mock       # or "supabase"
```

(`VITE_DATA_MODE` still works as a legacy alias. Runtime switching: Settings → Prototype tools → Data mode.)

## Project setup

1. Create a project at [supabase.com](https://supabase.com) (or `supabase start` locally).
2. In the SQL editor run, in order:
   - `supabase/migrations/0001_initial_schema.sql`
   - `supabase/migrations/0002_auth_profile_access_rls.sql`
   - `supabase/migrations/0003_profiles_interests_favourites_storage.sql`
   - `supabase/migrations/0004_companion_availability_offers.sql`
   - `supabase/migrations/0005_booking_persistence.sql`
   (CLI: `supabase db push`.)
3. Copy `.env.example` to `.env` and fill in **Project Settings → API**:
   ```
   VITE_SUPABASE_URL=…          # project URL
   VITE_SUPABASE_ANON_KEY=…     # anon/public key ONLY — never service_role
   VITE_APP_URL=http://localhost:5173
   VITE_DATA_SOURCE=supabase
   ```
4. Restart the dev server.
5. Generated types: with the CLI linked, regenerate after schema changes:
   ```
   npm run types:generate
   ```
   Until then, `src/supabase/database.types.ts` is a documented hand-authored
   bootstrap that mirrors the migrations exactly.

## Authentication configuration (Supabase dashboard)

**Authentication → Providers → Email**: enable Email; keep "Confirm email" ON.

**Authentication → URL Configuration**:
- **Site URL**: `http://localhost:5173` (your `VITE_APP_URL`; change per environment)
- **Redirect URLs** — add both:
  - `http://localhost:5173/#/auth/callback` (email confirmation)
  - `http://localhost:5173/#/reset-password` (password reset)

For a deployed environment add the same two paths on the deployed origin and
set `VITE_APP_URL` accordingly. Email templates need no changes — the default
`{{ .ConfirmationURL }}` templates work with these redirects.

Local stack note: `supabase start` serves a local inbox (Inbucket, usually
http://127.0.0.1:54324) where confirmation and reset emails arrive. To run the
RLS test suite, disable email confirmation in the local `config.toml`
(`[auth.email] enable_confirmations = false`) so test users can sign in
immediately.

## The account/profile model (Stage 2B)

```
auth.users → accounts → profile_access → profiles
```

- **accounts** — one row per auth user (bootstrap: `ensure_current_account()`,
  idempotent, called automatically after sign-in).
- **profiles** — Members, Companions, Coordinators. Profile ids are separate
  UUIDs; never assume `auth.users.id = profiles.id`.
- **profile_access** — the authoritative record of which account may act as
  which profile (`owner` / `coordinator` / `viewer`, with per-grant
  permissions and consent status).

Controlled operations (all derive the actor from `auth.uid()`):
- `create_owned_profile(role, …)` — profile + owner access, atomically.
- `create_managed_member_profile(…)` — Coordinator’s managed Member + access
  (consent recorded as a **prototype onboarding confirmation**, not identity
  verification). No auth user is created for the Member.
- `complete_onboarding()` — marks the current account’s onboarding done.

## Security posture

- RLS enabled on every table; no `using (true)` on private tables.
- Accounts and profile_access: strictly self-scoped reads; writes via functions.
- Profiles readable only via profile_access, plus **active + public Companion
  profiles** for the marketplace. Members/Coordinators are never discoverable.
- Protected fields (verification, profile/account status, role) are frozen
  against browser updates by triggers — no self-verification or self-unsuspend.
- Companions signed up in Supabase mode get `verification = 'pending'`;
  nothing shows a real "Verified" badge without a real process.
- The profile switcher in Supabase mode lists only database-derived accessible
  profiles; cached active-profile ids are validated and cleared when invalid.

### RLS test suite

`src/domain/__tests__/rls.integration.test.ts` proves cross-user isolation
(two real users, 17 checks). It needs a live project:

```
SUPABASE_TEST_URL=http://127.0.0.1:54321 \
SUPABASE_TEST_ANON_KEY=<anon key> \
npx vitest run rls.integration
```

Without those variables the suite is skipped. **Run it before treating
Stage 2B as security-verified.** Use a disposable dev project.

## Stage boundaries

Implemented (2B): email/password auth, confirmation, sign in/out, forgot/reset
password, sessions, protected routes, account bootstrap, owned profiles,
managed-Member relationships, initial RLS, secure profile switching,
auth-aware signup completion.

Deferred: full feature repository migration (Home/Explore/favourites/bookings/
packages/ratings/notifications), payments, external email/SMS, profile
claiming and invitations, identity verification, admin tooling, MFA, social
login.

## Troubleshooting

- **“Supabase isn’t configured”** — `.env` missing/misnamed or dev server not
  restarted after editing it.
- **Confirmation email never arrives** — check spam; on the local stack check
  Inbucket; verify the Email provider is enabled.
- **Confirmation/reset link lands on an error** — the redirect URL isn’t in
  Authentication → URL Configuration, or `VITE_APP_URL` doesn’t match the
  origin you’re browsing on. Links also expire after use.
- **Reset link opens the app but not the reset form** — ensure the redirect is
  exactly `…/#/reset-password` (hash router).
- **Queries return empty in Supabase mode** — that’s RLS working: you’re
  signed out, or the row genuinely isn’t yours. Check Settings → Prototype
  tools → Authentication status.
- **“Account bootstrap failed”** — migration 0002 not applied; run it and use
  “Try again”.
- **Stale generated types** — rerun `npm run types:generate` after migrations.
- **Local migration mismatch** — `supabase db reset` re-applies all migrations
  from scratch.

## Fresh-account rule

In Supabase mode the view state is built exclusively from the authenticated
account's `profile_access` set (`src/state/authBridge.ts`). New accounts start
with zero conversations, packages, ratings, notifications and favourites; an
empty database result stays empty, and unmigrated features never fall back to
the mock demo data. Explore reads discoverable Companions through the RLS
discovery policy (`src/state/marketplace.ts`) — marketplace profiles carry no
relationship to the account. The seeded Stage 1 demo lives only in mock mode.

## Stage 2C1 — persistent profiles, interests, favourites, avatars, Explore

Run `supabase/migrations/0003_profiles_interests_favourites_storage.sql`
after 0001/0002 (SQL editor or `supabase db push`), then regenerate types.

- **Tables**: `profile_private_details` (DOB/contact — sensitive),
  `member_profiles` (preferences), `companion_profiles` (style, accepting,
  server-controlled `verification_status`), `coordinator_profiles`,
  `interests` (seeded catalogue, read-only to users), `profile_interests`,
  `favourites` (`account_id` defaults to `auth.uid()`, verified by RLS).
- **Discovery**: the `discoverable_companions` view (security_invoker) is the
  ONLY public Companion payload — explicit safe columns incl. `last_initial`,
  aggregated interest names; never surname/DOB/email/phone. Explore queries it
  with server-side search, filters, sorting and `range()` pagination (12/page).
- **Signup persistence**: `complete_member_signup`, `complete_companion_signup`
  (18+ enforced in SQL), `complete_coordinator_signup` (atomic Coordinator +
  managed Member + preferences + interests + consent record).
- **Interests**: `replace_profile_interests()` — SECURITY INVOKER, validates
  catalogue ids, atomic replace; RLS gates writes by `can_edit`.
- **Avatars**: private bucket `profile-avatars` (4 MB; jpeg/png/webp), object
  path `{profile_id}/{uuid}.{ext}`; upload/replace/delete only for editable
  profiles, reads for accessible profiles or discoverable Companions, always
  via signed URLs. Replacement = upload new → update `avatar_path` → delete
  old (never a dangling pointer).
- **Field classification**: see `docs/PROFILE_FIELDS.md`.

Still deferred (honestly empty, never faked): availability, offers/pricing,
bookings, packages, ratings, payments, external notifications, verification,
administration.

## Stage 2C2 — Companion availability, scheduling settings and offers

Run `supabase/migrations/0004_companion_availability_offers.sql` after
0001–0003, then regenerate types. **Prices persist, but no booking, payment
or transaction happens yet** — booking is the next milestone.

- **Availability**: `availability_rules` reshaped — ISO `day_of_week`
  (1 = Monday … 7 = Sunday), minute-precision `start_local_time`/`end_local_time`
  kept in the Companion's IANA `timezone` (never display labels like "GMT").
  Multiple windows per day allowed; adjacent windows are accepted as separate;
  overlaps are rejected. Writes ONLY via `replace_companion_availability()`
  (SECURITY DEFINER by design: the table has no direct write policies, so
  validation cannot be bypassed; actor from `auth.uid()`, search_path pinned).
- **Exceptions**: `availability_exceptions` (`unavailable` /
  `additionally_available`, timestamptz ranges, optional note). Entirely
  private — notes are never exposed; marketplace display uses recurring rules
  only until slot generation exists.
- **Scheduling settings** on `companion_profiles`: `timezone`,
  `minimum_notice_hours` (0–336, default 24), `booking_horizon_days`
  (1–365, default 60), plus `is_accepting_new_members`.
- **Offers**: `conversation_offers` — `trial` | `single`, durations
  15/30/45/60, **money as integer minor units** (£5.00 = 500), GBP only,
  price £1–£1000 enforced in SQL and UI. One active trial per Companion and
  one active single per duration (partial unique indexes). Archived
  (`active=false`), never deleted.
- **Fees**: previews only — 0% trial / 2% standard read from
  `platform_config` (users cannot update it). Example: £10.00 → fee £0.20 →
  Companion £9.80, always labelled an estimate.
- **Discovery view v2** adds `trial_price_minor`, `min_single_price_minor`,
  `single_durations`, `available_days`, `available_dayparts`
  (morning < 12:00 ≤ afternoon ≤ 17:00 < evening), timezone and notice/horizon.
  Explore filters on these server-side; the price filter uses the **lowest
  active single offer** (documented rule) with a separate "Trial available"
  filter.
- **Signup**: Companion signup now persists availability windows (from the
  wizard's days/dayparts), timezone, notice, and trial/single offers. If that
  step fails after profile creation, a recoverable "finish setting up" state
  appears on the profile — nothing is silently lost.
- **Editor**: Profile → Availability & rates (route `/availability`) — weekly
  windows, copy-day, time off, notice/horizon, accepting toggle, offer editor
  with fee previews and an explicit "payments not enabled yet" notice.
- **Timezones**: Intl-based utilities (`src/domain/timezones.ts`) — DST-safe
  wall-time→UTC conversion, viewer-timezone window display, validation. No
  manual offset arithmetic.

Deferred still: packages, purchases, payments, ratings, notifications,
verification, administration.

## Stage 2D — real bookings, slots, conflicts and transitions

Run `supabase/migrations/0005_booking_persistence.sql` after 0001–0004, then
regenerate types. **No payment is taken** — booking price/fee figures are
server-side snapshots and always labelled estimates.

### Schema

- **`bookings`** (rebuilt — the Stage 1 placeholder table had no policies or
  data and is dropped by 0005): participants (`member_profile_id`,
  `companion_profile_id`, `booked_by_account_id`), `offer_id`, times
  (`starts_at`/`ends_at`, `timezone`), `communication_method`, `status`, and
  **snapshots** taken server-side at creation: `duration_minutes`,
  `price_minor`, `currency`, `platform_fee_rate`, `platform_fee_minor`,
  `companion_amount_minor`, `is_trial`. Cancellation audit fields
  (`cancellation_reason`, `cancelled_by_account_id`, `cancelled_at`).
  Constraints: start < end, duration matches the range, GBP only,
  non-negative money, valid status.
- **`booking_status_history`** — append-only audit: every creation and
  transition writes a row in the same transaction (previous/new status, actor
  account, optional reason). Users can read history only for bookings they
  can see; direct writes are impossible.
- **`booking_time_proposals`** — alternative-time proposals
  (`pending`/`accepted`/`rejected`/`expired`), at most one pending per booking
  (partial unique index). `previous_booking_status` records what to restore on
  rejection. A proposal never reserves the slot.

### Status model & transitions

`requested → confirmed | declined | change_proposed | cancelled`
`change_proposed → confirmed (proposal accepted) | previous status (proposal rejected) | cancelled`
`confirmed → change_proposed (reschedule) | cancelled`
`declined`, `cancelled` — terminal.

There are **no direct write policies** on any booking table: creation and
every transition go through SECURITY DEFINER functions that derive the actor
from `auth.uid()`, validate the current status, and write history atomically.
A confirmed booking whose end has passed is *displayed* as “Conversation
ended — confirmation will be added in a later stage” (derived UI state only;
completion persistence is a later milestone).

### Conflict prevention (atomic)

Two GiST **exclusion constraints** (`btree_gist`, `tstzrange`) guarantee, in
the database, that neither a Companion nor a Member can hold two overlapping
bookings in an active status — even for perfectly simultaneous requests.
Participating statuses: `requested`, `confirmed`, `change_proposed` (a
proposed-change booking still reserves its current time). `declined` and
`cancelled` release the slot. Losing writers receive `slot_taken`, surfaced
in the UI as “That time has just been taken” with slots reloaded.

### Slot generation

`get_available_slots(companion, offer, from, to)` (authenticated users only;
companion must be discoverable or accessible; offer must be active and the
companion's own):

- recurring rules are Companion-local; conversion uses Postgres IANA timezone
  rules (DST-safe), on a **15-minute grid**;
- `additionally_available` exceptions add windows; `unavailable` exceptions
  veto any overlap;
- minimum notice and booking horizon (companion settings) are enforced;
- slots overlapping any active booking are removed;
- range is clamped to **31 days**, results capped at **200 slots**.

The same server-side validation runs again inside `create_booking_request`,
so a stale browser can never book an unavailable time.

### Booking functions

- `create_booking_request(member, offer, starts_at, method)` — the ONLY way a
  booking is created. Requires `profile_access.can_book` on the Member
  (`can_act_for_member`), an active offer, an accepting companion, a supported
  method, and a valid slot. Price/fee/companion are derived **server-side**
  from the offer and `platform_config` (trial 0% / standard 2%) — browser
  price input does not exist.
- `accept_booking` / `decline_booking(reason?)` — companion's authorised
  account only, `requested` bookings only.
- `propose_booking_time(booking, starts_at, message?)` — companion for
  `requested`; either authorised side for `confirmed` reschedules. Sets
  `change_proposed`.
- `accept_booking_time_proposal` — the non-proposing side only; revalidates
  availability/notice/horizon and conflicts **at acceptance time**, then
  atomically moves the booking and confirms it. If the slot is gone the
  booking is left unchanged with a clear conflict error.
- `reject_booking_time_proposal` — the non-proposing side; restores the
  booking's previous status (documented behaviour: a rejected proposal on a
  `requested` booking returns it to `requested`, on a `confirmed` booking to
  `confirmed`).
- `cancel_booking(reason?)` — booker, member owner, coordinator with
  `can_book`, or companion owner; any active status; records actor, timestamp
  and reason, expires pending proposals. No refund logic exists — no payment
  was taken.

### Trial rule (conservative, Stage 2D)

A Member–Companion pair may hold at most **one non-terminal trial booking**
(partial unique index over active statuses). Declined/cancelled trials do not
consume eligibility. Permanent “trial used” consumption is finalised in the
completion milestone.

### RLS

Bookings, history and proposals are readable ONLY by participants: the
booking account, or accounts with `profile_access` to the member or the
companion profile. The `my_bookings` view adds safe participant names (first
name + last initial — never surname, email, phone or private details).
No insert/update/delete policies exist on any booking table; all writes go
through the controlled functions above. A booking never exposes contact
details — direct contact sharing is a later controlled step.

### Frontend

- `src/repositories/bookingRepository.ts` — typed methods
  (`getAvailableSlots`, `createBookingRequest`, `listMyBookings`,
  `getBookingById`, `getBookingHistory`, `getPendingProposal`,
  `acceptBooking`, `declineBooking`, `proposeBookingTime`,
  `acceptTimeProposal`, `rejectTimeProposal`, `cancelBooking`,
  `splitBookings`, `derivedStatusLabel`) mapping database errors to typed
  `RepoError`s (conflict / unauthorised / not_found / validation / network).
  Never falls back to mock bookings.
- `SupabaseBookingWizard` (from a public Companion profile): offer →
  (Coordinator: managed-Member choice, `can_book` grants only) → real slots
  in the viewer's timezone → method → review with price snapshot, estimated
  fee and “No payment will be taken yet. Payments will be added in a later
  stage.” Slot conflicts reload the slot list.
- Conversations (Supabase mode): real records, Upcoming (active, end in the
  future) / Past (declined, cancelled, ended). Home: incoming requests,
  proposed-time alerts and next confirmed conversations from real data —
  fresh accounts keep their intentional empty states.
- `/conversations/:bookingId` — permission-protected detail page (safe
  not-found for strangers): status, times in the viewer timezone, price
  snapshot (“No payment has been taken.”), audited history, pending proposal
  and only the actions the account may perform.
- Mock mode is untouched: the Stage 1 booking experience still runs entirely
  on localStorage.

### Tests

- `src/domain/__tests__/booking2d.test.ts` — browser sends no
  price/fee/actor; typed error mapping; upcoming/past classification; honest
  labels (no “completed”, no payment language); DST-safe display
  (spring-forward, fall-back, cross-timezone viewers).
- `rls.integration.test.ts` (2D block) — live evidence: slot generation
  bounds, server-side price snapshots, coordinator `can_book` enforcement,
  participant-only reads, denied direct writes/status tampering/history
  forgery, accept/decline/proposal authorisation, previous-status restore,
  cancellation releasing slots, and a **true concurrency test** (two
  simultaneous requests for one slot → exactly one success). Same command as
  above; skipped without `SUPABASE_TEST_URL`/`SUPABASE_TEST_ANON_KEY`.

Deferred after 2D: completion confirmations (→ 2E1A), package credits,
payments, ratings persistence, meeting links, external notifications,
verification, administration.

## Stage 2E1A — completion confirmations and reconciliation

Run `supabase/migrations/0006_completion_confirmations.sql` after 0001–0005.
**No payment, payout, package credit or rating is processed on completion.**

- **Statuses**: `bookings.status` gains `completed` and `needs_review`
  (terminal for normal users; admin resolution is a later milestone).
  “Awaiting completion” is DERIVED — a `confirmed` booking whose `ends_at`
  has passed — no background job.
- **`completion_confirmations`**: one row per booking per side
  (`member` / `companion`, unique together), with outcome
  (`completed` / `did_not_happen` / `report_concern`), optional note,
  submitting account and the participant profile (server-derived; a trigger
  guarantees it matches the booking). Updatable until the booking is
  reconciled.
- **`submit_completion_confirmation(booking, outcome, note?)`** — the ONLY
  write path. Requires auth; the SIDE IS DERIVED from `auth.uid()`
  (companion access → companion side; booker / `can_book` coordinator →
  member side; anyone else rejected). Rejects: `too_early` (end not passed),
  `booking_not_eligible` (not confirmed), `already_finalised`,
  `invalid_outcome`. Upserts this side's row, then reconciles atomically
  under a row lock and audits any status change into
  `booking_status_history`.
- **Reconciliation rules**: any `report_concern` → `needs_review`
  immediately (even one-sided); both `completed` → `completed`; both sides
  present with any other combination (`completed`+`did_not_happen`, both
  `did_not_happen`) → `needs_review`; a single `completed`/`did_not_happen`
  leaves the booking `confirmed`, awaiting the other side.
- **`get_completion_state(booking)`** — participant-only payload: status,
  both sides' outcomes/notes and which side the caller represents.
- **RLS**: confirmations readable only via `can_read_booking` (participants);
  NO insert/update/delete policies — concern notes never leave the booking's
  participants; nobody can set `completed`/`needs_review` directly.
- **Repository** (`bookingRepository.ts`): `CompletionOutcome`,
  `ParticipantSide`, `CompletionState`, `getCompletionState`,
  `submitCompletionOutcome`, `listBookingsNeedingConfirmation`,
  `canConfirmCompletion`, `reconcileOutcomes` (pure display mirror of the
  server rules) and `CompletionError` with stable codes (`too_early`,
  `unauthorised`, `booking_not_eligible`, `already_finalised`,
  `invalid_outcome`, `needs_review`, `network_failure`).
- **Tests**: `booking2e1a.test.ts` (reconciliation matrix, eligibility,
  browser contract — the side is never sent — and typed errors). Live suite
  gains a 2E1A block (too-early rejection, authorisation, denied direct
  writes/status tampering, confirmation isolation). Live limitation:
  API-created bookings always end in the future, so full reconciliation is
  proven by the unit matrix + SQL, not live. Run 0006 before `test:rls`.

Deferred after 2E1A: ratings persistence (→ 2E2A), package-credit
consumption, payments/payouts, admin dispute resolution, notifications.
(2E1B added the completion UI: `CompletionPanel` on the booking detail page,
a "How did it go?" Home section, honest labels — no schema changes.)

## Stage 2E2A — ratings persistence

Run `supabase/migrations/0007_ratings.sql` after 0001–0006. **No rating UI
yet** (Stage 2E2B); no payment, package or notification side effects.

- **Model (preserved from Stage 1)**: ONE-WAY — the Member side rates the
  Companion after a COMPLETED conversation. "One person, one rating":
  unique `(reviewer_profile_id, reviewee_profile_id)`; a later completed
  conversation UPDATES the same row and re-points `source_booking_id` at
  the latest booking. Public averages therefore count unique reviewers
  structurally — repeat bookings cannot inflate them.
- **`ratings` (rebuilt)**: reviewer/reviewee profiles, submitting account,
  source booking, `score` 1–5, `public_comment` (≤1000), `private_feedback`
  (≤2000, platform-team only), reviewer ≠ reviewee. A trigger guarantees the
  source booking is `completed` and the participants match it.
- **`submit_rating(booking, score, public_comment?, private_feedback?)`** —
  the ONLY write path. Derives reviewer (member side: booker or `can_book`
  Coordinator) and reviewee (the booking's companion) from `auth.uid()` +
  the booking; rejects companions (`self_rating` — one-way model), unrelated
  accounts, non-completed bookings (`booking_not_completed`, incl.
  needs_review/cancelled/declined), invalid scores and oversized comments.
  Upserts the pair rating atomically.
- **Public surfaces** (UI wiring in 2E2B):
  `get_companion_rating_summary(profile)` → `{ average, reviewer_count }`;
  `get_companion_public_reviews(profile, limit, offset)` → reviewer first
  name + last initial, score, public comment, date. Discoverable companions
  (or own profiles) only. NEVER private feedback, account ids or booking
  details.
- **RLS**: reviewer-side reads only (submitting account or reviewer-profile
  access) — the Companion sees aggregates through the safe functions and can
  never read private feedback. No direct insert/update/delete for anyone.
- **Repository**: `src/repositories/ratingRepository.ts` — `submitRating`
  (client-side score/length pre-validation), `getRatingForPair`,
  `getRatingForBooking`, `getPublicRatingSummary`, `getPublicReviews`, and
  `RatingError` with stable codes (`too_early`, `booking_not_completed`,
  `unauthorised`, `invalid_score`, `invalid_comment`, `self_rating`,
  `not_found`, `network_failure`).
- **Tests**: `rating2e2a.test.ts` (contract — participants never sent;
  validation; typed errors; pair-update and unique-reviewer aggregation via
  the shared domain rules; safe public payloads). Live suite gains a 2E2A
  block (eligibility, one-way enforcement, unrelated rejection, forged ids,
  denied direct writes, safe summaries). Live limitation: bookings cannot
  reach `completed` inside a test run, so the happy-path upsert is proven by
  unit tests + SQL. Run 0007 before `test:rls`.

Deferred after 2E2A: package credits (→ 2E3A), payments/payouts, admin
dispute resolution, external notifications, verification, admin.
(2E2B added the ratings UI: `RatingPanel` on completed bookings, real
summaries/reviews on profiles and Explore cards — no schema changes.)

## Stage 2E3A — packages and secure credit accounting

Run `supabase/migrations/0008_packages.sql` after 0001–0007. **No payment
is taken** — every purchase is SIMULATED (`is_simulated = true`, enforced
by a check constraint until the payments milestone). **No booking
integration yet** — reserve/consume arrive in Stage 2E3B.

- **`package_offers`** (rebuilt from the Stage-1 placeholder): companion
  packages of 2–20 conversations × 15/30/45/60 minutes, total price
  £1–£2,000 in integer minor units, GBP only. Writes only via
  `create_package_offer` / `update_package_offer` / `archive_package_offer`
  (companion editors; validation in SQL; archived, never deleted).
- **`package_purchases`** (rebuilt): buyer account (derived from
  `auth.uid()`), member + companion profiles, and full server-side
  SNAPSHOTS (title, count, duration, price, currency) — later offer edits
  never touch a purchase. Statuses: active / exhausted / cancelled.
  `expires_at` exists but no automatic expiry yet.
- **`package_credit_ledger`** (append-only): entry types grant / reserve /
  release / consume / adjustment (only `grant` is written in this stage).
  **Balance is always CALCULATED**: grants + releases + adjustments −
  reserves − consumes (`get_package_balance`) — browser totals are never
  trusted, and no direct ledger writes exist for anyone.
- **`create_simulated_package_purchase(member, offer)`**: requires
  `can_act_for_member` (owner or `can_book` Coordinator), an active offer
  from a discoverable companion; snapshots server-side, creates the
  purchase and the initial grant in ONE transaction, returns purchase +
  ledger balance. Reason line says it plainly: "simulated purchase, no
  payment taken".
- **RLS**: offers readable for discoverable companions/editors; purchases
  and ledger readable only by the buyer and member-side accounts (the
  companion doesn't see purchase records in this stage — documented);
  zero direct write policies on any package table.
- **Repository**: `src/repositories/packageRepository.ts` — offer CRUD,
  `createSimulatedPurchase`, `listPackagePurchases`, `getPackageBalance`,
  `ledgerBalance` (pure mirror of the SQL maths) and `PackageError` codes
  (`unauthorised`, `invalid_offer`, `offer_inactive`, `invalid_price`,
  `invalid_count`, `member_not_accessible`, `not_found`,
  `network_failure`).
- **Tests**: `packages2e3a.test.ts` (contract — buyer/price/count never
  sent; validation; typed errors; ledger maths incl. future entry types).
  The live suite gains a full 2E3A block — unlike completions/ratings this
  flow has no time dependency, so the ENTIRE happy path runs live:
  creation, validation, snapshot-survives-reprice, coordinator purchase,
  forged member/price rejection, archive blocking, ledger isolation and
  denied forgery. Run 0008 before `test:rls`.

Deferred after 2E3A: booking-with-credit UI (2E3B2B), payments, payouts,
admin tooling, external notifications, verification.
(2E3B1 added the package UI: Companion editor on Availability & rates,
public package cards with the simulated purchase flow, and the Home
dashboard — no schema changes.)

## Stage 2E3B2A — package-credit reservation, release and consumption

Run `supabase/migrations/0009_package_booking_credits.sql` after
0001–0008. **Backend + repository only — no booking UI changes yet.**

- **Bookings**: gain `package_purchase_id` and `booking_source`
  (`single_offer` | `package_credit`). Package bookings reference a
  purchase and have NO `offer_id` (now nullable; a shape check keeps the
  two sources mutually exclusive — no fake conversation offers). The
  `my_bookings` view is recreated to expose the new columns. Existing
  single-offer bookings are untouched.
- **Lifecycle** (ledger formula: grants + releases + adjustments −
  reserves − consumes):
  book → `reserve 1` atomic with creation · decline/cancel → `release 1`
  · completed → `release 1 + consume 1` (the reservation becomes a
  consumed credit, never deducted twice) · requested / confirmed /
  change_proposed / **needs_review** → stays reserved. When total
  consumption reaches the snapshot count the purchase flips to
  `exhausted` (server-decided; nobody can set it manually).
- **Concurrency**: `create_package_booking_request(purchase, starts_at,
  method)` locks the purchase row FOR UPDATE while checking the balance
  and writing the reserve — two simultaneous requests can never spend
  the same final credit. Unique partial indexes make a second reserve /
  release / consume per booking structurally impossible, and
  `app_private.settle_package_credit` (not callable by users) is
  idempotent on top of that.
- **Eligibility**: caller must `can_act_for_member`; purchase active with
  ≥1 credit; method from the originating package offer; duration from the
  purchase snapshot; availability/notice/horizon and the GiST no-overlap
  constraints all apply exactly as for single-offer bookings. Member,
  Companion, duration, price share (price ÷ count, standard fee rate) and
  buyer all derive server-side.
- **Transitions**: `decline_booking`, `cancel_booking` and
  `submit_completion_confirmation` are re-created (identical behaviour)
  plus settlement. Ordinary bookings take the no-op path.
- **Reads**: `get_booking_credit_state(booking)` — participant-only
  reserve/release/consume flags. Direct ledger writes remain impossible.
- **Repository** (`packageRepository.ts`): `createPackageBookingRequest`,
  `getAvailablePackagePurchases(member, companion, duration)` (display
  filter — active, matching, ≥1 credit; the server re-checks at booking),
  `getBookingCreditState`, and new `PackageError` codes (`no_credit`,
  `package_inactive`, `package_mismatch`, `slot_unavailable`,
  `invalid_method`, `already_released`, `already_consumed`).
- **Tests**: `packages2e3b2a.test.ts` (contract — participants/prices
  never sent; typed errors; availability filtering; the ledger conversion
  maths incl. exhaustion). The live suite gains a 2E3B2A block: reserve on
  booking, **final-credit concurrency race**, zero-balance rejection,
  method/authorisation/forged-source rejection, release on decline and
  cancel with double-release proven impossible, credit-state isolation.
  Live limitation: completed→consume needs an ended booking, so the
  conversion is proven by unit tests + SQL. Run 0009 before `test:rls`.

Deferred after 2E3B2A: payments, payouts, package expiry, admin tooling,
notifications.

## Stage 2E3B2B — package-credit booking UI

Run `supabase/migrations/0010_package_slots.sql` after 0001–0009.
The only schema addition is `get_available_package_slots(purchase, from,
to)` — a genuine gap: slot generation previously required an active
conversation offer, which package bookings deliberately don't have. It
derives the companion and duration from the PURCHASE and applies exactly
the same rules (availability + exceptions, notice, horizon, conflicts,
15-minute grid, 31 days, 200 slots), readable only by purchase readers.

- **Wizard**: the booking flow now offers "Pay per conversation" AND
  "Use a package credit" whenever the chosen Member has an active,
  in-credit package with this Companion (remaining count, duration and
  a "1 credit" badge shown). Slots follow the package duration; methods
  come from the originating package offer. The review step shows
  "1 package credit will be reserved", "This uses one credit from your
  simulated package." and "No payment will be taken." — no payable
  price. Submission sends ONLY purchase id + start time + method.
  A `no_credit` race (someone else took the final credit) explains
  itself, refreshes the package list and falls back to normal offers.
- **Displays**: rows (Home + Conversations) show "Package credit — no
  payment" instead of a price; the booking detail page replaces the
  Price section with a Package panel whose state comes from
  `get_booking_credit_state` (server ledger flags, never React maths):
  reserved / released ("returned to your package") / used / reserved
  while under review. Ordinary bookings are untouched.
- **Rescheduling**: propose-another-time stays for single-offer bookings
  only; package bookings explain "cancel (the credit returns) and book
  again". No fake offers are ever created.
- **Repository**: `getUsablePackagePurchases(member, companion)` (any
  duration, with methods + remaining), `getPackagePurchase`,
  `getAvailablePackageSlots`.
- **Tests**: `packages2e3b2b.test.tsx` — package option appearance and
  exclusions, purchase-based slot calls, honest review + contract,
  duplicate-click, no-credit recovery, row labels, credit-state labels,
  ordinary bookings unchanged. Live suite: the 2E3B2A block already
  proves the underlying lifecycle; 0010's slot function follows the
  same authorisation as the balance reads.

Deferred after 2E3B2B: payments/payouts, package expiry, admin tooling,
external notifications, verification.
