# Stage 3D-A — customer payment lifecycle audit and exactly-once design

Source audit on branch `stage-3d-payment-reliability`, base tag
`stage-3c2c3-stripe-test-mode-validated` (migrations 0001–0079 applied and
immutable). Documentation-only: no code, migration, test, secret, provider
object or hosted state was changed. Companion payout transfers (Stage 3C2)
are complete, untouched and out of scope.

## 1. Executive summary

The customer payment architecture is **server-confirmed**: the browser never
loads Stripe.js (no `@stripe/stripe-js` or React Stripe packages exist in
`package.json`; the Stripe SDK appears only inside Deno Edge Functions).
`create_paid_request` (SQL, 0031/0042) snapshots server-side prices and
reserves credit; the `stripe-payments` Edge Function confirms a PaymentIntent
**off-session** against the saved default card; when Stripe demands
authentication it falls back to a **Stripe-hosted Checkout Session** opened
via `window.location.href`. Webhooks are authoritative and
`finalize_paid_order` (0043) is an idempotent, row-locked, single-transaction
finaliser that creates the booking exactly once. **The exactly-once financial
core is sound.** Both observed defects live at the edges:

- **Missing bank handoff** — the hosted-authentication URL is produced only on
  the *thrown* `authentication_required` path. A confirmed intent that
  *returns* `status: 'requires_action'` reaches the client as
  `{state:'requires_action'}` **without a URL**, and both wizards require
  `result.url` before redirecting — so the customer sees a spinner, then a
  silent stall. Separately, **nothing reads the return parameters**: the
  Checkout `success_url`/`cancel_url` land on `/#/conversations?payment=…`
  (one-offs/trials) and `/#/conversations?billing=…` (plan periods) which no
  component parses — after authenticating at the bank, the customer gets no
  resumption, no confirmation, no distinction from cancellation. (Contrast:
  the card-*setup* return `settings?setup=…` **is** read —
  `BillingPanel.tsx` l.44-49 — proving the pattern exists but was never
  applied to payments.)
- **Paid but stuck pending** — client confirmation state lives only in the
  open wizard component: a bounded ~30 s poll, no persisted payment session,
  no timeout message, no "Check payment status" action, no recovery surface.
  If the webhook is slower than the poll, the user reloads, or payment
  completes on the hosted page, Stripe has the money and the order finalises
  whenever the webhook lands — while the customer sees pending or nothing.

Stage 3D is an **extension, not a rewrite**: keep server confirmation +
webhook authority + idempotent finalisation; add a uniform requires-action
path, a real payment return/resume route, a durable customer-status
projection, bounded honest polling, a server-side status/recovery action, and
support visibility.

## 2. Observed defects

1. Required bank authentication does not always present a clear handoff
   (banking app / browser / 3DS page).
2. Stripe takes the payment while the app remains loading and never confirms
   the booking.

Both reproduce from source (§6). Neither involves Companion transfers.

## 3. Current architecture (text diagram)

```
Coordinator browser (no Stripe.js anywhere)
│ SupabaseBookingWizard / TestCallWizard
│   └─ billingRepository.createPaidRequest()
│        └─ Edge stripe-payments action=create_paid_request
│             ├─ RPC create_paid_request        [server prices; credit reserved
│             │    ('spend-<order>'); order 'pending'; idempotent by
│             │    payment_orders.idempotency_key; expires_at = now()+30min]
│             ├─ credit-only → RPC finalises atomically → 'succeeded'
│             ├─ stripe.paymentIntents.create({amount: order.card_amount_minor,
│             │    off_session:true, confirm:true, payment_method: saved default,
│             │    metadata.payment_order_id}, {idempotencyKey:'order-<id>'})
│             │    ├─ returned intent → respond {state: intent.status}  ← DEFECT 1a
│             │    ├─ throws authentication_required →
│             │    │    checkout.sessions.create(payment mode, card shortfall,
│             │    │      metadata.payment_order_id,
│             │    │      success_url /#/conversations?payment=success,   ← DEFECT 1b
│             │    │      {idempotencyKey:'order-session-<id>'})
│             │    │    → respond {state:'requires_action', url}
│             │    └─ other error → finalize_paid_order(order,'failed')
│             └─ browser: url → window.location.href; else poll
│                getPaymentOrderState(order) 20×1.5s              ← DEFECT 2
│
│ PlanBillingPreviewCard → planBillingRepository.completePlanBillingPeriod()
│   └─ Edge stripe-billing action=complete_period → hosted Checkout
│        success_url /#/conversations?billing=success              ← DEFECT 1b'
│ (cron 0044 → stripe-billing action=charge_due: off-session plan charges;
│  failure → period 'action_required' → the card above is the retry surface)
│
Stripe ── webhooks ──► Edge stripe-webhook
  constructEventAsync(rawBody, signature, secret) (l.58)
  → stripe_webhook_events ledger upsert (l.81; duplicate → {duplicate:true} l.93)
  → checkout.session.completed (l.124) / payment_intent.succeeded (l.139) /
    payment_intent.payment_failed + payment_intent.canceled (l.150-151)
  → finalize_paid_order(metadata.payment_order_id, outcome)
     [0043: SELECT … FOR UPDATE on order (+ plan period); status-guarded;
      booking INSERT exactly once on success (l.217-231); credit released
      exactly once ('release-<order>') on failure]
```

