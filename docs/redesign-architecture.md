# Product-model redesign — architecture and migration plan

Phase A audit, decisions and migration plan. Latest applied migration confirmed: **0023**.

## 1. Existing model (as audited)

**Database.** `auth.users → accounts → profile_access → profiles`. `profile_access` carries
`access_role` (owner | coordinator | viewer), `can_edit`, `can_message`, `can_view_private_details`,
`consent_status`. Managed Members are ALREADY plain `profiles` rows with a coordinator-side
`profile_access` row and **no auth.users record** — the target account model needs no schema change,
only frontend removal of "active profile" thinking. Profiles are created `profile_status='active'`
immediately (0013 prototype activation); `discoverable_companions` (0004) filters only on
role/status/visibility — no completeness gate. Bookings/plans/messaging eligibility (0022) derive the
actor from `auth.uid()` through `profile_access`. LiveKit tokens (Edge Function `livekit-token`)
are authenticated-only: bookingId in → RLS-scoped read → member-/companion-identity token out. No
guest path exists.

**Frontend.** `AuthProvider` exposes `profiles` + `activeProfileId` + `setActiveProfile`; `Shell`
renders one shared NAV for all roles (incl. Explore + separate Plans) plus a top-right
active-profile `<select>` (Supabase) / identity switcher (mock). Home lists full confirmed bookings
(duplicating Conversations). Conversations is a flat Upcoming/Past list; Plans is a separate
route/nav item. ExploreSupabase has a client-chosen sort (`newest | alphabetical | completeness`).
Signup chooser offers member, companion, coordinator.

## 2. Decisions

- **Account = authenticated person.** Top-right shows account holder only (name, role, Settings,
  Sign out). The Supabase active-profile selector is REMOVED. The mock-mode identity switcher is
  retained solely as the prototype's stand-in for signing in as different demo people (mock mode has
  no auth); it is a dev control, not product UI.
- **Account role** is derived from the owned profile (`access_role='owner'`). Coordinated member
  profiles are context, never identity.
- **Managed-member context** lives in `src/state/managedMember.ts`: explicit selection, validated
  against the coordinated set, session-persisted per account, surfaced near page titles
  ("Managing Mary Thompson" / "Managing: ▾" for >1). No silent `members[0]` where the choice matters:
  with multiple members and no stored choice, consumers receive `null` and must ask.
- **Home vs Conversations.** Home = action dashboard (needs-attention, one next-conversation hero,
  compact glance). Conversations = authoritative schedule + plan management (agenda with date strip,
  Today/Tomorrow grouping, needs-attention above agenda, compact Regular-plans area, month-grouped
  Past). `/plans` navigation is removed; plan detail moves under `/conversations/plans/:planId`
  (old routes redirect). Home retains distinct value for both roles (actions + guidance), so it stays.
- **Navigation.** Coordinator: Home, Explore, Messages, Conversations, Members, Settings.
  Companion: Home, Messages, Conversations, Profile, Settings — Explore hidden AND route-guarded
  (neutral redirect). Managed Members: no app navigation; guest call page only.
- **Guest calls** (migration 0024): `guest_call_invitations` — one active invitation per booking,
  hashed token + hashed 6-digit code, expiry = call end + grace, revocable, rotated on regenerate,
  revoked on cancellation/reschedule (trigger). Anonymous access ONLY via narrow SECURITY DEFINER
  RPCs (validate + attempt-rate-limited) and a guest branch in the `livekit-token` Edge Function
  that exchanges a valid invitation for a short-lived `guest_member` room token. Raw tokens are
  returned once at creation and never stored or put in event payloads.
- **Message requests** (migration 0025): conversation-status model (NOT a separate table) —
  `conversations.status: request_pending | active | declined`. Preserves one thread per pair,
  append-only messages, existing RLS. A coordinator/member side may open a conversation WITHOUT a
  qualifying booking; it starts `request_pending` and permits exactly ONE requester-side message.
  Companion accepts (→ active) or declines (→ declined). **Decline decision: permanent for the pair;
  only the Companion can reopen** (Accept remains available to the Companion on a declined request;
  the requester cannot re-send — no cooldown timer to tune, no spam window). A qualifying confirmed
  booking/active plan still auto-activates the thread (materialisation sets status='active').
- **Explore** (Phase F): sort control removed. Server ordering documented as: profile completeness
  desc, then joined_at desc (stable id tiebreak) — "best profiles first, stable". Photo-first cards;
  whole card clickable + keyboard operable; favourite isolated.
- **Companion completeness** (migration 0026): server-enforced activation — photo present AND
  trimmed bio 120–1000 chars (placeholder/repeat detection) AND headline AND ≥1 interest AND ≥1
  availability rule AND ≥1 active offer. `discoverable_companions` additionally filters on photo +
  bio length so incomplete profiles can never appear. Client cannot set itself active (trigger).
- **Reset tooling** (Phase G): `scripts/reset-prototype-data.*` — guarded by
  `RESET_PROTOTYPE_DATA=true`, dry-run counts first, two modes (app data only / + selected test auth
  accounts). Never mixed into migrations. NOT executed automatically.

## 3. Planned migrations

- `0024_guest_call_invitations.sql` — invitations table, RLS, create/regenerate/revoke/validate
  RPCs, attempt rate limiting, booking-lifecycle revocation trigger, system events.
- `0025_message_requests.sql` — conversation status + request lifecycle RPC
  (`respond_to_message_request`), send_message pending-gate, revised get_or_create eligibility,
  auto-activation on booking/plan materialisation.
- `0026_companion_completeness.sql` — completeness check fn, activation RPC, status-protection
  trigger, discovery view v3 (photo + bio guards), server ordering.

All additive; 0001–0023 untouched. Stripe, payouts, SMS, push, attachments: out of scope.
