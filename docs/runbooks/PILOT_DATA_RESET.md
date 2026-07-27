# Pilot data reset — operator runbook

Purpose: permanently remove **all runtime data and all auth users** from the
hosted pilot database (Supabase project `gwtunmoefapiiybwlelw`) while preserving
the project, schema, migrations, RLS, triggers, functions/RPCs, Edge Functions,
secrets, Storage buckets, and required configuration. You recreate accounts
afterwards.

This is destructive and irreversible once committed. It is proven against a
scratch database built from the real migrations (0001–0096) — see
"Scratch proof" at the end.

Files:
- `scripts/pilot-reset.mjs` — `--plan` (read-only) and `--execute-storage`.
- `scripts/reset-pilot-data.sql` — the transaction-wrapped SQL data reset.

Guarded to project `gwtunmoefapiiybwlelw`; the Node tool refuses any other
`SUPABASE_URL`.

---

## 0. FIRST: lock down new public signups (do this before the reset)

If you don't, uncontrolled signups will simply repopulate the project.

**Honest note:** turning on **Confirm email does NOT prevent auth user rows from
being created** — an unconfirmed `auth.users` row is still inserted on every
signup attempt; confirmation only gates whether they can *sign in*. To actually
stop new rows you must **disable signups**.

Exact dashboard steps (Supabase → your project):
1. **Authentication → Sign In / Providers → Email.** Turn **OFF "Allow new users
   to sign up"** (the Email provider's *Enable Signups* toggle). Save.
2. **Authentication → (Configuration) → Sign In / Up / General.** Confirm the
   project-level **"Allow new users to sign up"** is **OFF** (belt-and-braces —
   this disables signups across all providers).
3. Leave **Confirm email ON** as good practice, but do not rely on it for access
   control.
4. **Invite-only (target state):** with signups disabled, add pilot users via
   **Authentication → Users → Add user** (or "Invite"), or the Admin API. Only
   people you add can register.

Verify: from an incognito browser, attempt to sign up — it should be rejected
("Signups not allowed for this instance").

---

## 1. Plan (read-only) — the single first operator action

Export the pilot service-role env (never printed, never committed):

```powershell
$env:SUPABASE_URL="https://gwtunmoefapiiybwlelw.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="<pilot service-role key>"
```

Then run:

```powershell
node scripts/pilot-reset.mjs --plan
```

Expected output: the project header, the current `auth.users` count, the
non-empty runtime tables with row counts (in FK delete order), the **preserved**
configuration tables with their (non-zero) counts, a Storage buckets/objects
summary, and a note of the ordering. Nothing is changed.

## 2. Back up

Supabase → Database → Backups → take a snapshot. There is no undo after COMMIT.

## 3. Purge Storage objects (buckets preserved)

```powershell
node scripts/pilot-reset.mjs --execute-storage --confirm RESET-PILOT-STORAGE-DATA
```

This walks every bucket and deletes user-owned objects **through the Storage
API** in batches (never via SQL, never `storage.objects` directly), and leaves
the buckets in place. Re-run `--plan` to confirm object counts are 0.

## 4. Run the data reset SQL

Open `scripts/reset-pilot-data.sql` in the **Supabase SQL Editor** and run it.
It is transaction-wrapped and **ends in `rollback;`**, so the first run only
shows you the verification output without changing anything:
- `RUNTIME (expect all 0)` — every runtime count including `discoverable`.
- `PRESERVED (expect > 0)` — config tables.

If RUNTIME is all zeros and PRESERVED is non-zero, apply it by changing the
**single final line** from:

```
rollback;  -- <<< CHANGE TO:  commit;   TO APPLY THE RESET
```
to `commit;` and run again.

## 5. Recreate access

1. Sign up fresh in the app with your email (signups are disabled globally — add
   yourself via **Authentication → Users → Add user** first, then sign in / set
   password).
2. Restore support admin:
   ```sql
   insert into public.support_admins (account_id)
   select id from auth.users where email = 'daniel.pinchen@outlook.com'
   on conflict do nothing;
   ```
3. Approve companions from `/#/internal/trust` (they also need an avatar and a
   120+ character bio to appear in Explore).

---

## Exactly what is removed vs preserved

**Removed (all rows):** every one of the 78 runtime tables (auth/session data,
accounts, profiles + profile_access, member/companion/coordinator profiles,
support_admins, availability + offers + packages, bookings + history + proposals,
conversation plans + slots + billing periods, conversations + messages + read
state, reviews + ratings, concerns + reports + user_blocks + moderation events,
payments + orders + credit ledgers + stripe customers + connected accounts,
refunds, earnings, transfer attempts + settlement adjustments, disputes + notes +
alerts + evidence, reconciliation findings/runs/audit, financial operation runs/
items/events, call sessions/participants/attendance/audits, guest invitations,
notifications + preferences, email outbox, and every Stage 3D/3E/v1 fixture row),
then `public.accounts`, then all `auth.users`; plus all user-owned Storage
objects.

**Preserved:** the Supabase project; all migrations; all tables, schemas, RLS
policies, triggers, functions/RPCs; Edge Functions and their secrets; Storage
**buckets**; cron definitions and Vault secrets; and configuration rows in
`consent_policies`, `interests`, `platform_config`,
`platform_commission_config`, `platform_service_fee_config`,
`financial_operations_config`, and `financial_operation_controls` (kept in their
**disabled / ceilings-zero safe state** — only the nullable
`updated_by_account_id` audit pointers are detached so the accounts can be
removed), plus `call_config`.

## Scratch proof (what was verified)

The real migrations 0001–0096 were applied to a throwaway Postgres 16 database
(Supabase objects stubbed). The FK **delete order in `reset-pilot-data.sql` is
derived by topological sort of the actual foreign-key graph** (87 tables, 200
FKs, no cycles). Representative data was seeded — members, a coordinator, a
**discoverable** companion + a pending one, support admin, availability + offers,
a booking, a recurring plan, a conversation + message, review, block, concern,
earning + transfer attempt, notifications, Storage objects, and Stage-fixture
users — then the reset was executed with foreign keys and triggers enforced.
Result:
- every runtime count → **0** (no orphan profiles; **discoverable companions =
  0**; all auth users removed);
- preserved config all survive; financial controls all `disabled`;
- schema objects unchanged (tables 87, functions 208, policies 69, triggers 33);
- a fresh signup afterwards provisions a new account (`ensure_current_account()`
  → one accounts row).