## 4. Source-file and symbol inventory

- `supabase/functions/stripe-payments/index.ts` — `quote_paid_request`
  (l.180); `create_paid_request` (l.188-260): RPC call, credit-only
  short-circuit (l.198), off-session confirm (l.208-220, key
  `order-<order_id>`), `authentication_required` catch → Checkout fallback
  (l.223-249; key `order-session-<order_id>`; `APP_ORIGINS` allow-list with
  `http://localhost:5173` fallback l.227-231; URLs l.244-245), decline →
  `finalize_paid_order('failed')` (l.255); card-setup session (l.121-122).
- `supabase/functions/stripe-webhook/index.ts` — signature check l.58; event
  ledger l.81/334/339; handlers: `setup_intent.succeeded` l.100,
  `checkout.session.completed` l.124, `payment_intent.succeeded` l.139,
  `payment_intent.payment_failed`/`payment_intent.canceled` l.150-151,
  `account.updated` l.167, plus 2G6 `transfer.*`, `refund.*`,
  `charge.dispute.*`. **No `payment_intent.processing` or
  `payment_intent.requires_action` handler.**
- `supabase/functions/stripe-billing/index.ts` — `charge_due` (l.70,
  cron-invoked off-session plan charges), `complete_period` (l.139, hosted
  Checkout; URLs l.180-181).
- `src/repositories/billingRepository.ts` — `quotePaidRequest` (l.77),
  `createPaidRequest` (l.107), `getPaymentOrderState` (l.128, safe polling
  projection), `createSetupSession`, `getCreditSummary`.
- `src/repositories/planBillingRepository.ts` — `activatePlanBilling` (l.84),
  `completePlanBillingPeriod` (l.161 → `{url}` → caller redirects).
- `src/components/SupabaseBookingWizard.tsx` — payment state machine
  l.202-263 (`payState`: null / `payment_method_required` / `redirecting` /
  `confirming` / `succeeded`); redirect condition `state ===
  'requires_action' && result.url` (l.231); poll 20×1.5 s (l.242-259);
  `submitting` double-click guard; idempotency ref
  `req-<member>-<offer>-<startsAt>`.
- `src/components/TestCallWizard.tsx` — same machine l.109-153 (redirect
  condition l.132-133).
- `src/components/PlanBillingPreviewCard.tsx` — plan-period pay action.
- `src/components/BillingPanel.tsx` — card setup; **reads `setup=` return
  params** (l.44-49).
- SQL: `create_paid_request` (0031 l.152-234 + 0042 funding-mode),
  `finalize_paid_order` (0043 — two-arm finaliser, l.53/58 `FOR UPDATE`,
  booking insert l.217-231, release l.154/241), `payment_orders`
  (0030 l.47-83 + 0031 l.21-40), `stripe_webhook_events` (0030),
  `plan_billing_periods` (0040), credit ledger + `spend-`/`release-` keys
  (0030/0031), one-trial-per-pair partial unique (0031 l.37-40).

## 5. Payment flow by purchase type

