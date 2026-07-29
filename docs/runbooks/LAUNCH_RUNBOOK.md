# Launch runbook — v1 pilot

1. Freeze `sprint-v1-pilot-completion`; confirm all four macro blocks committed.
2. Apply migrations 0001→0094 to the pilot project; confirm PostgREST reload.
3. Set all server-only secrets (never in the bundle). Leave email provider unset.
4. Seed `support_admins`. Verify `/internal/*` requires support.
5. Confirm consent policies (0088) and approve pilot Companions via support.
6. Keep financial controls disabled + ceilings 0 (test mode).
7. Smoke test: sign up (member, coordinator, companion), consent, book, join a
   video call, message, report a concern, block/unblock, receive reminders.
8. Confirm no live Stripe, no real email/SMS/push.
9. Announce to the closed pilot cohort only.
