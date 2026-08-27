# Apricoti — Membership Restructure: Implementation Scope

**Status:** Ready for implementation, with **Open Decision #1 (billing cadence)** to be resolved first — it changes the Stripe design.
**Positioning:** Companionship and regular conversations to discuss whatever you'd like. Member↔Companion calls are the core product. The word **"therapy" must not appear anywhere** (code, copy, legal, marketing, DB seed data, alt text).

---

## 1. Summary of the new model

- Membership is a **subscription that buys call credits**. **1 credit = one 45-minute call.** 45 minutes is the only standard call length across the entire site.
- Every new member starts with a **£25 starter week = 3 credits**. The monthly subscription begins **7 days later** and releases **3 credits every 7 days**.
- **Credits expire 3 months after they are issued.** The member is told this explicitly during signup and in their signed agreement.
- **Extra credits** can be bought at **£8.33 each, no limit.**
- **Companions no longer set prices.** Each completed call pays the companion the **£8.33 allocation minus Stripe/payment fees minus Apricoti's 15% commission** (commission taken after Stripe fees), paid out via the existing Stripe Connect transfer pipeline. There is **no service fee beyond Stripe fees + the 15% commission.**
- **Cancellation** stops renewal; weekly credits continue until the paid-through date; issued credits stay usable until their own 3-month expiry.
- **Failed payment** pauses new credit release while Stripe retries; existing credits remain usable.

---

## 2. OPEN DECISION #1 — billing cadence vs credit math (resolve before Stripe work)

The stated model has an internal tension that must be resolved because calendar months are not multiples of 7 days:

- Fixed truths the user wants: **£8.33 per credit**, **3 credits per 7-day week**, **charge reflects the length of the month**.
- The recorded monthly table is £25 × (days ÷ 7): 28d £100.00 · 29d £103.57 · 30d £107.14 · 31d £110.71.
- Problem: at £8.33/credit, £110.71 = 13.29 credits — not a whole number, and "3 every 7 days" yields 12 credits in 28 days but an ambiguous count in 29–31 days.

**Recommended resolution (A): 4-weekly billing.** Bill **£100 every 28 days for 12 credits** (Stripe interval = week ×4, or day ×28). This makes every number exact and consistent (£8.33 × 12 = £100, 3/week, 12/period), is a standard Stripe cadence, and still "feels monthly." The £25 starter week precedes it.

**Alternative (B): true calendar-month, variable charge.** Charge £25 × (days ÷ 7) per calendar period and release 3 credits at each 7-day anchor that falls inside the period (so a member receives 12–15 credits depending on the period). Accept that £/credit drifts slightly from £8.33. More faithful to "length of the month," materially more complex in Stripe (proration + variable invoice each period) and in the credit-accrual job.

**Action:** pick A or B. The rest of this scope is written to work with either, but Stripe subscription setup (§4) and the accrual job (§5) differ.

---

## 3. Global copy & terminology changes

- Purge **"therapy"** everywhere. Grep `therap` across `src/`, `supabase/`, `docs/`, legal content, landing content, email templates, and any DB seed inserts; replace with companionship/conversation language.
- Standardise call length to **45 minutes** in all copy, defaults, and validation. Remove references to 15/30/60-minute calls.
- Replace "price / rate" language on companion-facing surfaces with the membership/credits model.

---

## 4. Payments & Stripe architecture

**Customer & payer.** The **payer's Stripe customer** is the account that owns the membership: a self-serve **Member**, or a **Coordinator** paying for their one managed Member (§10). Companions keep their existing **Connect** accounts for payouts — unchanged.