| Flow | Exists? | Path | Provider objects |
|---|---|---|---|
| Trial conversation | yes | TestCallWizard → `create_paid_request` (`order_type='trial'`) | off-session PI, Checkout fallback |
| Single paid conversation | yes | SupabaseBookingWizard → same (`'one_off'`) | same |
| Package purchase | **retired** | packages folded into plans (Stage 2E4); no `order_type` for packages; `package_purchases` rows are created only as plan allowances at settlement (0076 chain) | none customer-facing |
| Recurring plan initial purchase | yes (indirect) | plan acceptance → `activatePlanBilling` → period `payment_pending` → cron `charge_due` off-session; no interactive first payment | off-session PI |
| Plan renewal | yes | monthly period via cron `charge_due`; scoped support renewal via 0076 (`renew_plan_billing_period`) stops at `payment_pending` for card | off-session PI |
| Plan-period customer completion (SCA/failed retry) | yes | PlanBillingPreviewCard → `complete_period` → hosted Checkout | Checkout Session |
| Credit-only booking | yes | `create_paid_request` short-circuit: order `'succeeded'` inside the RPC, no Stripe object | none |
| Mixed credit + card | yes | credit reserved at creation; PI amount = `card_amount_minor`; check `credit_applied_minor + card_amount_minor = total_minor` (0030 l.76) | PI for shortfall |
| Coordinator booking for Member | yes | payer is the Coordinator (`payment_orders.coordinator_account_id`); wizard hosted from Conversations / ProfileDetail / CompanionPlanHero / BookingDetail | as above |
| Member booking directly | no | booking creation surfaces are Coordinator-scoped; Members have no pay surface | — |
| Payment retry | partial | same wizard resubmission; RPC idempotency returns the same order while unexpired (30 min) | same PI via `order-<id>` key |
| Payment return/resume route | **missing** | `payment=`/`billing=` params written by Edge URLs, read by nothing | — |

## 6. Confirmed defects

1. **`requires_action` returned without a URL** — `stripe-payments` l.220
   responds `{state: intent.status}` for any *returned* intent; the Checkout
   fallback exists only in the `authentication_required` **catch** (l.223).
   Client gates on `result.url` (`SupabaseBookingWizard` l.231,
   `TestCallWizard` l.132-133) → no redirect → poll → stall. Root cause of
   defect 1 for every SCA shape that returns rather than throws.
2. **No payment return handling** — repo-wide: nothing parses
   `payment=success|cancelled` or `billing=success|cancelled`
   (`Conversations.tsx` reads neither). After hosted authentication the
   customer lands unannounced on Conversations; cancel and success are
   indistinguishable. (`BillingPanel` l.44-49 handles the analogous `setup=`
   return, so the gap is payments-specific.)
3. **No durable client payment session** — `payState`/poll live in component
   state; nothing persists `orderId` (no storage write anywhere in the flow);
   reload/unmount/redirect destroys all knowledge of the in-flight payment.
4. **Poll gives up silently** — 20×1.5 s (wizard l.242-259) then leaves
   `payState 'confirming'` forever: no timeout state, no "Check payment
   status", no reconciliation message. Root cause of defect 2's UX.
5. **`payment_intent.processing` unhandled** — webhook has no `processing`
   case, and the client has no `processing` representation; a
   bank-debit-style delay surfaces as the silent stall above.

## 7. Likely defects

1. **`APP_ORIGINS` fallback** — unset/unmatched origin silently falls back to
   `http://localhost:5173` (stripe-payments l.227-231): a misconfigured
   secret would return authenticated customers to localhost.
2. **Orphaned unconfirmed PaymentIntent** — when the direct confirm throws
   `authentication_required`, the unconfirmed PI (key `order-<id>`) remains
   while the Checkout Session creates a second PI. Finalisation is keyed by
   `metadata.payment_order_id` and `stripe_payment_intent_id` is unique, so
   no double settle — but the stale PI id may already sit on the order row
   and be **overwritten** by the session's PI on
   `checkout.session.completed`; cosmetic at Stripe, and an audit-trail
   wrinkle locally.
3. **Ambiguous failure copy invites retry** — Edge/network timeout after
   Stripe accepted shows the generic failure toast; idempotency keys make a
   retry financially safe, but the customer is told to "try again" while
   possibly already charged.
