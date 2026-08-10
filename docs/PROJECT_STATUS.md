# Apricoti — Project Status & Work Summary

_Last updated: August 2026_

Apricoti is a companionship video-call service. It helps people arrange regular, friendly video conversations for someone they care about (or for themselves), with a Companion the member chooses. This document summarises what the product is, the stage it is at, everything that has been built, and the work completed in the most recent phase.

---

## 1. Where the app is now

Apricoti is well past MVP. It is a working, end-to-end companionship marketplace running as a **controlled pilot** and moving toward public launch. The core product is built and live in production at **apricoti.co.uk** (hosted on Vercel, backed by Supabase).

At a glance:

- **~130 database migrations** covering the full lifecycle — accounts, profiles, discovery, availability, bookings, payments, payouts, calls, messaging, completion, reviews, trust & safety, disputes, financial reconciliation, and an internal admin console.
- **~300 TypeScript/React source files** and **~127 automated test files**.
- A single-page React app (Vite + TypeScript) using hash-based routing, with a Supabase Postgres backend secured by Row-Level Security and `SECURITY DEFINER` RPCs.
- Real payments (Stripe), real video (LiveKit), and a private-pilot access system that gates who can use the live service.

The recent phase has focused on correctness fixes, UX polish, signup improvements, an internal admin/support console, a new **video verification** capability, and standardising **trial conversations**.

---

## 2. The product

**Three roles:**

- **Members** — the person who has the conversations. Can be set up by themselves or by a coordinator.
- **Companions** — vetted people who offer paid conversations, set their availability, and (for standard conversations) their own prices.
- **Coordinators** — a trusted family member or friend who arranges and manages companionship on a member's behalf, with the member's consent.

**The core journey:** explore Companions → book a fixed-price **trial** conversation → if it's a good match, arrange **regular** conversations around availability, paid per-conversation or via recurring plans. All conversations happen in-app over video.

---

## 3. Architecture & technology

| Layer | Technology / approach |
|---|---|
| Frontend | Vite + React + TypeScript single-page app, hash router |
| Backend | Supabase (Postgres) |
| Security | Row-Level Security on every table; privileged logic in `SECURITY DEFINER` RPCs in a private schema; the browser holds no authority |
| Payments | Stripe (Checkout, Connect payouts, refunds, disputes) |
| Video | LiveKit (in-app one-to-one calls, guest join links) |
| Storage | Private Supabase Storage buckets (avatars, verification videos) with per-object policies |
| Hosting | Vercel (production deploys from `main`) |
| Migrations | Forward-only, additive SQL migrations applied with `supabase db push` |
| Testing | Vitest unit/contract tests; `pglite` in-memory Postgres for validating migrations and RPC logic |

**Design principles that run through the codebase:** additive migrations (nothing destructive), server-side authority for every privileged action, audited support actions with required reasons, and no user impersonation.

---

## 4. Feature areas built (whole-product view)

The following capabilities exist in the codebase today, grouped by area (with the migration ranges that established them).

**Accounts, profiles & discovery** _(0001–0004, 0029)_
Sign-up for all three roles, authentication, profile ownership and access control, interests catalogue, favourites, private avatar storage, and a discovery/marketplace view of approved Companions.

**Availability, offers & bookings** _(0004–0018)_
Companion weekly availability and time-off, conversation offers (trial and standard), single bookings, completion confirmations, ratings, and prepaid **packages** with credits and slots. **Conversation plans** for recurring arrangements, plan requests, and plan management.

**Messaging & conversations** _(0019–0028)_
In-app messaging, message requests (including paid requests), conversation materialisation, system events/notifications, and guest call invitations with link-based join.

**Payments, payouts & earnings** _(0030–0055)_
Stripe foundation, paid requests, Connect onboarding for Companion payouts, completion-based reviews and earnings, refunds with audit trails, and companion transfers/payouts.

**Recurring billing** _(0039–0046)_
A full recurring-billing engine: plan acceptance, billing activation, funding modes, charge scheduling, drift reconciliation, and recurring-plan earnings.

**Calls (video)** _(0035, 0064–0069)_
LiveKit-based in-app calls, attendance evidence, unified guest/participant identity, and authoritative call-attendance records that feed completion.

**Completion, reviews & financial integrity** _(0067–0086)_
Completion/earning invariants, evidence-informed payout holds, and a **financial operations control plane** with scoped, auditable execution of earning release, plan renewal, and provider transfers, plus durable customer-payment recovery and a support payout queue.

**Trust & safety** _(0088–0092)_
Versioned consent, conversation reporting, user blocking, companion moderation, and safeguarding enforcement.

**Notifications, reminders & growth** _(0087, 0093–0094, 0100, 0112–0119)_
Email outbox and preferences, booking reminders, message notifications, home recommendations and prompts, match digests, match notifications, and a **referrals** system.

