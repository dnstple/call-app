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

Deferred after 2D: completion confirmations, package credits, payments,
ratings persistence, meeting links, external notifications, verification,
administration.
