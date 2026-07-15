# Architecture note — moving beyond Stage 1

## How the prototype is structured for replacement

The UI never talks to storage directly. Components call functions in `src/state/actions.ts`
(writes) and `src/state/selectors.ts` (reads); those functions call pure business rules in
`src/domain/*` and persist through a single localStorage-backed store (`src/state/store.ts`).

That gives three clean seams for Stage 2+:

1. **Storage seam.** Replace the body of `store.ts` persistence and each action in `actions.ts`
   with API/Supabase calls. Function signatures — `requestBooking(input)`, `recordOutcome(...)`,
   `submitRating(...)`, `purchasePackage(...)` — are already shaped like backend endpoints, so the
   pages and components don’t change. Treat `types.ts` as the draft backend contract: entities map
   1-to-1 to tables (users, profiles, managed_relationships, availability_rules/exceptions,
   package_offers/purchases, bookings, completion_confirmations, ratings, notifications,
   reports, transactions).

2. **Business-rule seam.** Everything in `src/domain/` is pure and unit-tested (36 tests). In
   production these rules must run **server-side** (booking locks, package balances, completion
   state, commission) — port them as-is; the tests come along as the spec. Do not trust browser
   state for money or status transitions.

3. **Config seam.** Commission percentages, trial duration, recommended trial price and reminder
   timing live in `PlatformConfig` (seeded in `data/seed.ts`), not in components. In Stage 2 this
   becomes an admin-editable platform settings record.

## Supabase mapping (Stage 2)

- Auth: Supabase Auth with a `role` claim; row-level security policies per entity
  (e.g. bookings visible to member/companion/coordinator on the row; ratings public-read for
  active rows; private feedback restricted).
- The prototype's `switchIdentity()` role switcher disappears — session identity comes from auth.
- Booking slot locking: a Postgres unique/exclusion constraint on (companion_id, tstzrange) plus
  a transactional insert replaces the client-side `hasConflict` check (keep the client check for UX).
- Notifications table + Realtime subscription replaces the mock notify() calls; a background
  worker (cron/queue) generates the 24h/1h reminders and completion prompts that the prototype
  fakes with seeded data.

## Payments (Stage 4)

Isolate behind an adapter: `createCheckout(offer, buyer)`, `refund(txn)`, `payout(companion)`.
Use a marketplace-capable provider with connected accounts (e.g. Stripe Connect): platform
collects gross, retains the configured commission (0% trial / 2% standard — already computed by
`domain/commission.ts`), pays out on **completed** conversations only. `needs_review` bookings
pause payout — the reconciliation logic in `domain/bookings.ts` already produces that state.
Never store card details; keep the existing simulated `transactions` ledger shape as the internal
ledger.

## Trust & safety before any pilot (Stage 3)

The UI already renders consent status, report/block, verification badges and boundary copy —
they are placeholders. Before real users: real identity checks and Companion approval, a staffed
moderation queue behind `reports`, documented consent for Coordinator-managed accounts, audit
trails on booking changes (the `history` array becomes an append-only audit table), and privacy
policy/terms. The "verified demo" badge wording must never appear in production.
