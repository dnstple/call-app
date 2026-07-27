# v1 pilot — Block 4 integrated validation & closeout

Branch `sprint-v1-pilot-completion`. Blocks 1–3 committed
(`0b71193`, `4c090b3`, `1097fa3`). This document is the single source for the
hosted deployment delta, the operator validation runbook, external launch
blockers, and the deferred post-v1 roadmap.

Status: **code-complete v1**, **local-validated** (1436 unit tests, typecheck,
build, secret scan; Block 2 & 3 security-critical invariants scratch-proven).
The hosted integrated journey, the Stage 3D/3E hosted verifier re-runs, and the
two-person browser video evidence are **operator steps** (they require the
hosted service-role key, Stripe test key, billing worker secret and LiveKit
config, plus two real browsers — none of which are present in the build
environment). The `v1-pilot-ready` tag is created only after those pass.

## A. Hosted deployment delta (vs the validated Stage 3E hosted state)

Migrations to apply, in order (all additive; `0001–0086` already hosted):

| Migration | Effect | Expected row changes / backfill | Historical rows |
|-----------|--------|----------------------------------|-----------------|
| 0087 message notifications | trigger + fn | none (schema only) | untouched |
| 0088 versioned consent | 2 tables + seeds | seeds 3 `consent_policies` rows (v1) | untouched |
| 0089 conversation reporting | table + fns | none | untouched |
| 0090 user blocking | table + fns | none | untouched |
| 0091 companion moderation | columns + audit + backfill | existing companions in `discoverable_companions` → `approved`; all others → `pending`; one audit row each | approves only already-public companions |
| 0092 trust enforcement | view + triggers + fn | redefines `discoverable_companions`; adds 3 triggers; re-asserts `call_join_eligibility` | untouched |
| 0093 email outbox + prefs | 2 tables + trigger + fns | none (outbox fills as notifications arrive) | untouched |
| 0094 booking reminders | fn + guarded cron | registers `booking-reminders-hourly` if pg_cron present | untouched |

Edge Functions:
- **`livekit-token` — DEPLOY** (changed: authenticated grant now mic+camera; guest branch still mic-only). Verify the deployed version publishes `['microphone','camera']` and never screen-share/record/egress/admin.
- All other Edge Functions **unchanged — do NOT redeploy**.

Scheduled jobs: `booking-reminders-hourly` is registered by 0094 only where
pg_cron exists. Hosted validation may invoke `create_booking_reminders()`
directly; **production cron activation remains an operator step** (confirm the
schedule after deploy).

Email: **no production provider integration exists.** Validate only the durable
outbox + deterministic test adapter. Never claim an external email was sent.

Financial controls — current and required-final state (unchanged by v1):
- Stripe **test mode** only; live disabled.
- Payout execution **disabled**; per-transfer ceiling **0**; daily ceiling **0**;
  transfer destination allowlist **inactive**.
- No recording/egress; no unexpected cron.

External secrets / dashboard actions genuinely required: none new for the pilot
beyond what Stage 3E already required (service role, Stripe test, billing secret,
LiveKit test config).

## B. Operator validation runbook (one action at a time)

