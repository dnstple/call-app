# Automation design — Builds 1 & 2 (PROPOSAL, awaiting approval)

Status: **approved 24 Nov 2026; built in dry-run mode. Nothing migrated, deployed or sent yet.** How to run it: [RUNBOOK.md](RUNBOOK.md).
Sender identity (confirmed 24 Nov 2026): **`info@apricoti.co.uk` via Microsoft Graph — the only permitted sender.**

---

## 0. Shared foundations

### Where things run
| Piece | Runs as | Why |
|---|---|---|
| Schema + erasure function | Migrations `0219`–`0221` (run by hand) + fingerprint | No ledger; every migration ships with its fingerprint query |
| Build 1 triage + approve/execute | **Local Node CLI** in `scripts/automation/` (service-role key + Anthropic key in a local, git-ignored `.env.automation`) | Backlog is a one-off-ish batch; you run it, read the report, approve. Service role never leaves the server/your machine |
| Build 2 daily send / follow-up / poll | **Supabase Edge Functions** (`charity-outreach-run`, `charity-outreach-poll`) triggered by `pg_cron` + `pg_net` with `x-billing-secret` (same pattern as existing crons) | Must run unattended on weekdays |
| Review UI | New internal page `/internal/automation` (support-admin only), reads via RPCs | Lets you approve batches without the CLI |

### Graph sender — two locks, not one
1. **Tenant lock (Entra ID).** App registration with *application* permissions `Mail.Send` + `Mail.ReadWrite` (drafts give us message ids; flagging replies), then an Exchange **ApplicationAccessPolicy** scoping the app to the `info@apricoti.co.uk` mailbox only. Even a code bug cannot send as anyone else. (You'll need to do this in the Microsoft 365 admin centre — I'll write the exact steps/PowerShell.)
2. **Code lock.** `_shared/graphMail.ts`:
   - `const ALLOWED_SENDER = 'info@apricoti.co.uk'` — a constant, **not** env-overridable.
   - `sendMail(from, …)` throws `SenderNotAllowed` unless `from.toLowerCase() === ALLOWED_SENDER`; the Graph URL is built from the constant, never from input (`/users/info@apricoti.co.uk/sendMail`).
   - Missing/invalid Graph credentials ⇒ throws `GraphUnavailable` and the run **stops** — no Resend/SMTP import exists in this module, so there is nothing to fall back to.
   - Unit tests prove it refuses `info@apricoti.com`, `INFO@apricoti.co.uk.evil.com`, other mailboxes, and empty creds.
3. **Kill switches** in a single `automation_controls` row: `outreach_live` (default **false**), `outreach_daily_cap` (default 25, hard max 30 enforced by a CHECK), `erasure_live` (default **false**). Dry-run is whatever these are when false.

---

## BUILD 1 — Contact-message agent

### Schema (migration 0219)
```
contact_triage                      -- one row per contact_messages row, latest decision
  message_id        uuid PK → contact_messages(id)
  category          text check in ('delete_account','refund_billing','technical',
                                   'companion_query','general','spam','needs_human')
  confidence        numeric(3,2)
  reasoning         text            -- why, for your review
  signals           jsonb           -- account found?, open dispute?, payment ≤30d?, active membership?, upcoming bookings?
  recommended_action text
  draft_reply       text            -- never sent automatically
  status            text check in ('proposed','approved','executed','rejected','skipped')
  model             text, triaged_at, approved_by, approved_at, executed_at

gdpr_erasure_log                    -- append-only audit; no update/delete grants
  id uuid PK, account_id uuid, source_message_id uuid,
  requested_at, approved_by, executed_at,
  dry_run boolean, rows_affected jsonb,   -- per table
  storage_objects_removed text[], outcome text, error text
```
Both RLS-on, RPC/service-role only.

### Erasure routine (migration 0220)
`app_private.gdpr_erase_account(p_account uuid, p_source_message uuid, p_dry_run boolean default true) returns jsonb`
- **Idempotent**: returns "already erased" if PII is already null.
- Nulls/blanks: `profiles` (names, headline/bio → `''`, `photo_url`, `avatar_path` captured *first* so the CLI can delete the storage objects), `profile_private_details` (all PII cols), `accounts` (`display_name`, `phone_e164`, `phone_verified*`), `landing_leads` / `signup_step_events` rows matching their email/phone, `contact_messages.name/email` on their own messages (message text kept but redacted).
- `auth.users`: email → `erased+<id>@invalid`, phone/`phone_confirmed_at` null, **`banned_until = infinity`**; delete the `auth.identities` row where `provider='phone'`.
- **Never `delete from auth.users`** — `accounts` cascades from it and would wipe bookings/earnings history.
- Adds `email_suppressions (account_id, 'all')` so nothing ever re-contacts them.
- Dry-run executes inside a transaction and **rolls back**, returning exact row counts — so the report shows precisely what would change.
- Avatars deleted afterwards by the CLI through the Storage API (trigger blocks SQL deletes); result written back into the log.

