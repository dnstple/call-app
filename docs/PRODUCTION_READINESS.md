# Production readiness — v1 pilot

Status: pilot-ready checklist. This app runs against hosted Supabase and Stripe
**test mode**. Do NOT enable live Stripe, live email or SMS/push for the pilot.

## Environments & secrets
Frontend (`VITE_*`, safe to ship in the bundle): `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`, and the app base URL. Never put service-role keys,
Stripe secret keys, LiveKit secrets or email-provider keys in `VITE_*`.

Server-only (Supabase Function secrets / Vault): `SUPABASE_SERVICE_ROLE_KEY`,
`STRIPE_SECRET_KEY` (test), `STRIPE_WEBHOOK_SECRET` (test), `BILLING_WORKER_SECRET`,
`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`. Email provider creds are
intentionally absent for the pilot (outbox stays enqueued/deterministic).

## Database
- Apply migrations in order (0001 → 0094). Migrations are additive; never edit an
  applied migration.
- Confirm RLS enabled on every table and that `app_private.*` functions are
  revoked from `public, anon, authenticated`.
- Financial control plane (0073+): keep all operation controls **disabled** and
  ceilings **0** outside guarded, isolated test-mode validation.

## Payments (Stripe test mode only)
- No live keys. No real transfers/payouts/refunds/connected accounts.
- Commission config: trial 0%, one-off 5%, plan 5% (GBP, integer minor units).

## Calls (LiveKit)
- Token grant is mic+camera only; no screen-share, recording/egress or room admin.
- Set `LIVEKIT_*` secrets in Function secrets; never in the bundle.

## Communications
- In-app notifications are live. Email is **enqueued only** (durable outbox,
  0093) and dispatched by a deterministic test adapter — no production provider
  is configured. To go live later, implement the provider dispatcher against the
  `claim_email_batch` / `mark_email_sent` / `mark_email_failed` seam.

## Pre-launch checklist
- [ ] Migrations applied & schema reload confirmed.
- [ ] Support admins seeded in `support_admins`.
- [ ] Consent policies present (0088 seeds v1).
- [ ] At least one approved Companion (support approval, not just profile edit).
- [ ] Secret scan clean; no secrets in the bundle.
- [ ] Financial controls disabled, ceilings 0.
- [ ] Legal drafts reviewed by a solicitor (see docs/legal).
