# 2G4D — post-conversation automation (migration 0037)

Scheduled processing for funded conversations. Adds automation + the
outstanding in-app notifications only; it reuses the 0034–0036 financial
state machine and never duplicates it. No Stripe transfers, payouts, refunds,
email, SMS or push in this phase.

## What runs

One orchestrator, `public.process_post_conversation_tasks()`, runs the four
child batches in order (all service-role only, all idempotent):

1. `create_review_prompts()` — Coordinator "How did the conversation go?"
   notification per funded booking after `ends_at` (Home Needs-attention also
   surfaces it). Dedupe `review-prompt:{booking}`.
2. `create_companion_attendance_reminders()` — Companion "Confirm your
   conversation" 2 hours after `ends_at` while no final attendance exists.
   Dedupe `attendance-reminder-2h:{booking}`.
3. `resolve_unconfirmed_attendance()` — 24-hour fallback from trusted LiveKit
   segments (both ≥2 min → apparent completion; Companion ≥10 min & Member
   <2 min → likely no-show; else held for manual review). Reuses
   `make_earning_payable`. Adds neutral role-aware notifications
   (`fallback-completed:{booking}`, `fallback-attendance:{booking}`,
   `attendance-review:{booking}`).
4. `release_eligible_earnings()` — the unchanged 0034 12-hour release
   (took_place + end+12h + no open issue → `payable`, `payable_at` once,
   `earning_payable:{earning}` notification).

Any open issue blocks every automatic release. Safety/conduct issues (high
priority) always override attendance evidence. Issues never expire.

## Error policy

Each child runs in its own subtransaction. A child failure rolls back only
that child's writes, is recorded in `error_detail`, and sets the run status to
`error` — never a silent `ok`. Children that succeeded (including the financial
release) still commit. Failures are visible in `public.post_conversation_run_audit`
and in the returned JSON. We deliberately do NOT abort the whole run on one
child's failure (that would discard already-correct financial work).

## Scheduling

Preferred: Supabase Postgres Cron (`pg_cron`) invokes the orchestrator every
15 minutes. There is no public/unauthenticated batch endpoint. The migration
registers the job only when `pg_cron` is available, idempotently, and skips
registration otherwise (with a notice).

A reminder "due" at 2 hours may arrive within the next 15-minute interval —
that is acceptable; no second-level timing is claimed.

### Manual invocation (local dev / CI, or when pg_cron is unavailable)

Run in the Supabase SQL editor (as `postgres`) or via a service-role
connection:

```sql
select public.process_post_conversation_tasks();
```

Or invoke a single batch:

```sql
select public.create_review_prompts();
select public.create_companion_attendance_reminders();
select public.resolve_unconfirmed_attendance();
select public.release_eligible_earnings();
```

Inspect recent runs:

```sql
select started_at, finished_at, status, review_prompts_created, reminders_created,
       attendance_resolved, earnings_released, error_detail
from public.post_conversation_run_audit
order by started_at desc limit 20;
```

## Deploy checklist

1. Apply `supabase/migrations/0037_completion_automation.sql`.
2. `select pg_notify('pgrst', 'reload schema');`
3. Confirm the cron job exists (hosted): `select jobname, schedule from cron.job;`
   — expect `process-post-conversation-tasks` at `*/15 * * * *`.
4. If `pg_cron` is not enabled on the project, enable it (dashboard →
   Database → Extensions) and re-run the guarded `do $$ ... $$` block, or
   schedule `process_post_conversation_tasks()` from an external service-role
   scheduler. Do NOT expose it to `anon`/`authenticated`.

## Notification events + dedupe keys (this phase)

| Event (type)             | Recipient    | Dedupe key                          |
|--------------------------|--------------|-------------------------------------|
| `review_prompt`          | Coordinator  | `review-prompt:{booking}`           |
| `attendance_reminder`    | Companion    | `attendance-reminder-2h:{booking}`  |
| `conversation_completed` | both         | `fallback-completed:{booking}`      |
| `attendance_confirmed`   | Companion    | `fallback-attendance:{booking}`     |
| `attendance_updated`     | Coordinator  | `fallback-attendance:{booking}`     |
| `attendance_under_review`| both         | `attendance-review:{booking}`       |
| `earning_payable`        | Companion    | `earning_payable:{earning}` (0034)  |

The notification centre and Home Needs-attention render these generically
(title/body) and deep-link via `related_booking_id → /conversations/{booking}`,
so no frontend change was required.
