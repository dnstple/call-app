# Stage 2E4 — From packages to recurring conversation plans

**Status: architecture review and phased plan. No implementation yet.**

The product moves from "buy 4 calls with Daniel" (transactional credit) to
"Mary has regular conversations with Daniel, three times a week" (an ongoing
relationship with a weekly rhythm and weekly simulated billing). This
document audits what exists, recommends what to reuse, and breaks the work
into implementable phases.

---

## 1. Audit — what exists and how it actually works

### 1.1 Package infrastructure (migrations 0008–0010)

| Piece | What it does | Verdict for plans |
|---|---|---|
| `package_offers` | Companion-defined bundles (count × duration × total price) | **Retire from the UI, keep the table.** Plans are configured by the Member (frequency × duration), priced from the Companion's per-conversation rates — Companions no longer curate bundles. Existing rows stay (purchases reference them). |
| `package_purchases` | One-off grant account: buyer, member, companion, snapshots, active/exhausted/cancelled | **Reuse as the plan's allowance account.** Every plan gets exactly one backing purchase row. This is the key move — see §2. |
| `package_credit_ledger` | Append-only grant/reserve/release/consume/adjustment; balance always calculated | **Reuse unchanged.** This is precisely the audit trail a weekly allowance needs. |
| `create_package_booking_request` (0009) | Locks the purchase, checks balance, books + reserves atomically | **Reuse unchanged** for ad-hoc extra bookings against a plan; plan occurrence generation uses the same primitives internally. |
| `settle_package_credit` (0009) | release on decline/cancel; release+consume on completion; flips purchase to exhausted | **Reuse with one adjustment**: plan-backed purchases must never auto-flip to `exhausted` (their allowance is rolling). One `create or replace` in the new migration. |
| Unique reserve/release/consume indexes + purchase `FOR UPDATE` lock | Double-spend and race protection | **Reuse unchanged.** Nothing about plans weakens this. |
| `get_available_package_slots` (0010) | Purchase-driven slot generation | **Reuse unchanged** for one-off rescheduling within a plan. |

### 1.2 Booking infrastructure (migrations 0005–0007)

- `bookings` already supports `booking_source='package_credit'` +
  `package_purchase_id`, GiST no-overlap constraints for both parties,
  audited status history, completion reconciliation and ratings. **A plan
  occurrence can simply BE a booking** — every downstream feature
  (conflicts, completion, ratings, credit consumption) works with zero
  changes the moment an occurrence exists as a booking row.
- Trial infrastructure: `conversation_offers.offer_type='trial'`,
  `bookings.is_trial`, and `one_pending_trial_per_pair` (blocks a second
  *pending* trial). **The "test call" is the existing trial**, repositioned.
  Missing piece: permanence — today a *completed* trial doesn't block a new
  one. One server-side rule closes that.
- Availability: recurring rules are Companion-local wall times with DST-safe
  conversion (`slot_within_availability`, Intl utilities). **A weekly plan
  slot is the same shape** (ISO day + local time + timezone), so validation
  and per-occurrence UTC conversion reuse this directly.

### 1.3 What genuinely does not exist yet

1. A **plan entity** (relationship, frequency, weekly schedule, weekly
   price, paused/active/ended).
2. **Occurrence generation** — turning "Tuesdays 18:00" into rolling
   `bookings` rows.
3. **Weekly allowance replenishment** (weekly `grant` entries).
4. **Trial permanence** + a readable trial state per pair.
5. All of the UI: repositioned profile, plan wizard, schedule picker,
   plan dashboard, management actions.

---

## 2. Recommendation — wrap, don't rewrite

**Create a thin plan layer on top of the intact credit engine.**

```
conversation_plans          ← NEW: the relationship + rhythm
  id, member_profile_id, companion_profile_id,
  frequency_per_week (1–7), duration_minutes, communication_method,
  weekly_price_minor (snapshot), currency,
  status: requested | active | paused | ended,
  allowance_purchase_id → package_purchases(id)   -- 1:1 backing account
  created_by_account_id, timestamps, pause/end audit fields

plan_schedule_slots         ← NEW: the weekly rhythm (count = frequency)
  id, plan_id, iso_day (1–7), local_time, timezone

bookings                    ← UNCHANGED rows; occurrences are ordinary
                              package-credit bookings (+ nullable plan_id
                              column for grouping/display)

package_purchases           ← gains `plan_id uuid null` (or is_plan flag);
                              plan-backed rows are invisible as "packages"
                              and exempt from auto-exhaust

package_credit_ledger       ← untouched; weekly grants + the existing
                              reserve/release/consume lifecycle
```

Why this beats a rewrite:

- **Every hard-won guarantee survives untouched**: atomic reservation, the
  final-credit concurrency lock, double-settlement impossibility, RLS
  isolation, the audit ledger, completion-driven consumption, ratings.
- **Occurrences are bookings**, so conflicts, decline/cancel/release,
  completion, needs_review and ratings all work on day one.
- Existing purchases/bookings remain valid history; nothing breaks for the
  data you've already created.
- The alternative (renaming tables into `conversation_plans` /
  `plan_subscriptions` / `conversation_allowances`) is a destructive
  migration of working, live-tested security code for purely cosmetic gain.
  Naming lives in the repository layer instead (`planRepository` presents
  "plans" and "allowances"; nobody outside SQL sees "package").