4. **Order expiry vs late success** — `expires_at = now()+30 min` (0031
   l.194): a customer completing hosted authentication after 30 min produces
   a webhook for an order the RPC-side would consider expired;
   `finalize_paid_order` has no expiry guard on the success arm, so it would
   still finalise — needs an explicit decision + test in 3D-B (current
   behaviour is *probably* correct-by-accident).

## 8. Unknowns requiring hosted reproduction

1. Actual `APP_ORIGINS` secret value (production + staging correctness).
2. Webhook endpoint health/retry posture; whether
   `payment_intent.processing`/`requires_action` events are subscribed at the
   Dashboard level.
3. Whether any real orders sit provider-succeeded/locally-pending (read-only
   hosted query in 3D-D gate 0).
4. Mobile banking-app return behaviour with the HashRouter URLs (Checkout
   redirects to `…/#/conversations?...` — hash fragments survive Stripe's
   redirect, but the mobile round trip needs a device test).
5. Which SCA shapes the live account actually produces for off-session
   confirms (returned `requires_action` vs thrown `authentication_required`)
   — drives 3D-D's test-card matrix.

## 9. Current payment-state inventory

- **Stripe PaymentIntent**: `requires_payment_method`, `requires_confirmation`,
  `requires_action`, `processing`, `requires_capture` (unused), `canceled`,
  `succeeded` (provider vocabulary).
- **payment_orders.status** (0031): `pending`, `requires_action`,
  `processing`, `succeeded`, `failed`, `expired`, `credited`,
  `partially_refunded`, `refunded`, `disputed`.
- **bookings.status** (0005): `pending`, `accepted`, `rejected`, `expired`
  (+ later lifecycle states); booking exists only after success.
- **plan_billing_periods.status** (0040): `draft`, `preview`,
  `payment_pending`, `processing`, `paid`, `payment_failed`,
  `action_required`, `partially_credited`, `closed`.
- **package_purchases**: plan-allowance records only (granted at settlement).
- **Credit ledger**: append-only entries keyed `spend-<order>` /
  `release-<order>` (state is the sum, not a status column).
- **Frontend `payState`** (both wizards): `null`, `payment_method_required`,
  `redirecting`, `confirming`, `succeeded`.

Mapping to the intended customer-facing vocabulary:

| Intended state | Today |
|---|---|
| awaiting payment method | `payment_method_required` (client-only) |
| awaiting bank authentication | **gap** — `requires_action` exists on the order but the client shows only `redirecting`, and only when a URL arrived |
| processing | **gap** — order has `processing`; client never renders it |
| payment received, confirming booking | **gap** — indistinguishable from `confirming` |
| completed | `succeeded` (order) + booking row |
| failed | `failed` (order); client generic error |
| cancelled | **gap** — `payment_intent.canceled` folds into `failed`; hosted-page cancel is invisible |
| reconciliation required | **gap** — no state, no surface |

Ambiguities: client `confirming` conflates five provider situations; `expired`
never reaches the client; impossible transition *observed in code*: none —
0043's status guards prevent regressions (terminal states re-assert
idempotently, l.63-92).

## 10. Exactly-once failure matrix