Prerequisite: export hosted TEST env (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_ANON_KEY`, `STRIPE_SECRET_KEY=sk_test_…`, `BILLING_WORKER_SECRET`).
`scripts/validate-v1-pilot.mjs` refuses live keys and the wrong project.

1. `node scripts/validate-v1-pilot.mjs --preflight` → expect `preflight ok`.
2. Apply migrations 0087→0094 in the Supabase SQL editor **one file at a time**,
   confirming the expected effect from the table in section A after each. Stop if
   any migration errors.
3. `node scripts/validate-v1-pilot.mjs --verify-foundation` → all `foundation:*`
   PASS (tables present, consent seeded, controls safe).
4. Deploy the changed Edge Function only:
   `supabase functions deploy livekit-token`. Verify the version; do not deploy
   others.
5. Re-run the **Stage 3E** verifier (`scripts/validate-3e-payouts.mjs`) end to
   end. Its fixture is now additively consent+approval-satisfied (see section C).
   Expect `pass=19 fail=0`.
6. Re-run the **Stage 3D** verifier (`scripts/validate-3dd-payments.mjs`).
   Expect `pass=18 fail=0` (its payment cases keep `booking_id=null`, so the new
   booking/message/conversation triggers are not exercised).
7. Run the v1 integrated sections
   (`--prepare-fixture`, `--verify-trust`, `--verify-notifications`,
   `--verify-calls`, `--verify-financial`, then `--verify` / `--report`), each
   with the confirmation phrase `VALIDATE-V1-PILOT-TEST`. Expect
   `VERIFY RESULT pass=<n> fail=0`.
8. Complete the browser evidence scenarios (section D) into
   `v1-browser-evidence.local.txt`.
9. `--restore-controls` then confirm the final hosted safety state (section E).

## C. Verifier fixture updates (additive)

- **Stage 3E** (`validate-3e-payouts.mjs`): after creating profiles/offers, the
  fixture now upserts `companion_profiles.moderation_status='approved'` and
  inserts current-version `member_pilot` + `companion_pilot`
  `consent_acknowledgements`, so its direct booking inserts satisfy the 0092
  triggers. Idempotent; no existing assertion changed.
- **Stage 3D** (`validate-3dd-payments.mjs`): **unchanged** — its cases operate
  on `payment_orders` / `reconcile_payment_order` and deliberately keep
  `booking_id=null`, so the booking/message/conversation triggers never fire.

## D. Browser evidence scenarios (operator, into v1-browser-evidence.local.txt)

Record one line per proven item. Reserved for what RPCs cannot prove:
responsive video layout; real camera + microphone permission; camera preview;
two-person video render in one opaque room; mute/camera/device controls;
reconnect copy; notification + email-preference UI; Trust & Safety support
actions; mobile-width (≤400px) no horizontal overflow on the call and booking
screens.

## E. Required final hosted state

Stripe live disabled · payout execution disabled · per-transfer ceiling 0 ·
daily transfer ceiling 0 · isolated allowlist inactive · no production email
provider · no recording/egress · no unexpected cron.

## F. External launch blockers (must clear before public launch)

1. Legal drafts (`docs/legal/*`) reviewed/completed by a solicitor.
2. Safeguarding policy approved by a named safeguarding lead.
3. Production email provider wired to the `claim_email_batch` / `mark_email_*`
   dispatcher seam.
4. Production Stripe + Connect authorisation (live mode).
5. Final production `APP_ORIGINS` / return URLs.
6. Live LiveKit configuration + smoke test.
7. External monitoring/alerting configured.

Until these clear, describe the app as **code-complete v1, hosted-test
validated, ready for a controlled pilot** — not unrestricted public launch.

## G. Deferred post-v1 roadmap

Referrals; SMS + push notifications; group calls; screen sharing; call
recording; AI features; multi-currency; quiet-hours / digest email; a full
visual redesign; production email/Stripe/LiveKit activation (operator config).

---

## Validation outcome — Block 4 completed (hosted TEST, project gwtunmoefapiiybwlelw)

**Result: v1 pilot journey validated — `VERIFY RESULT pass=18 fail=0`.**

Hosted changes applied:
- Migrations **0087–0096** applied in order (0088 seeded 3 consent policies;
  0091 backfilled moderation approved only for already-discoverable companions;
  0095 + 0096 are the two corrective EXECUTE grants found during validation —
  see below). No other data changed.
- Edge Function **`livekit-token` deployed** (authenticated grant = microphone +
  camera; guest branch microphone-only; no screen-share/recording/egress/admin).
  No other function redeployed.
- Booking-reminder cron: function present; production `pg_cron` activation
  remains an operator step.

Regression + integrated results:
- **Stage 3E** payout verifier: `pass=19 fail=0`.
- **Stage 3D** payment verifier: `pass=18 fail=0` — the global-delta guard now
  attributes the exact Stage 3D + Stage 3E + v1 pilot fixtures by profile
  identity, zero unexplained (see `scripts/stage3d-attribution.mjs`).
- **v1 integrated** (`validate-v1-pilot.mjs`): trust (consent/moderation/
  discovery), notifications/outbox (test adapter, no live send), calls (real
  mic+camera tokens, screenshare/record excluded, non-participant denied),
  financial projections — all pass; final `VERIFY RESULT pass=18 fail=0`.
- **Browser evidence** (`v1-browser-evidence.local.txt`, 12 markers): real
  camera/mic permission, self-preview, device selection, two-person room render
  (simultaneous two-way limited only by a single shared webcam on one machine),
  mute/camera toggles, reconnect banner, notification-preferences UI, report +
  block UI, support Trust & Safety console, mobile ≤390px no-overflow.

Defects found and fixed during validation (all committed on this branch):
- **0095** — `discoverable_companions` (security-invoker) calls
  `has_current_consent`; 0088 had revoked EXECUTE from authenticated → Explore
  errored. Granted EXECUTE to authenticated + service_role.
- **0096** — the `user_blocks`/`consent_acknowledgements` RLS policies call
  `profile_owner_account`; the discovery view reads `user_blocks` as invoker →
  Explore + profile 403. Granted EXECUTE to authenticated + service_role.
- **Signup wizard sign-out** — a signed-in, not-yet-onboarded account could get
  stuck in the wizard with no exit; added a Sign out affordance.
- **Date-robust test selector** — `conversationsRedesign` used a bare
  `getByText('1')` that collides with a day-of-month "1" cell; scoped to the
  count pill (test-only; unrelated to Block 4 code).

Local battery (final): full unit suite **1482 passed / 92 files, 0 failed**;
typecheck clean; production build clean; all validation scripts `node --check`
clean; secret scan clean; `.local` evidence files git-ignored.

Final hosted safety state (confirmed): Stripe live disabled; payout execution
disabled; per-transfer + daily ceilings 0; isolated allowlist inactive; no
production email provider; no recording/egress; no unexpected cron.

Known pilot items (not launch blockers):
- **Call/lobby visual polish** — functional and safe but visually rough;
  recommended as the next task after tagging (see roadmap).
- **Stale `.test` fixture accounts** from the first (failed) prepare-fixture
  attempt are orphaned (no profiles; unused by harness/verifiers) and may be
  deleted post-pilot; harmless.

Status: **code-complete v1, hosted-test validated, ready for a controlled pilot**
once the external launch configuration in section F is completed. NOT
unrestricted-public-launch ready until those clear.