**Pricing**: weekly_price = frequency × the Companion's single-offer price
at the chosen duration (snapshot on the plan; recorded per occurrence as
today). Requires the Companion to have an active single offer at that
duration — surfaced in the wizard.

**Consent model**: the Member requests a plan → the Companion accepts the
PLAN once (`requested → active`) → occurrences generate as **confirmed**
bookings (no per-occurrence accept). Declining the plan ends it cleanly.

**Rolling window (no cron needed yet)**: an idempotent
`extend_plan_bookings(plan_id)` generates occurrences up to a 4-week
horizon: for each due week it writes one weekly `grant` (× frequency), then
one confirmed booking + `reserve` per schedule slot, skipping occurrences
that violate notice or collide with existing bookings (skips are recorded
so the UI can surface them). Called on plan acceptance and opportunistically
from the app (Home/plan dashboard load); a scheduled job can take over
post-prototype without schema change.

**Trial permanence**: extend the trial rule to "one trial per pair, ever":
reject a trial booking when ANY completed trial exists for the pair, and add
`get_trial_state(member, companion)` → `available | pending | used` for the
profile UI. Server-enforced, no browser state.

---

## 3. Phased implementation plan (Stage 2E4)

**2E4A — Plan backend (migration 0011 + repository + tests).**
`conversation_plans`, `plan_schedule_slots`, `bookings.plan_id`,
`package_purchases.plan_id`, functions: `create_conversation_plan`
(validates slots against availability, snapshots weekly price, creates the
backing allowance atomically), `accept_plan` / `decline_plan`,
`extend_plan_bookings`, `pause_plan` / `resume_plan` / `end_plan`
(pause/end cancel future occurrences → automatic credit release),
`skip_plan_week`, exhaust exemption, trial permanence +
`get_trial_state`. RLS mirroring purchases. `planRepository` with typed
errors. Unit + live tests (plan lifecycle is fully live-testable).

**2E4B — Profile repositioning + plan creation flow.**
Companion profile: test-call hero card (or "Start regular conversations"
once used), plans as the primary CTA, one-off booking demoted. The 6-step
wizard: frequency (Member-preference preselected + "Recommended"),
duration, method, **the weekly schedule picker** (visual week built from
the Companion's recurring availability, one slot per frequency unit,
recommended combinations, viewer-timezone display), review (photo, names,
rhythm, weekly price, "Prototype plan — no payment will be taken"),
confirm → requested state UI.

**2E4C — Plan dashboard + management.**
"Your conversation plans" replaces "Conversation packages" (card:
companion, rhythm, schedule, next conversation, status, actions);
Coordinator phrasing ("Mary's conversation plan with Daniel"); pause /
resume / end; change frequency/times/method with "this conversation only"
(cancel+rebook one occurrence, same credit) vs "this and future"
(regenerate window); skip a week; Home refocus (next conversation, plans,
requests, recent activity); Companion-side plan requests view.

**2E4D — Retirement + polish.**
Remove package-buying UI (editor + Buy plan cards; data preserved),
redirect old dashboard copy, docs, full live suite pass, visual QA.

Each phase independently verifiable (typecheck/tests/build + live where
applicable), in the established stage format.

---

## 4. Database impact assessment

- **Additive only**: 2 new tables, 2 nullable columns, new functions, one
  `create or replace` of `settle_package_credit` (exhaust exemption) and of
  the trial branch inside `create_booking_request`. No drops, no rewrites
  of 0001–0010. `my_bookings` recreated once more to expose `plan_id`.
- Existing data unaffected; old package purchases keep working as legacy
  allowances until 2E4D hides their purchase UI.
- New failure surface: occurrence generation (idempotency keyed on
  plan+week+slot; unique index prevents duplicates; per-occurrence conflict
  skips recorded, never fatal).

## 5. UI impact assessment

- **New**: plan wizard (the schedule picker is the flagship build — est.
  the largest single component of the epic), plan dashboard cards, plan
  management sheets, Companion plan-request cards, test-call hero.
- **Changed**: ProfileDetail (hierarchy inversion), Home (sections), the
  existing SupabaseBookingWizard stays for one-offs but is demoted.
- **Removed (2E4D)**: PackageOfferEditor, PublicPackages purchase flow,
  PackageDashboard (superseded).
- Mock mode untouched throughout, as always.

## 6. Risks and tradeoffs

1. **Availability drift** — a Companion narrows availability after a plan
   starts; future occurrences may no longer fit. Mitigation: generation
   skips-and-records; dashboard shows "2 conversations need a new time".
2. **Occurrence auto-confirm** trades per-call Companion consent for plan-
   level consent. Deliberate product change; declining the plan or
   cancelling occurrences remains possible (credits auto-release).
3. **DST**: weekly slots stored as Companion-local wall time + timezone and
   converted per occurrence (existing utilities) — "6pm Tuesday" stays 6pm
   across clock changes; UK↔abroad viewers see shifted times, as now.
4. **No cron yet**: window extension is client-triggered; if nobody opens
   the app, the window shrinks. Acceptable for the prototype; a scheduled
   job slots in later without schema change.
5. **Exhaust exemption** touches settled logic — needs the same test rigour
   as 0009 (unit matrix + live).
6. **Legacy packages** remain visible until 2E4D — brief period where both
   vocabularies exist. Sequencing keeps it short.
7. **Weekly billing is simulated**: the ledger records rhythm, not money.
   When Stripe arrives, weekly charges attach to the plan row cleanly.