**Pilot access & internal admin console** _(0103–0110)_
A private-pilot access system with cohorts, application review, feature-access enforcement, and RPC boundary guards. A support-only **internal console** (`/internal`) covering pilot access, contact messages, an issue queue, disputes, financial reconciliation, operations, and trust & safety.

---

## 5. Work completed in the most recent phase

This is the detailed changelog of the latest phase of work.

### Calls — reliability
- Fixed a persistent one-way / black-video bug so both participants reliably see each other. Involved forcing correct video playback on iOS/WebKit, releasing the lobby camera before joining, and mounting the call stage before connecting. **Confirmed working end-to-end.**

### Public homepage & site polish
- Removed stock photography and rebalanced the layout; trialled a typography-led redesign, then reverted it at your request while **keeping** the improvements you wanted: the visible contact email, a new footer, and an improved contact form.
- Centred the text-only "For families" and "For members" sections on desktop and repositioned imagery in the "Become a Companion" section.
- Made loading spinners actually spin across the whole site, so a page reads as active while the next step loads.

### Search visibility (SEO)
- Removed the pilot `noindex` tag and added canonical/Open Graph metadata so the homepage can be indexed by Google and appear in search results.

### Sign-up improvements
- Added **preferred name**, a **searchable country-of-residence picker**, "**places and cultures you feel connected to**" (multi-entry), and **per-language fluency**.
- Clarified town/location and photo guidance, and **moved pricing & packages out of sign-up** into the post-approval dashboard to keep the flow shorter.
- Added an optional "**How did you hear about us?**" question on the success screen (all roles), with an "Other — please specify" free-text option.

### Internal admin / support console
- Fixed the "**Choose at least three interests**" checklist item that wrongly showed incomplete (it was counting the wrong column).
- Added a **full account draft and support profile preview** so support can see exactly what an applicant's profile will look like **before** approval — including a preview that works for unapproved users (the public marketplace page can't show these), and fixed a column bug that initially broke it.
- Fixed a **409 error when deleting a user**: audit/actor references now clear safely, the person's profile is removed so its data (including signup consent) cascades away, and accounts with real financial/call history are protected with a clear message instead of a raw error.

### Video verification (new feature)
- Companions record a short **identity video (30–90s)** in-browser from their profile, following a simple on-screen prompt ("introduce yourself and tell us why you'd like to become a Companion").
- Videos are stored in a **private** bucket; only the owner and support can access them.
- Support reviews each video in `/internal` (signed-URL playback, approve/reject with notes). Approval is required before the profile is considered ready to go live; it's surfaced as a required item on the companion's checklist and in the support profile preview.
- **Rolled out to all companions**, and videos are **permanently deleted once verification is complete** — clearly stated to the companion and enforced in the review flow.

### Trial conversations — standardised
- **All trials are now fixed at 30 minutes for £5.** Enforced by a database trigger so it can't be bypassed, with existing trials normalised to the same terms and standard conversations unaffected.
- Removed the companion's ability to change the trial price or duration, and surfaced the fixed policy in both the **rates page** and the **sign-up** review.

---

## 6. Quality & safety practices used

- **Additive migrations only** — every change is a forward-only migration; nothing destructive to existing data.
- **Server-side authority** — privileged actions run through `SECURITY DEFINER` RPCs that re-check permissions; the frontend never holds authority.
- **Validation before deploy** — new migrations and RPC logic are validated against an in-memory Postgres (`pglite`), plus TypeScript type-checking, a production build, and targeted contract/functional tests for each change.
- **Audited support actions** — adverse admin actions require a reason and are recorded; there is no user impersonation.

---

## 7. Deployment & process

- **Frontend** deploys automatically to Vercel from the `main` branch on push.
- **Database** changes are applied with `npx supabase db push`.
- Work is committed on a working branch and fast-forwarded to `main`; pushing and applying migrations is done deliberately by you (not automatically), so the codebase and production stay in sync on your schedule.

**Currently awaiting deployment:** the most recent migrations still need `git push` + `npx supabase db push` to go fully live — principally **video verification (0128–0129)** and **fixed trials (0130)**, along with the internal-console and signup improvements from this phase.

---

## 8. Suggested next steps toward public launch

These are options, not commitments — a starting punch-list:

- **Confirm the pending deploys** (push + `db push`) and smoke-test video verification and trials in production.
- **Surface the new signup fields** (preferred name, places/cultures, per-language fluency, "how did you hear about us") for viewing/editing in the profile and, where useful, the support console.
- **Decide trial existence policy** — trials currently have fixed terms but remain optional per Companion; consider whether every Companion should always have one.
- **Verification operations** — decide review SLAs, notifications on approve/reject, and whether to add a simple allowlist/queue view for scale.
- **Launch readiness** — a pre-launch pass on onboarding copy, empty states, accessibility, and a sitemap for SEO.

---

_This document reflects the state of the codebase as summarised above and can be regenerated as the project evolves._
