# Customer payment flow — recovery, returns and status (Stage 3D)

How a customer payment behaves after Stage 3D, for operators and support.

## The one guarantee we repeat everywhere

A customer is never charged twice for one intended purchase. The server
creates every Stripe object with a stable idempotency key tied to the local
order; webhooks (never the browser) finalise; finalisation is row-locked and
idempotent; and every recovery surface repeats the wording "You will not be
charged again" wherever money may already have moved.

## Bank authentication (SCA)

When Stripe requires authentication, the app saves a durable recovery session
(the order id only — never secrets), tells the customer a bank security check
is needed, and navigates once to the Stripe-hosted page. The return lands on
`/#/payment/return?order=<id>&outcome=success|cancelled`. The `outcome`
parameter is never trusted: the page asks the server for the durable order
state (and runs one idempotent server-side check of the stored PaymentIntent)
before saying anything definite.

The off-session attempt that triggers this handoff is superseded once the
hosted Checkout Session is opened: the session becomes the order's
authoritative funding, and the superseded intent's later cancellation/failure
can never fail the order (migrations 0082/0083). A hosted Checkout Session's
PaymentIntent does not exist until the customer completes payment, so
containment keys on the recorded session, not the (initially null) intent.
This is what makes SCA payments finalise reliably instead of stalling — the
behaviour validated end-to-end in hosted test mode (Stage 3D-D, M3/M4/M5).

## If the app is closed, reloaded, or the bank app swallows the return

The durable session survives. On the next visit the shell shows
"A payment was still in progress — Resume payment", which reopens the status
page for the same order. Nothing is ever re-charged by resuming; the page only
reads and, at most, asks the server to re-check the stored intent.

## Waiting states

- Processing: "Your bank is processing the payment. This can take a moment."
- Payment received: "Your payment was received. We're confirming your
  conversation." (bounded automatic checking, ~2 minutes with backoff)
- Confirmation delayed: shown when checking pauses — with a
  "Check payment status" button. Delayed is NEVER presented as failure.
- Reconciliation required: rare; support sees it in the pending-payments
  queue (`support_list_pending_paid_orders`) with a safe reason code.

## Retry rules

"Try payment again" appears only when the server confirms the previous
attempt definitively did not succeed (failed / cancelled / no payment
method). It never appears for processing, provider-succeeded, confirming,
delayed or reconciliation states.

## Origin configuration (deployment blocker)

Return URLs derive from the `APP_ORIGINS` Edge secret (comma-separated exact
origins, primary first). It currently holds the approved local development
origin `http://localhost:5173` — hosted checkout returns will point at
localhost until it is replaced. **Before any production deployment,
`APP_ORIGINS` must be set to the exact production application origin.** The
functions fail closed (no silent localhost fallback) when it is unset.
