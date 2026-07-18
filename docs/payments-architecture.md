# Payments architecture — audit and decisions (Stage 2G)

Latest applied migration confirmed: **0029**. Stripe **test mode only**.

## 1. Existing simulated model (audit)

`package_offers` / `package_purchases` (0008, `is_simulated = true` enforced by CHECK) /
`package_credit_ledger` (0008) / booking credits + reservation-release (0009–0010) /
plan allowance purchases (`allowance_purchase_id`, 0011–0015) / `transactions` (0001, mock
earnings) / completion confirmations (0006) / ratings (0007, 3-unique-reviewer public rule).
All money already uses **integer minor units + explicit GBP**. Bookings snapshot
`price_minor`, `platform_fee_rate`, `platform_fee_minor`, `companion_amount_minor` at request
time — the snapshotting principle is already established and is reused, not reinvented.

**Reused:** bookings lifecycle + snapshots; plan occurrences; completion confirmations
(Companion-side attendance action); ratings tables + 3-reviewer rule; notifications (0023);
system events; RLS helper library (`app_private.*`).
**Superseded for Stripe mode:** `package_credit_ledger` (per-purchase, package-scoped) →
new account-level `credit_ledger`; simulated `transactions` → new earning entries;
`create_simulated_package_purchase` remains mock-mode-only.
**Compatibility strategy:** historical rows keep `is_simulated=true` and are treated as
provider=`simulation`; they are never reconciled against Stripe and never deleted. All new
Stripe-mode records carry `provider='stripe_test'`. Mock mode keeps its fictional flows.

## 2. Chosen Stripe architecture

- **Coordinator = Stripe Customer** (managed Members never touch Stripe). SetupIntent saves
  an off-session payment method; Stripe-hosted surfaces collect card data — the app never
  sees PANs.
- **Recurring billing: application-managed off-session PaymentIntents** (NOT Subscriptions).
  Why safer here: period amounts derive from ACTUAL scheduled occurrences (variable weekly
  counts, pauses, mid-period changes), credit must be applied BEFORE card charge (Stripe
  Subscriptions cannot consume an app-side ledger first), the 10% monthly discount is an
  app-calculated line, and money must allocate to specific occurrences. Subscriptions/
  Schedules would fight all four (invoice-item juggling, proration opacity, no credit-first
  ordering). The app DB stays source of truth for which occurrences are funded; Stripe stays
  source of truth for whether card payment succeeded. Billing-period rows carry unique
  `(plan_id, period_start)` idempotency keys → short months cannot double-charge; the monthly
  anchor is the first-charge date with explicit app-computed calendar periods (29/30/31-safe).
- **Connect: Express accounts, separate charges & transfers.** Platform charges the
  Coordinator; payable earnings batch into weekly `transfers` to the Companion's connected
  account; Stripe payout settings move money to banks. Hosted onboarding links only; status
  from `account.updated` webhooks + server retrieval, never redirects.

## 3. Planned migrations (additive, sequential)

- **0030_stripe_foundation.sql** (this phase): `stripe_customers`, `connected_accounts`
  (skeleton), `payment_orders`, `stripe_webhook_events`, `credit_ledger` +
  `credit_spend_allocations`, `platform_commission_config` (seed: trial 0 / one_off 5 /
  plan 5), `platform_service_fee_config` (seed: GBP, **disabled, zero** — configurable
  engine: fixed/percent/min/max/activation/enabled), server-only RPCs
  (`issue_account_credit`, `spend_account_credit` FIFO-by-expiry with `FOR UPDATE`,
  `get_credit_summary`), RLS (owner-read, zero client writes).
- 0031: trial entitlements (one per pair permanent, 5 fee-free per Member — append-only),
  paid-request workflow states, decline-to-credit, acceptance-to-pending-completion.
- 0032: rating/issue flow replacing customer confirmation; issue holds; 12-hour auto-release.
- 0033: billing periods + renewal engine + failure/retry states.
- 0034: earnings, transfer batches, refunds/disputes, Help/refund requests, credit expiry job.

## 4. Edge Functions

`stripe-payments` (ensure customer / SetupIntent / status — authenticated),
`stripe-webhook` (signature-verified on RAW body; event-id persisted BEFORE side effects;
idempotent), then per-phase: `stripe-connect`, `stripe-billing`, `stripe-transfers`,
`stripe-refunds`. Secrets only in Supabase Function secrets (`STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`) — never VITE_, never the database.

## 5. Webhooks (as phases land)

2G1: `setup_intent.succeeded`, `payment_intent.succeeded`, `payment_intent.payment_failed`,
`payment_intent.canceled`, `checkout.session.completed`. 2G3: `account.updated`.
2G5: (app-managed billing → payment_intent events cover renewals). 2G6: `transfer.created`,
`transfer.reversed`, `payout.paid`, `payout.failed`, `charge.refunded`,
`charge.dispute.created`, `charge.dispute.closed`. No handlers for irrelevant events.

## 6. State machines

Payment order: `pending → requires_action → processing → succeeded | failed | credited →
partially_refunded | refunded | disputed`. Occurrence allocation: `allocated →
pending_completion → payable → transferred` with branches `cancellation_credit_eligible`,
`held_for_issue`, `reversed`, `credited`. Billing period: `draft → payment_pending → paid |
failed → partially_credited → closed`. Booking lifecycle stays separate and coordinated.

## 7. Credit strategy

Append-only `credit_ledger` (credit rows carry `remaining_minor` + 12-month expiry; debit
rows record spends) + `credit_spend_allocations` linking each spend to the specific credit
rows consumed, earliest-expiry-first under `FOR UPDATE` row locks and unique idempotency
keys → no double-spend under concurrency, full audit trail, no mutable balance number.
Order of funds per purchase: subtotal → monthly discount → service fee → credit → card.
Credit-only purchases create a completed internal order and **no** zero-value PaymentIntent.

## 8. Risks / compatibility

Simulated data must never enter Stripe reconciliation (provider flag guards); plan allowance
purchases keep working in mock mode; webhook outage ⇒ orders stay `processing`, reconciled
by `reconcile` retrieval, never confirmed client-side; commission/fee config changes never
rewrite history (per-order snapshots); service-fee amount undecided ⇒ engine ships disabled
at zero (not blocking).
