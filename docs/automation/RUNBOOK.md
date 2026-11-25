# Automation runbook: contact agent + charity outreach

Design: [DESIGN.md](DESIGN.md) · Graph setup: [GRAPH_SETUP.md](GRAPH_SETUP.md)

**Safety model.** Everything is a dry run by default. Three separate things must all be switched on before anything irreversible happens:
1. a database switch in `automation_controls` (`erasure_live`, `outreach_live`), which defaults to **false**;
2. an explicit CLI flag or request field (`--live --confirm`, or `{"dryRun": false}`);
3. a human approval step: approved triage items for erasures, and the go-live cron for outreach.

**Sender:** only `info@apricoti.co.uk` via Microsoft Graph. This is enforced in code, by a CHECK constraint, and by the Exchange access policy. If Graph isn't available, nothing is sent.

---

## 0. One-time setup
1. **Apply migrations by hand** in the Supabase SQL editor, in order: `0219_automation_foundation.sql`, `0220_gdpr_erase_account.sql`, `0221_charity_outreach.sql`.
2. **Fingerprint:** run `docs/automation/sql/fingerprints.sql`. Every column should be `true`. Also run the STATUS.md §8 check (0218).
3. **Local env:** `.env.automation` (git-ignored) holds `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (done 24 Nov). No Anthropic API key: classification runs in a scheduled Claude Code session on Daniel's normal plan usage.
4. **Graph:** follow GRAPH_SETUP.md, then run `npm run graph:selftest`.
5. **Deploy the edge functions** (none of them sends anything until outreach is live):
   ```powershell
   supabase functions deploy charity-outreach-run --no-verify-jwt
   ```
   ```powershell
   supabase functions deploy charity-outreach-poll --no-verify-jwt
   ```
   ```powershell
   supabase functions deploy charity-unsubscribe --no-verify-jwt
   ```

---

## A. Contact backlog (Build 1)

| Step | Command | Changes anything? |
|---|---|---|
| A1 Triage (automatic) | Scheduled task **Apricoti contact inbox triage**, weekdays ~09:05 while the Claude app is open (runs on next launch if it was closed). It runs `contact -- pending`, classifies each message per [TRIAGE_INSTRUCTIONS.md](TRIAGE_INSTRUCTIONS.md), saves `reports/verdicts-<date>.json`, runs `contact -- ingest --file …` and `report`. To run it now, use **Run now** on the task in the app's Scheduled sidebar | Writes `contact_triage` proposals only, and is never allowed to approve or execute |
| A2 Report | `npm run contact -- report --batch <id>` | Dry-runs every proposed erasure (fully rolled back, but logged in `gdpr_erasure_log` as `dry_run`) and writes `docs/automation/reports/contact-<date>-<batch>.md` |
| A3 Review | Read the report | No |
| A4 Approve | `npm run contact -- approve --batch <id> --by "Daniel" [--exclude 1a2b3c4d,…]` then the same command with `--confirm` | Marks items `approved` |
| A5 Execute (dry) | `npm run contact -- execute --batch <id>` | No |
| A6 Go live (erasures) | SQL: `update public.automation_controls set erasure_live = true, updated_by = 'Daniel', updated_at = now();` | Switch |
| A7 Execute | `npm run contact -- execute --batch <id> --live --confirm` | **Yes, permanent.** Erases, removes avatars via the Storage API, logs to `gdpr_erasure_log`, marks messages handled |
| A8 Switch off | SQL: `update public.automation_controls set erasure_live = false, updated_at = now();` | Switch |

**How the agent decides.** Claude proposes a category. Deterministic rules in `scripts/automation/triageRules.ts` then force **needs_human** if any of these apply:
- confidence below 0.85, an ambiguous message, or no explicit request;
- no matching account, or the email doesn't match the account;
- a coordinator with managed members;
- an open dispute, pending refund or payment in the last 30 days;
- an upcoming booking, unpaid companion earnings, or an active membership with unused credits.

`gdpr_erase_account` re-checks the hard blockers itself at execution time.

**What erasure keeps.** Bookings, payments, memberships, credits, earnings, disputes and signed agreements stay as financial and legal records attached to the anonymised id. The login is anonymised and banned, never deleted, because deleting it would cascade and destroy that history.

**needs_human** items are never approved by the CLI. Handle them in `/internal/contact`.
**Replies** are drafts only. The report has an "Open in Outlook" link for each, so they send from info@ and land in Sent Items.

**Reports contain personal data.** `docs/automation/reports/` is git-ignored. Delete the reports when you've finished with them.

---

## B. Charity outreach (Build 2)

| Step | Command | Changes anything? |
|---|---|---|
| B1 Seed test set | `npm run outreach -- ingest --csv docs/automation/test-charities.example.csv --source test_seed --test`, then the same with `--confirm` | Inserts test charities. **Put addresses you control in the CSV first.** |
| B2 Dry run (local) | `npm run outreach -- dryrun` | No. Writes `docs/automation/reports/outreach-<date>.md` with the exact emails |
| B3 Dry run (deployed) | Call `charity-outreach-run` with `{}` (an admin bearer token or `x-billing-secret`) | Records `dry_run` rows only |
| B4 Go live | ① set the footer address: `update public.automation_controls set outreach_postal_address = '<address>' …;` ② `update public.automation_controls set outreach_live = true, updated_by='Daniel', updated_at=now();` ③ run `docs/automation/sql/go_live_schedule.sql` | **Yes.** Weekday sends start at the next 09:30 UTC |
| B5 Watch | `npm run outreach -- status` | No |
| Stop | `update public.automation_controls set outreach_live = false …;` (and optionally unschedule the jobs; see the SQL file) | Switch |

**Caps.** The daily cap is `outreach_daily_cap` (default 25). A database CHECK stops it going above 30, and the code also caps at 30. The cap counts real sends from the ledger (UK date) and is re-checked before every send, and the same step can never be sent twice to one thread (unique index). Sends are 2.5 seconds apart.

**Cadence.** Follow-ups go first, then new charities. FU1 goes 4 working days after the first email and FU2 10 days after it (never within 3 days of FU1), both in the same thread. 7 days after FU2 with no reply, the thread is closed as `do_not_contact`.

**Replies.** `charity-outreach-poll` reads the info@ inbox every 30 minutes:
- a reply sets the thread to `replied` and stops follow-ups;
- an "unsubscribe" or "remove us" reply sets `unsubscribed` and adds the address to the suppression list;
- a bounce (NDR) sets `bounced` and adds the address to the suppression list.

Replies are **flagged in Outlook** for you. Nothing ever answers them.

**Member figure.** `outreach_member_count()` is computed live at send time. It counts member profiles and excludes hidden, deactivated, erased and @apricoti.co.uk accounts. The figure is rounded **down** ("more than 950"); below 100 it isn't quoted at all.

**A/B testing later.** Add rows to `charity_outreach_variants` (for example `initial_b`, `fu1_b`, `fu2_b`) with `active = true` and a `weight`. New charities are then split by weight, and follow-ups stay on the same letter. Compare variants in `charity_outreach_variant_stats`.

**Sourcing charities.** Use `ingest` with a CSV (`name,contact_email,charity_number,website,contact_name,category,region,notes`). Use published organisational contact addresses only (UK PECR B2B), and record the source in `--source`. Duplicates and suppressed addresses are skipped automatically.

---

## Troubleshooting
- `automation_controls unavailable`: 0219 isn't applied. Run the fingerprint.
- `graph_unavailable`: Graph credentials are missing or wrong, the secret has expired, or the access policy denies access. Outreach is stopped (by design). Run `npm run graph:selftest`.
- `sender_misconfigured`: someone edited `outreach_sender`. The CHECK constraint should make this impossible, so investigate.
- An erasure returns `error`: the whole erasure rolled back. The error is stored in `gdpr_erasure_log.error` and `contact_triage.last_error`.