| # | Scenario | Current behaviour | Safety risk | Target behaviour | Mechanism | Test |
|---|---|---|---|---|---|---|
| A | Browser succeeds, webhook late | poll may catch `succeeded`; else silent stall (§6.4) | UX only | explicit "payment received, confirming" then delayed-state | durable projection + bounded poll | scratch-PG + hosted drill |
| B | Webhook first, browser awaiting | poll reads `succeeded` → fine | none | unchanged | existing | unit poll test |
| C | Stripe succeeds, browser request times out | generic failure toast; webhook still finalises | **customer may retry/panic**; money safe (`order-<id>` key) | honest "checking payment status" + status call | status RPC + retry-same-key | Edge contract + hosted |
| D | Stripe succeeds, local finalisation throws | webhook retries; finaliser idempotent | low | + reconciliation surface if retries exhaust | webhook retry + support queue | scratch-PG fault injection |
| E | Stripe succeeds, user closes page | order finalises silently; user uninformed | UX | resume card on next visit | persisted session + status RPC | unit + manual |
| F | Reload during `requires_action` | all state lost; no way back to the bank URL | **customer cannot pay** | resume: re-fetch state, re-offer authentication link | durable session + return route | unit + hosted SCA |
| G | Reload during `processing` | state lost; booking appears later | UX | status restoration on load | same | unit |
| H | Bank-app authentication returns later | return params unread (§6.2) | **primary defect** | return route confirms/resumes | `/payment/return` route | hosted SCA + mobile manual |
| I | Webhook delivered twice | `stripe_webhook_events` ledger → `{duplicate:true}` (l.81-93); finaliser idempotent | none | unchanged | existing ledger | contract test exists |
| J | Browser finalisation submitted twice | browser never finalises (server/webhook only) | none | keep invariant | design invariant test | source-static |
| K | Browser + webhook concurrent | only webhook finalises; `FOR UPDATE` + status guard | none | unchanged | 0043 locks | scratch-PG concurrency |
| L | Pay pressed twice | `submitting` guard + RPC idempotency + `order-<id>` | none | keep; disable button test | existing | unit |
| M | Two tabs same purchase | same idempotency ref → same order (unexpired) | low (post-expiry: second order possible by design) | unchanged; document expiry semantics | unique `idempotency_key` | repository test |
| N | 2nd PI for an already-paid order | Checkout-fallback PI vs direct PI (§7.2); paid order re-finalising is status-guard no-op | low | cancel superseded PI in 3D-B | Edge change | Edge contract |
| O | Credits reserved, card fails | `finalize_paid_order('failed')` releases exactly once (`release-<order>`, 0043 l.241) | none | unchanged | ledger key | scratch-PG exists |
| P | Card succeeds, credit finalisation fails | single transaction — cannot half-apply; webhook retry reruns whole | none | unchanged | one-txn finaliser | scratch-PG |
| Q | Booking exists, client stale | next fetch shows it; no push | UX | status card + poll | projection | unit |
| R | PI succeeds with missing/mismatched metadata | no `payment_order_id` → handler skips; event ledger records it | **stranded provider success** | reconciliation surface lists unmatched succeeded events | 3D-B support query | scratch-PG + contract |

## 11. Webhook and signature-verification audit

Raw body: `await req.text()` before parsing; verified via
`constructEventAsync(rawBody, signature, secret)` (l.58) with the endpoint
secret from `STRIPE_WEBHOOK_SECRET` — signature precedes any trust in the
payload. Event ids persisted to `stripe_webhook_events` **before** side
effects (upsert l.81; duplicate short-circuits l.93; result recorded
l.334/339). Handled: `checkout.session.completed`,
`payment_intent.succeeded`, `payment_intent.payment_failed`,
`payment_intent.canceled` (+ setup/account/transfer/refund/dispute families).
Not handled: `payment_intent.processing`, `payment_intent.requires_action`.
The webhook finalises without the browser (authoritative); browser and
webhook share the single authoritative finaliser (`finalize_paid_order`) —
the browser path only ever calls it for *failure* on decline (stripe-payments
l.255), never success. Concurrency-safe via `FOR UPDATE` + status guards;
webhook retry safe (idempotent); a successful payment can remain locally
unfinalised only while webhooks fail — currently **invisible to support**
(gap → 3D-B support surface). Amount/currency matching against the local
snapshot is **not** re-verified in the webhook (metadata → order id → trusted
provider event); acceptable because the PI was server-created with
server-derived amounts, but 3D-B's reconcile RPC should assert
`amount_received == card_amount_minor` and currency `gbp` for defence in
depth.

## 12. Security and ownership findings

Amounts/currency 100 % server-derived (client sends only ids;
`quote_paid_request` is display-only). Order created under the caller's authed
RPC; PI metadata carries `payment_order_id`/`account_id`; no path accepts a
client-supplied PaymentIntent id (forgery impossible through our API).
Uniqueness: `payment_orders.idempotency_key`, `stripe_payment_intent_id`,
`stripe_checkout_session_id` all unique (0030 l.67-71); one-trial-per-pair
partial unique (0031); credit exactly-once by ledger keys; booking
exactly-once inside the finaliser. Webhook secret isolation and raw-body
verification correct. Residuals: `APP_ORIGINS` fallback (§7.1); "try again"
copy (§7.3); no support view of paid-but-unfinalised (§11).

## 13. Recommended target architecture

Keep server confirmation + hosted-Checkout SCA + webhook authority +
idempotent finaliser. Add, in order of leverage:

