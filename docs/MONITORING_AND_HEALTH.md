# Monitoring & operational health — v1 pilot

## Support health dashboard
`support_system_health()` (support-only RPC) returns live counts: pending &
failed emails, open safeguarding concerns, companions pending moderation, held
earnings, and active blocks. Surfaced at `/internal/trust` and available to any
authorised support account.

## Email outbox
`support_email_outbox_overview()` returns pending/sent/failed/suppressed counts.
Watch `failed` — a persistent non-zero value means the (future) provider
dispatcher is erroring. `suppressed` is expected (recipients who opted out).

## Scheduled jobs (pg_cron, hosted)
- `charge-due-plan-periods` (daily) — recurring plan billing.
- `booking-reminders-hourly` (hourly, 0094) — pre-conversation reminders.
- Completion automation (0037) — attendance reminders, review prompts.
Each writes to its run-audit table; check for repeated errors.

## What to watch daily
1. `support_system_health()` — anomalies in held earnings / open concerns.
2. Moderation queue — approve/suspend new Companions promptly.
3. Safeguarding concerns — triage high-priority first.
4. Block↔future-booking conflicts (`support_block_conflicts_overview`).
5. Payment reconciliation surfaces (Stage 3D/3E support pages).
