# Stage 3E-A — companion earnings and payout execution: audit and contract

Branch `stage-3e-companion-payout-execution`, base tag
`stage-3d-payment-reliability-validated` (= `8a7db4d`, migrations 0001–0083
applied to hosted and immutable). Documentation-only commit; no code changed.

## 1. Executive finding

**The Stage 3E target architecture already exists.** It was built additively
across Stages 2G3 (Connect onboarding), 2G4 (completion/issues), 2G6
(earnings, transfers, refunds, disputes, reconciliation), 3B (evidence holds)
and 3C (financial control plane + scoped exactly-once transfer execution),
and one real Stripe test-mode transfer was executed and validated end-to-end
in Stage 3C2-C3 (tag `stage-3c2c3-stripe-test-mode-validated`). The three
authoritative concepts the stage demands — customer payment, companion
earning, Stripe transfer — are already separate tables with separate state
machines, and no success of one implies another anywhere in the code.

Stage 3E therefore is **gap closure + hosted E1–E18 validation**, not a
build. Re-implementing any of it would violate the additive rule and risk the
validated core. No material conflict exists between this stage's requested
model and the repository; where the prompt suggests state names
(`releasable`, `transfer_pending`…), the repository's established terminology
(below) already preserves every required distinction and is retained.

## 2. Current payment and booking finalisation path (Stage 3D, validated)

`create_paid_request` (server prices, credit reserved) → `stripe-payments`
off-session confirm or hosted-Checkout SCA handoff (session recorded as
authoritative funding, 0082/0083) → webhook → `reconcile_payment_order`
(0080–0083: intent/amount/currency/metadata verification, containment) →
`finalize_paid_order` (0043: row-locked, status-guarded, booking created
exactly once, commercial snapshot copied onto the booking row). Verified
hosted: M1–M9 + `pass=18 fail=0`.

## 3. Source of completion truth

Single authority, no competing definition: `conversation_attendance` +
`call_attendance_segments` (0034/0035, LiveKit webhook evidence 0069) →
completion evaluation gated on **accepted, funded** bookings only (0067/0068)
→ `app_private.ensure_companion_earning(booking)` and
`app_private.make_earning_payable(earning)` under the two-signal or
12-hour-no-issue rule (0034 `release_eligible_earnings` for the scheduled
path, 0068 cumulative body). Evidence-informed payout review
holds (0072) sit on top. Ratings/reviews (0034/0071) are evidence, never
mutators of commercial snapshots.

## 4. Existing financial snapshots (immutable, integer minor units, GBP)

- `payment_orders`: subtotal/discount/fee/credit/card/total minor,
  `commission_rate_pct`, `commission_minor` (0030/0031).
- `bookings`: `price_minor`, `platform_fee_rate`, `platform_fee_minor`,
  `companion_amount_minor` — written once by `finalize_paid_order`.
- `platform_commission_config` (0030): trial 0.00%, one_off 5.00%,
  plan 5.00% — matches the stated commercial rules exactly.
- `companion_earnings`: `basis_minor`, `commission_rate_pct`,
  `commission_minor`, `net_minor` copied from the booking snapshot at
  creation; `booking_id UNIQUE` enforces one earning per call.

## 5. Earning ledger (exists)

`companion_earnings` (0034, extended 0046/0067/0068/0072):
state machine `pending_completion → held_for_issue → payable → reversed`,
transfer projection `not_ready → transfer_pending → transferred → reversed`,
`payable_at`, RLS (companion reads own; payer reads safe state; all writes
service-side). Creation is `ensure_companion_earning` — locked, idempotent
(`on conflict (booking_id) do nothing`), gated on a succeeded order (one-off/
trial) **or** a paid plan billing period with ≥1 occurrence (plan calls:
package purchase itself never creates an earning; each completed plan-funded
call creates exactly one). Payment mix (card/credit/mixed) cannot vary the
earning: the net comes from the booking snapshot, not the funding split.

## 6. Stripe Connect scaffolding (exists)

`connected_accounts` (0030): express type, details_submitted,
charges/payouts_enabled, requirements due/past-due, disabled_reason,
last_synced_at; one row per account (PK = account_id), RLS read-own.
Edge `stripe-payments` 2G3 actions: `ensure_connect_account` (test-mode
Express, idempotent), `create_connect_onboarding_link` (Stripe-hosted,
APP_ORIGINS allowlisted), `get_connect_status` /
`refresh_connect_status`; webhook `account.updated` handler with
deduplicated meaningful-change notifications. Companion UI:
`ConnectPanel.tsx` in Settings ("Set up payments" / "Continue setup" /
"Ready to receive earnings" / restricted-reason states; no bank fields
anywhere). No raw connected-account id is exposed to Member/Coordinator APIs.

## 7. Transfer pipeline (exists; exactly-once already proven)

- `companion_transfer_attempts` (0048): claim/finalise/recover RPCs,
  deterministic idempotency, `attempt_id_for_transfer` correlation,
  succeeded/failed_retryable/failed_permanent/reversed finalisers.
- 3C hardening: central execution-context guard (0073), scoped preparation
  (0077 — provider-consumable state only materialised inside an authorised
  run), scoped saga (0078: leases, provider-truth reconciliation, uncertain →
  reconciliation-required, never fail-by-assumption), Edge
  `stripe-transfers` + `scoped-stripe-transfers` adapter, webhook
  `transfer.*` events with signature verification + event-id dedup ledger.
- Financial control plane (0073/0074): per-operation controls
  (`transfer_claim`, `transfer_finalise`, `earning_release`, …, all
  **disabled**), environment gate (`hosted_test`), per-transfer ceiling
  `provider_transfer_amount_ceiling_minor` (currently **0**), guarded
  two-phase runs with confirmation tokens, full audit event trail.