### Triage logic
1. Pull every `handled = false` message + its account context (role, membership status, last payment, open `payment_disputes`, refunds, upcoming bookings, managed-member links via `profile_access`).
2. Claude (latest Sonnet) classifies with structured output → `contact_triage`. Message with no matching account ⇒ email lookup; still nothing ⇒ `needs_human`.
3. **Hard deterministic overrides** (code, not model) force `needs_human` for a delete request when: confidence < 0.85; open dispute; payment/refund in last 30 days; active/starter membership with unused credits; upcoming booking; the account is a **coordinator with managed members** or **a companion with unpaid earnings**; or the sender's email doesn't match the account's.

### Workflow
```
npm run contact:triage      # dry-run: writes proposals, prints/saves report
npm run contact:report      # counts per category, proposed erasures, needs-human list → docs/automation/reports/*.md
npm run contact:approve -- --batch <id>   # you approve (or per-id)
npm run contact:execute -- --batch <id>   # refuses unless erasure_live = true AND items approved
```
Execute = erase → log → mark message `handled`, `handled_at`, resolution recorded in `contact_triage`. Non-delete categories: mark handled only after you approve the drafted reply/resolution. Draft replies get a "Open in Outlook" link (existing pattern) — **no send from code in this build**.

---

## BUILD 2 — UK-charity outreach

### Schema (migration 0221)
```
charities
  id, name, charity_number (Charity Commission, unique nullable), website,
  contact_email (unique, lower-cased), contact_name, category, region, source, notes, created_at

charity_outreach                    -- one campaign thread per charity
  id, charity_id → charities, status check in ('queued','sent','followed_up_1',
       'followed_up_2','replied','bounced','unsubscribed','do_not_contact'),
  message_variant text, queued_at, first_sent_at, fu1_sent_at, fu2_sent_at,
  replied_at, bounced_at, closed_at,
  graph_conversation_id, internet_message_ids text[], last_error

charity_outreach_messages           -- every email actually sent (or rendered in dry-run)
  id, outreach_id, step ('initial','fu1','fu2'), variant, subject, body_html,
  dry_run bool, sent_at, graph_message_id, internet_message_id, run_id

charity_outreach_variants           -- named copy; A/B = set more than one active + weights
  key PK, step, subject_tpl, body_tpl, active bool, weight int

charity_suppressions                -- email OR domain; checked on every send
  value PK, kind ('email','domain'), reason ('unsubscribed','bounced','manual','replied_stop'), created_at

charity_outreach_runs               -- one per scheduler run: planned/sent/skipped counts, dry_run, cap
```
Fingerprint query provided with each migration. View `charity_outreach_variant_stats` = sent / replied / bounced per variant (A/B later is a config flip).

### Jobs
- **Daily (Mon–Fri ~10:00 UK)** `charity-outreach-run`: pick ≤ `outreach_daily_cap` (hard ≤30) `queued` rows not suppressed → render variant with `{charity_name}`, `{member_count}` → send via `graphMail` → record. Cap counted from `charity_outreach_messages` *today*, so re-runs can't double up.
- **Follow-ups** (same function, after initial pass, sharing the daily cap): `sent` & no reply after **4 working days** → FU1; after **10 days** → FU2 (sent as a reply in the same Graph thread); FU2 + 7 days with no reply → `do_not_contact`.
- **Poll (every 30 min, weekdays)** `charity-outreach-poll`: Graph inbox delta query → match by `conversationId`/`In-Reply-To` → `replied` (stops all follow-ups) or NDR → `bounced` + suppress. Replies are **flagged in Outlook / listed on the internal page — never answered**. Unsubscribe link and "reply STOP" → suppress.
- **Member count**: `public.outreach_member_count()` = profiles with role `member` (incl. coordinator-managed), excluding erased/blocked/test accounts; rounded *down* ("over 900"). Rendered live at send time; dry-run shows the actual number.

### Compliance (PECR / UK GDPR, B2B)
Corporate addresses only (generic info@/hello@ or named role contacts from public sources), legitimate-interest note recorded per charity source, clear sender identity + postal address footer, one-click unsubscribe (HMAC token → existing `email-unsubscribe` pattern, new `charity` category), suppression checked by email **and** domain.

### Dry-run deliverable
Seed 5 test charities (addresses you control) → `npm run outreach:dryrun` renders today's list + the exact HTML emails into `docs/automation/reports/outreach-<date>.md` without calling Graph `sendMail`.

---

## Decisions (approved with the design, 24 Nov 2026; defaults taken where not stated)
1. ~~Anthropic API~~ **Changed 25 Nov:** triage runs as a scheduled Claude Code task on Daniel's normal plan usage (no API key). The CLI gathers data (`pending`) and validates and stores the session's verdicts (`ingest`), with the same deterministic safety rules.
2. Daniel does the Entra/Exchange setup with GRAPH_SETUP.md. The Graph secret goes into Supabase secrets.
3. Erasure anonymises and bans the login. It never deletes `auth.users`.
4. A deletion request from a coordinator with managed members goes entirely to needs_human, and `gdpr_erase_account` also refuses it. (This replaces the earlier "erase coordinator only" idea; it's safer.)
5. Follow-ups: +4 working days, +10 days (at least 3 days after FU1), close 7 days after FU2.
6. **Still open:** the postal address for the PECR footer. Outreach can't go live until `automation_controls.outreach_postal_address` is set.
