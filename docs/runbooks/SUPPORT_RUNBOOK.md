# Support runbook — v1 pilot

## Daily
- Review `/internal/trust`: moderation queue, concerns, blocks, conflicts.
- Review `support_system_health()` for anomalies.

## Companion moderation
- Approve only complete, appropriate profiles. Suspend/reject require a reason.
- Approval does NOT change Stripe Connect/payout state (separate).

## Safeguarding concerns
- Triage high-priority (safeguarding/harassment/fraud/inappropriate) first.
- A qualifying concern auto-holds a still-pending payout — resolve via the
  existing issue/earning tools; never edit amounts directly.
- If someone is in immediate danger, advise contacting emergency services.

## Blocks
- Blocks are user-initiated. A block colliding with a future booking appears in
  the conflicts view — never auto-cancel or refund; contact both parties.

## Never do
- Edit customer payment amount, provider status, earning amount, commission,
  Stripe destination, transfer result, or any completed financial record.