- Hosted proof: Stage 3C2-C3 executed ONE controlled test transfer
  exactly-once (replay idempotent, provider id stable), then re-disabled
  everything. Protected sentinels (earning `71ecc62b…`, attempt `080b51bb…`)
  are asserted unchanged by the Stage 3D verifier.

## 8. Support/admin controls (exist)

`support_admins` + support-authorisation model (0034/0038);
`/support/operations` UI (3C1) with run detail; `support_settlement_overview`
(0048); refund/dispute queues (0052/0056/0061/0062 escalations);
reconciliation findings (0063); pending-paid queue (0080). Post-transfer
customer refund/dispute creates a durable `settlement_adjustments` obligation
(`customer_refund_after_transfer`, `dispute_after_transfer`) — history is
never rewritten; support resolves.

## 9. Paths that complete / cancel / refund / dispute a booking

Complete: attendance evidence + confirmations → `ensure_companion_earning` →
release rule. Cancel: booking lifecycle (2-hour cutoff) → non-payable, no
earning (0067 gates on accepted+funded). Refund: 0052 worker + webhook →
credit-first policy; pre-transfer refund holds/reverses the earning,
post-transfer creates an adjustment. Dispute: 0056/0059 fund-event ordering →
`payment_dispute_earnings` linkage, holds and adjustments. Issues:
`conversation_issues` open state blocks `make_earning_payable`; resolution
outcome (0038/0047) is the single source of truth.

## 10. Gap analysis — the ONLY missing pieces (Stage 3E scope)

| # | Gap | Stage |
|---|-----|-------|
| G1 | **Daily aggregate transfer ceiling** — config has a per-transfer ceiling only | 3E-B (migration 0084) |
| G2 | **Hosted-validation destination allowlist** — scoped runs name earnings, but no explicit connected-account allowlist control | 3E-B (0084) |
| G3 | **Companion earnings UI** — ConnectPanel exists, but no Pending/On-hold/Available/Transferred/Action-required earnings view | 3E-G |
| G4 | Safe **Companion status/earnings read projections** to back G3 (existing RLS reads are row-level; a grouped projection RPC is cleaner) | 3E-C (0084) |
| G5 | **E1–E18 guarded hosted validation tooling + verifier** (`validate-3e-payouts.mjs`) | 3E-H |
| G6 | **Runbook §payouts** + production-blocker list refresh | 3E-G |
| G7 | Regression contracts binding the above + re-run of the Stage 3D verifier (E18) | throughout |

Everything else in the stage specification maps to existing, validated code.
Substages 3E-B/C/D/E/F therefore become *verification + gap items* rather
than new subsystems; each still gets its own commit and focused tests.

## 11. State machines (existing terminology, retained)

EARNING (`companion_earnings.state`):
`pending_completion` →(open issue)→ `held_for_issue` →(resolution)→
`pending_completion` →(two signals, or 12h+no issue; evidence review clear;
via `make_earning_payable`, service-side only)→ `payable`
→(refund/dispute/cancellation rules)→ `reversed`.
Evidence-review holds (0072) gate the `payable` transition orthogonally.

TRANSFER (`companion_transfer_attempts.state` + earning `transfer_state`):
claim (control-gated, run-scoped, leased) → provider create (deterministic
idempotency key; store-before-trust) → `succeeded` | `failed_retryable`
(same identity retry) | `failed_permanent` | `reversed`; ambiguous provider
outcomes → uncertain/reconciliation-required (0078), never guessed. Earning
`transfer_state` is a projection: `not_ready → transfer_pending →
transferred/reversed`. No browser RPC can set any of these states — all
mutators are `app_private`/service-role with the 0073 execution-context guard.

## 12. Idempotency, reconciliation, webhook ownership

Transfers: idempotency key derived from immutable earning identity +
attempt generation (0048/0078); `transfer_group` correlation; webhook
`transfer.created/updated/reversed` deduped by event-id ledger and matched
only through stored identifiers — foreign ids rejected, amount/currency/
destination mismatches → reconciliation-required (0063/0078). Ownership:
customer-payment events belong to Stage 3D reconcile; `account.updated`
belongs to Connect sync; `transfer.*`/`payout.*` belong to the transfer
pipeline. No overlap.

## 13. Rollout controls (existing + 3E additions)

Existing: environment `hosted_test`, all controls disabled, per-transfer
ceiling 0, phrase-gated scoped runs, immutable audit events, live-key refusal
in every operator script. 3E adds (G1/G2): daily aggregate ceiling (default
0) and a destination allowlist (default empty = deny) enforced inside
`authorize_scoped_transfer_create` — additive, fail-closed, no bypass path.

## 14. Test-mode validation plan (E1–E18)

Guarded `scripts/validate-3e-payouts.mjs` (same conventions as the 3D-D
harness: confirmation phrase, sk_live refusal, hosted_test + controls
disabled + ceilings 0 preflight, isolated suffix fixtures, checkpoint ledger,
deterministic `VERIFY RESULT pass=<n> fail=0`). Browser matrix E1–E17 driven
one step at a time with the operator; E18 re-runs the Stage 3D verifier and
asserts `pass=18 fail=0` unchanged. Evidence in gitignored
`3e-*-evidence.local.txt`.

## 15. Production blockers (unchanged + payout-specific)

APP_ORIGINS still `http://localhost:5173` (must become the exact production
origin); live Stripe keys not authorised; Connect platform/business
verification incomplete; production onboarding review pending; transfer +
daily ceilings must be intentionally configured; payout support staffing;
refunds/reversals/negative-balance/tax responsibilities need production
approval. Stage 3E test-mode validation authorises **no** live payout.
