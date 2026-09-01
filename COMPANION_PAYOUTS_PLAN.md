# Turning on real companion payouts — plan

_Status as of 1 Sep 2026. Scoping only — no code changed by this document._

## The short version

Nothing is paying out because **real payouts are deliberately switched off in three places**, not because the system is missing. Most of the machinery (Stripe Connect onboarding, the earnings ledger, the transfer-execution saga, an earnings UI) already exists and runs in **test mode**. Turning on real money is a controlled project: verify companions can actually receive funds, switch to live Stripe, widen two safety gates, and schedule the payout run — with you (not me) holding the live keys and authorising execution.

---

## What already exists (good news)

- **Earnings ledger** — `companion_earnings`. On completion of a *credit-funded* call, `complete_credit_booking` writes a row: `state = 'payable'`, `transfer_state = 'not_ready'`, net = £8.33 − Stripe fee − 15% commission (≈ £4.64). This is working; your first call produced one.
- **Stripe Connect onboarding** — the `stripe-payments` function already supports `ensure_connect_account` and `create_connect_onboarding_link`, backed by the `connected_accounts` table (tracks `details_submitted`, `charges_enabled`, `payouts_enabled`, outstanding requirements). Frontend `ConnectPanel` / `EarningsPanel` exist.
- **Transfer execution** — a careful saga (`begin_scoped_provider_transfer_run` → `scoped-stripe-transfers` → `complete_scoped_provider_transfer_run`) with confirmation tokens, idempotency and livemode verification.

## What's blocking real payouts (deliberate)

1. **Live execution is hard-disabled.** `scoped-stripe-transfers` returns `production_live_execution_not_yet_enabled` and stops whenever the environment is live. Someone gated this on purpose.
2. **The ledger can't hold live money.** `companion_earnings.provider` is constrained to `= 'stripe_test'`. A live earning can't even be stored.
3. **No scheduled payout run for earnings.** The only transfer cron is `settle-plan-transfers` (membership billing), not companion earnings. Companion payouts are currently a manual, admin-triggered saga — nothing sweeps `payable / not_ready` rows into a run.
4. **Companions likely haven't completed Connect onboarding.** Onboarding exists, but until a companion finishes Stripe KYC and links a bank (`payouts_enabled = true`), there is no destination to send money to.

---

## Prerequisites you own (not code)

These are yours and Stripe's, and gate everything below:

1. **A live Stripe account with Connect enabled**, and your platform's Connect/KYC/tax obligations understood (payouts to individuals carry compliance weight).
2. **Live API keys** set in Supabase function secrets (`STRIPE_SECRET_KEY` = live) — I never see or set these.
3. **Each companion completes Connect onboarding** (Stripe KYC + bank details) so `connected_accounts.payouts_enabled = true`. No onboarding → no payout, full stop.
4. **A decision on payout cadence** (e.g. weekly on a fixed day) and **minimum payout threshold**.

## Engineering steps I build (once the above is agreed)

1. **Widen the ledger** — allow `provider = 'stripe'` (live) on `companion_earnings`, and have `complete_credit_booking` stamp live vs test based on environment.
2. **Resolve the destination safely** — the payout run must read the companion's `connected_accounts.stripe_account_id` and refuse any earning whose companion is not `payouts_enabled` (hold it, don't drop it).
3. **Enable live execution** — replace the `production_live_execution_not_yet_enabled` block with the real path, keeping every existing safety check (livemode match, confirmation token, idempotency, lease).
4. **Payout scheduler** — a scheduled job that gathers eligible `payable / not_ready` earnings (past a threshold, companion onboarded) into a transfer run and advances `not_ready → transfer_pending → transferred`, with per-earning failure handling.
5. **Admin visibility** — surface owed/paid totals and any held earnings (missing onboarding, requirements past due) so you can see who's blocked.

## The £4.64 from your first call

That earning is stamped `stripe_test`, so it will **not** auto-convert to live. Once live payouts exist, that delivered call should still be paid — either re-issued as a live earning or paid once manually. Flag it so it isn't lost.

---

## Readiness check — run this first

See whether the companion(s) can actually receive money yet:

```sql
select p.first_name,
       ca.stripe_account_id is not null as has_connect_account,
       ca.details_submitted,
       ca.payouts_enabled,
       ca.requirements_past_due
  from public.profiles p
  join public.profile_access pa on pa.profile_id = p.id and pa.access_role = 'owner'
  left join public.connected_accounts ca on ca.account_id = pa.account_id
 where p.id = 'COMPANION_PROFILE_ID';
```

If `payouts_enabled` is false/null, onboarding is the first real task — everything else is blocked on it.

## Honest cautions

- **I can build the mechanism; I cannot move the money.** Setting live keys, finishing Connect onboarding, and authorising real transfers are yours to do.
- **This is real money + compliance.** I'd enable it behind a flag, test with a single small live transfer to one onboarded companion, and only then open it up.
- **Don't remove the live-execution guard casually** — it's the last safety net. It should come out as part of a deliberate, tested switch-on, not a quick edit.
