# Conversation Companionship Platform — Stage 1 prototype

*“Combatting loneliness one phone call at a time.”*

A polished, responsive front-end prototype connecting older people (**Members**) with younger
people offering friendly scheduled calls (**Companions**), often arranged by a family member
(**Coordinator**). Everything is simulated: fictional people, mock payments, in-app-only
notifications and local-storage persistence. **No real personal data should ever be entered.**

## Run it

```bash
npm install
npm run dev        # local dev server
npm test           # 36 unit + smoke tests
npm run build      # production build (dist/) — deploys as-is to Vercel/Netlify
npm run preview    # serve the production build locally
```

Requires Node 18+.

## Using the demo

- The header has a **prototype role switcher**: view the app as Alex (Coordinator), Margaret
  (Member) or James (Companion). Coordinators can also switch which managed Member is in focus.
- Suggested walkthrough (the scripted demo scenario):
  1. As **Alex**, open Explore, open a Companion, book a **£5 trial** for Margaret.
  2. Switch to **James** (Companion) to **accept** the request — notifications fire.
  3. Conversations → an ended call sits in **Awaiting completion**; both sides record outcomes.
  4. When both confirm, the rating dialog enforces **one rating per reviewer** (updating, never stacking).
  5. Buy a **weekly 4-call package** from James’s profile and book a call with a package credit —
     the credit is consumed only when the call completes.
  6. Record mismatched outcomes on a call to see it routed to **Needs review**.
- **Settings → Account → Reset demo data** restores the original seed at any time.
- Settings → Accessibility has text size, high contrast, reduced motion and a simple-interface mode.

## What’s implemented (Stage 1 acceptance criteria)

Role-aware Home dashboard · Explore with search/filter/sort/favourites and grid/list toggle ·
profile detail pages with hidden contact details · role-adaptive 11-step onboarding wizard with
draft autosave · booking wizard (trial/single/package, Coordinator books for a Member, slot
picker honouring availability, conflicts and minimum notice, simulated payment with configurable
0%/2% commission) · conversation tabs with the full status lifecycle (accept/decline/propose,
reschedule, cancel, complete, missed, concern → needs review) · two-sided completion
reconciliation · unique-reviewer ratings · package credits reserved on booking and consumed on
completion · notification centre with read/unread and filters · full settings groups · report and
block controls · mock-mode labelling throughout.

Deferred by design (see `ARCHITECTURE.md`): real auth, live payments, real notifications,
identity checks, in-app calling, production data.

## Project layout

```
src/
  types.ts               All typed domain models
  data/seed.ts           Fictional seeded demo data (relative dates, deterministic reset)
  domain/                Pure business logic + unit tests (no React imports)
    ratings.ts           One-active-rating-per-pair rule, unique-reviewer average
    commission.ts        Configurable 0% trial / 2% standard commission
    packages.ts          Credit reservation/consumption lifecycle
    bookings.ts          Status transitions, trial eligibility, conflicts, completion reconciliation
    availability.ts      Slot generation from recurring rules
  state/
    store.ts             localStorage-backed store + toasts + reset
    actions.ts           Service layer — every mutation, future API surface
    selectors.ts         Derived reads (visible bookings, active member, settings)
  components/            Reusable UI (shell, cards, wizards, dialogs, primitives)
  pages/                 Route-level screens
```

All colours/typography/spacing are CSS custom properties at the top of `src/index.css` — swap
them to rebrand. The product name is the “App Name” placeholder in `components/Shell.tsx`.
