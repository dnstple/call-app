# Future milestone — Trust & Safety (verification and admin)

**Status: not implemented. Do not build yet.**

## What the prototype does today (and what it does not claim)

Three concepts are deliberately separate:

1. **Account email confirmed** — handled by Supabase auth; may be required.
2. **Profile active** — automatic after normal signup. Migration 0013
   backfilled legitimate `pending_review` profiles to `active` and created
   missing `companion_profiles` rows. Explicitly `suspended` or `hidden`
   profiles were not touched.
3. **Identity verified** — does **not** exist yet. The UI never says
   "Verified"; the quiet badge reads "Profile active". The stored
   `verification_status` fields remain for the future workflow but grant
   nothing today.

The configuration boundary is `platform_config.require_identity_verification`
(default `false`, currently unread). When a real workflow exists, booking
and plan functions consult this flag — a controlled change, not a rewrite.
Booking eligibility must not require `identity_verified` in prototype mode.

## Later Trust & Safety milestone

- optional or mandatory MFA, and authentication-assurance checks for
  sensitive actions
- identity-document verification via a provider (never home-built), with
  selfie/liveness checking where appropriate
- Companion review workflow: safeguarding checks, manual approval and
  rejection with recorded reasons
- suspension, appeal/review process, and full audit history of decisions
- a simple admin queue: report review, concern resolution, and
  role-restricted admin access
- moderation access is itself audited

## Hard rules for whoever builds it

- No service-role key in the browser — ever.
- No "admin route" that simply bypasses RLS; admin capability is a
  database-recognised role with its own policies and audit trail.
- Automatic activation must never be described to users as identity
  verification.