1. **Uniform requires-action path** (Edge): for returned
   `requires_action`/`requires_confirmation` intents, build the same hosted
   session as the catch path (cancelling the superseded unconfirmed PI) so
   `{state:'requires_action', url}` is the *only* requires-action shape.
2. **Real return route** `/#/payment/return?order=<id>&outcome=…` for
   payments *and* plan periods (replacing both bare Conversations URLs),
   rendering §17's states and linking onward.
3. **Durable customer-status projection** derived from `payment_orders` (+
   intent facts recorded by the webhook), exposed by a safe status RPC.
4. **Persisted payment session** client-side (sessionStorage `orderId` +
   return-URL param) with an app-load "Payment in progress" resume card.
5. **`check_payment_order` recovery action** (Edge, service-role → re-read
   the PI → existing finaliser) for missed webhooks; support queue of
   provider-succeeded/locally-pending orders.
6. **Bounded honest polling** (backoff to ~2 min, always ending in an
   explicit state) + "Check payment status" button.

## 14. PaymentIntent extension vs Checkout Sessions migration

**A. Extend the existing integration (recommended).** The defects are two
edge-path gaps plus missing UX persistence; the money core (server pricing,
idempotency keys, unique constraints, locked idempotent finaliser, webhook
ledger) already meets the exactly-once bar and is covered by existing
contract/RLS tests. Cost: one Edge function touch, one route, one additive
migration, no dependency changes. Regression surface: minimal.

**B. Migrate checkout to Checkout Sessions with embedded Elements.** Would
introduce Stripe.js + React Stripe, a client confirmation model
(`confirmPayment`, `return_url`, Payment Element), new failure classes
(popup/redirect handling in-app, client-secret custody, version pinning) and
a rewrite of both wizards and the trial flow — while ending at the same
webhook-authoritative finaliser. It buys in-context card entry (nice-to-have)
at the price of re-validating the entire exactly-once story. **Rejected for
3D**: no observed defect requires it; revisit only if product later demands
embedded card entry.

## 15. Proposed migration 0080 scope (NOT created in this pass)

Additive only, after operator approval in 3D-B:

- `payment_orders` columns: `customer_status text` (§17 vocabulary, derived
  and denormalised for cheap reads), `status_detail text`,
  `authentication_started_at timestamptz`, `last_status_check_at
  timestamptz`, `provider_intent_status text`.
- Status-projection RPC `payment_order_customer_state(p_order uuid)` —
  SECURITY DEFINER, `set search_path=''`, owner-checked (coordinator of the
  order), returns §17 state + safe booking pointer; grant `authenticated`.
- `reconcile_payment_order(p_order uuid)` — definer RPC, service-role only,
  wrapping intent re-read outcome → `finalize_paid_order`; asserts
  amount/currency match (§11) and records an audit event.
- Support surface: `support_list_pending_paid_orders()` (support-admin
  pattern of 0038/0061) listing orders `status in
  ('pending','requires_action','processing')` older than N minutes with a
  provider-succeeded webhook event linked.
- Webhook-event linkage: index on `stripe_webhook_events` by
  `payment_order_id` (extracted column) for the support query.
- No new uniqueness needed (audited sufficient in §12); no enum changes to
  existing checks except **extending `payment_orders_status_check` is NOT
  required** — customer_status is a separate projection column.
- RLS: no new table; column additions inherit `payment_orders` policies
  (coordinator-read-own, 0030 l.82).
- Rollback/containment: columns and RPCs are additive and unused until the
  Edge/frontend deploys reference them; containment = redeploy previous Edge
  version + hide the UI; no destructive step anywhere.

## 16. Backend implementation plan (3D-B)

1. Contract/scratch-PG tests FIRST locking current guarantees (finaliser
   idempotency orderings K/I/O/P; §10 rows).
2. Migration 0080 per §15 (single reviewed migration; immutability of
   0001–0079 respected).
3. `stripe-payments`: unify requires-action (§13.1), add `check_payment_order`
   action, switch `success_url`/`cancel_url` to the return route with
   `order=<id>`, validate `APP_ORIGINS` at startup (fail closed, never
   localhost fallback outside dev), record `authentication_started_at`.
4. `stripe-webhook`: add `payment_intent.processing` (project to
   `customer_status='processing'`) — no financial change; optionally record
   `requires_action` similarly.