**Starter week + subscription.**
- Charge **£25 now** for the starter week (one-off PaymentIntent or the subscription's first invoice), issuing **3 credits immediately**.
- The recurring subscription's **first billing date is 7 days after signup** (`billing_cycle_anchor` / `trial_end` = now + 7 days). Under Resolution A the recurring price is £100 / 28 days; under B it's a metered/variable calendar-month price.
- Store `stripe_customer_id`, `stripe_subscription_id`, `current_period_start/end`, `status`, `paid_through_at`, `cancel_at_period_end` on a new `memberships` table (§12).

**Credit release.** Do **not** rely on Stripe to issue credits directly. Issue credits from **our** side:
- Starter 3 credits on successful starter payment.
- Then **3 credits per 7-day cycle** via a scheduled job (§13) keyed off the membership anchor date, gated on the subscription being active/paid.
- Webhooks (`invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated/deleted`) update membership status and pause/resume accrual.

**Money flow / hold.** Subscription revenue lands in the **platform balance**. Companion payouts are **decoupled** from money-in: each **completed** call creates a companion earning of `£8.33 − Stripe fee share − 15% commission`, released to the companion through the existing `claim_payable_transfers` → `stripe-transfers` pipeline. Define the "Stripe fee share" per call (recommend a fixed modelled per-credit fee, since fees are charged at the subscription-invoice level, not per call) — **Open Decision #2**.

---

## 5. Credit ledger & expiry

Existing `issue_account_credit` / `spend_account_credit` (0030) is money-credit, not call-credits with per-unit expiry. Add a dedicated **call-credit ledger**:

- `call_credits`: `id, account_id (holder), member_profile_id, source ('starter'|'weekly'|'extra'|'admin'), issued_at, expires_at (= issued_at + 3 months), consumed_at, consumed_booking_id, status ('active'|'consumed'|'expired'|'refunded')`.
- Booking a call **reserves/consumes the oldest active, non-expired credit** (FIFO by `expires_at`).
- A daily job marks past-expiry active credits as `expired`.
- Refund path (member no-show handling, admin discretion) can set a consumed credit back to `active`/`refunded` per §7.
- Balance = count of `active` credits with `expires_at > now()`.

Surface remaining credits + **next expiry date** prominently in the member dashboard.

---

## 6. Companion payout model

- Remove companion-set pricing entirely (delete/deprecate `conversation_offers`, the £5 trial, `member_free_trials` free-first-trial, and the Availability & rates pricing UI).
- On **call completion**, create a `companion_earnings` row: gross allocation **£8.33 (833 minor)**, minus modelled Stripe fee share, minus **15%** Apricoti commission → companion net. Reuse the existing earnings + transfer machinery (`ensure_companion_earning`, `claim_payable_transfers`, `stripe-transfers`), repointed to the per-credit allocation instead of a booking price.
- **No payout** to a companion whose call was taken over by an admin (§7): no earning row is created; Apricoti retains the £8.33.

---

## 7. Booking, companion confirmation & admin fallback

**Booking is instant and guaranteed.** When a member picks an available slot and spends a credit, the booking is immediately **`booked`** — no companion acceptance step. The credit is reserved at booking time.

**Companion confirmation deadline.** The companion must **confirm** the call **at least 20 minutes before the scheduled start**. If it is still unconfirmed at `start − 20min`, it **auto-transfers to an admin** (first-available routing, below).

**Confirmed no-show.** If the companion confirmed but does **not join** at start time, after a short grace (**~2 minutes past start**) it **also transfers to an admin**. The member always gets their call.

**Admin fallback routing.** On transfer, **alert all available admins; the first to accept takes the call.** (Needs an admin availability/"on-call" concept and an accept action.)

**Effect on credit & payout.** When an admin delivers the call, the **member's credit is consumed** (they received their call) and the **absent companion earns nothing**; Apricoti retains the £8.33.

**Status model.** Extend `bookings.status` (or add a parallel state machine): `booked → companion_confirmed → completed`, with `admin_fallback` (unconfirmed-at-T-20 or confirmed-no-show) and `cancelled`. Add `confirmed_at`, `confirmed_by`, `fallback_at`, `handled_by_admin_id`, `confirmation_deadline_at (= starts_at − 20min)`.

**Jobs (§13):** a frequent scheduler evaluates (a) bookings past their confirmation deadline that are still unconfirmed, and (b) confirmed bookings ~2 min past start with no companion join, and triggers admin fallback + notifications.

---

## 8. Explore ranking (admin-controlled, 1–5)

- Add `companion_profiles.explore_rank smallint not null default 1 check (explore_rank between 1 and 5)`.
- **5 = top of Explore, 1 = default/bottom.** Rank is the **primary sort** in `discoverable_companions` / recommendations; **within the same rank, keep the current ordering** (photo/bio/recency as today).
- **Admin-only:** the rank is invisible to members and companions. Add a support RPC `admin_set_companion_rank(profile, rank, reason)` (audited) and a control in the internal console (Pilot access drawer, companion section) — a 1–5 selector.
- Update `discoverable_companions` and `recommended_companions_for_member` to `order by explore_rank desc, <existing order>`.
- Note: future automated ranking — keep the column as the interface so the source can change later.

---

## 9. Phone verification (UK mobile, OTP)

- **Mandatory** UK-only mobile verification **before completing onboarding** for all **new** Members, Coordinators and Companions.
- **Existing users are not blocked** — show a **persistent, dismissible** "verify your number" prompt on their dashboard until verified.
- **Mechanism:** Supabase phone OTP (SMS), **provider chosen at build time** (Twilio is the likely pick; scope it provider-agnostic behind one integration point). **Not** Stripe (Stripe can collect a number but does not verify ownership; Stripe Identity's phone-only check is invite-only).
- **Data:** `phone_e164`, `phone_verified boolean`, `phone_verified_at`, and a verification-attempt record; enforce UK numbers (`+44`) at validation.
- **Usage & consent:** verified number is used for account security + essential booking/call alerts. **Optional SMS reminders require separate opt-in.** Verification is **not** treated as marketing consent.

---

## 10. Signup & landing restructure

- **Homepage:** the most prominent CTAs lead **directly into Member onboarding** (e.g. "Start your first week — £25"). "Become a companion" remains available in the nav and at the very start of the membership flow (so a visitor can switch).
- **No role question at the start of the member flow.** Coordinators reach their flow via a **separate, less-prominent link**. Each flow lets you **switch to the other at its start**.
- **Coordinator** manages **one Member** and **pays for that Member's membership** (coordinator is the Stripe payer for one member profile).
- Three distinct onboarding flows: **Member**, **Coordinator (one managed member)**, **Companion**.
- Member/Coordinator flows must present the credit model, the **£25 starter → monthly**, and the **3-month credit expiry** clearly before payment, and end with the signed agreement (§11) and phone verification (§9).

---

## 11. Role-specific signable agreements

- **Three separate agreements:** Member, Coordinator, Companion. Each is a **long document the user scrolls to the end of**, then signs by pressing a single **"I agree and sign"** button (no typed name, no drawn signature).
- On signing, store: **agreement version, full document snapshot, signer account, role, timestamp, and the phone-verification record.** Extend the existing `membership_agreements` (0140) approach to be role-scoped and per-version.
- Member/Coordinator agreements must state the credits model, billing, cancellation, and **3-month credit expiry**. Companion agreement reflects fixed per-call allocation (no self-pricing) and the confirmation/fallback rules.
- Gate onboarding completion on the relevant agreement being signed (as the current agreement gate does, but role-specific).

---

## 12. Data model changes (new/changed tables & columns)

New:
- `memberships` (subscription state per member: stripe ids, status, period, paid_through, cancel_at_period_end, anchor date).
- `call_credits` (per-credit ledger with 3-month expiry — §5).
- Phone fields + verification records (§9).
- `admin_availability` / on-call concept for fallback acceptance (§7).

Changed:
- `companion_profiles`: `+ explore_rank`.
- `bookings`: `+ confirmation_deadline_at, confirmed_at, confirmed_by, fallback_at, handled_by_admin_id`; new statuses; `duration_minutes` fixed at 45; remove reliance on `offer_id`/price snapshots for money (keep columns for history, stop writing new pricing).
- `profiles`/`accounts`: phone verification columns.
- `membership_agreements`: role + version + snapshot.

Views/functions:
- `discoverable_companions`, `recommended_companions_for_member`: sort by `explore_rank desc`.
- Earnings creation repointed to the £8.33 per-credit allocation (§6).

---

## 13. Scheduled jobs / edge functions

- **Credit accrual** (per membership anchor): release 3 credits per 7-day cycle when active/paid.
- **Credit expiry** (daily): expire credits past 3 months.
- **Booking confirmation sweep** (every 1–2 min): transfer unconfirmed-at-`start−20min` and confirmed-no-show-at-`start+2min` bookings to admin fallback; notify admins/members.
- **Stripe webhooks**: `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated/deleted` → membership status + accrual pause/resume.
- **SMS OTP** send/verify integration (provider-agnostic).
- Existing payout worker (`stripe-transfers`) reused for companion earnings.

Follow the existing pg_cron + pg_net + Vault-secret pattern used by the payout/plan jobs.

---

## 14. Admin console additions

- **Companion rank 1–5 control** (admin-only) in the Pilot access drawer.
- **Admin call fallback**: a place to see/accept calls that transferred to admin (first-available accept), plus visibility of confirmation/fallback state on bookings.
- Membership/credit visibility per member (credits remaining, next expiry, subscription status).
- The new **Bookings** console already exists; extend it with kind = credit call, confirmation/fallback status, and credit consumed.

---

## 15. Removals / deprecations

- **£5 trial**, **free-first-trial** (`member_free_trials`, 0141), **companion-set offers/pricing** (`conversation_offers` + Availability & rates pricing UI), and call durations **15/30/60**.
- **£5 referral reward** is already retired (0158) — keep the "invite people you know and earn from calls" framing, now consistent with the credit model.
- Any "therapy" language.

---

## 16. Open decisions to confirm

1. **Billing cadence vs credit math** — Resolution A (4-weekly £100/12 credits, exact) vs B (variable calendar-month). *Blocks Stripe design.*
2. **Per-call Stripe fee share** — since Stripe fees are charged at the subscription-invoice level, define the modelled fee deducted per £8.33 call before the 15% commission (e.g. a fixed pence figure, or commission on gross with fees absorbed by platform).
3. **Membership vs pilot access** — how `memberships`/subscription status relates to the existing `account_access` (pilot/full) gating: does an active membership grant product access directly, or remain separate?
4. **Existing members migration** — how current bookings/credits/accounts map into the new credit model at cutover.
5. **SMS provider** — Twilio vs other (deferred to build).
6. **Admin as a "companion" for fallback calls** — do admins need Connect/earnings, or do fallback calls simply pay nothing out (current assumption: nothing out).

---

## 17. Suggested build sequencing (phases)

1. **Foundations:** terminology purge ("therapy"), 45-min standardisation, `explore_rank` + admin control (small, high-value, low-risk).
2. **Credit ledger + membership tables** (no Stripe yet): `call_credits`, `memberships`, balances, expiry job, dashboard display.
3. **Stripe subscription + starter week** (after Open Decision #1): payment, webhooks, accrual job.
4. **Booking confirmation + admin fallback** state machine and sweep jobs.
5. **Companion payout repoint** to per-credit allocation (15% commission).
6. **Signup/landing restructure** + role-specific agreements + phone verification.
7. **Removals:** trial, offers, pricing UI, free-first-trial.
8. **Admin console** fallback + membership/credit visibility.

Each phase should ship behind its own migration(s) and tests, following the repo's existing conventions (audited RPCs, RLS on every table, `search_path=''`, service-role-gated internal functions, no weakening of tests).