5. `stripe-billing` `complete_period`: same return-route URLs.

## 17. Frontend implementation plan (3D-C)

Payment-session persistence (sessionStorage orderId + resume card); wizards'
state machines extended to: `awaiting_payment_method`,
`awaiting_bank_authentication` ("Complete the security check with your bank
to continue."), `processing` ("Your bank is processing the payment. This can
take a moment."), `payment_received_confirming` ("Your payment was received.
We're confirming your conversation."), `confirmation_delayed` ("Your payment
was received, but confirmation is taking longer than expected. You will not
be charged again."), `failed` ("The payment was not completed. No new booking
has been confirmed."), `cancelled` ("You stopped before completing the
security check. No payment was taken."), `completed` ("Your payment and
conversation are confirmed."). New `PaymentReturn` page (HashRouter route
`/payment/return`, parses `order`+`outcome`, restores via status RPC);
bounded backoff poll (1.5 s → 5 s → stop ≈2 min) that always lands in an
explicit state; "Check payment status" action on timeout/return/resume
surfaces; return-to-booking link on success; disabled submit during
confirmation (existing `submitting` kept); large-text accessible status
messages (older-Member appropriate); no indefinite spinner anywhere; mobile
bank-app return exercised in 3D-D.

## 18. Test matrix

**Unit (vitest, offline):** state-machine transitions for every §17 state;
poll backoff/termination; return-route param parsing; resume-card logic;
double-click; copy selection. **Repository (mock supabase):** status RPC
projection; `createPaidRequest` result shapes incl. url-less
requires_action rejection. **Edge contract (source-static, existing style):**
url always present with `requires_action`; return-URL construction; key
construction `order-*`/`order-session-*`; `APP_ORIGINS` fail-closed; webhook
handler map incl. `processing`; no client-controlled amounts. **Scratch-PG
integration (Stage-3C proof style):** finaliser idempotency under
browser-first/webhook-first/duplicate-webhook/concurrent (K,I); credit
exactly-once (O,P); reconcile RPC recovery (D,R incl. amount/currency
mismatch refusal and forged/missing metadata); already-paid reopen (N);
two-tab same order (M); expiry semantics (§7.4). **Hosted Supabase (RLS
suite additive block):** status RPC ownership; support queue visibility
gating. **Hosted Stripe test-mode (3D-D, operator):** ordinary success; 3DS
success (4000 0025 0000 3155); 3DS failure; abandoned authentication;
return-URL restoration desktop; processing-state card; browser timeout after
accept; reload during requires_action/processing; credit-only; mixed;
plan-period completion; invalid webhook signature; webhook-delay drill.
**Manual mobile/browser:** banking-app redirect return; popup-blocker
irrelevance (full-page redirect); HashRouter param survival.

## 19. Hosted validation plan (3D-D)

Gated and operator-assisted like C3: (0) baseline — webhook endpoint/secret
names, `APP_ORIGINS` value, read-only count of pending-paid orders; (1)
deploy revised `stripe-payments` only, smoke with negative probes; (2) SCA
card matrix on a staging coordinator; (3) webhook-delay drill (disable
endpoint → pay → verify `confirmation_delayed` + support queue → re-enable →
exactly-once completion); (4) mobile + desktop return tests; (5) plan-period
completion path; (6) sentinels — bookings/credit-ledger exactly-once counts,
no duplicate PI per order.

## 20. Launch acceptance criteria

Every successful Stripe payment yields exactly one order + booking + credit
effect; the authentication handoff visibly works for both SCA shapes on
desktop and mobile; returning from the bank resumes and concludes; no payment
surface can spin indefinitely — every path ends in a §17 state; a paid
customer is never told to pay again; support can list and reconcile any
provider-succeeded/locally-pending order; all §18 offline suites green; 3D-D
drills pass without manual data repair.

## 21. Ordered implementation plan

- **3D-B (backend):** §16 steps 1–5, validated on scratch PG + contract
  suites; single additive migration 0080; no frontend change yet.
- **3D-C (frontend):** §17 in full behind the existing wizards' surface; no
  new dependencies; mock-mode parity for offline tests.
- **3D-D (hosted):** §19 gates; tag on completion; production activation
  remains out of scope (3C1 control plane still governs everything
  financial).
