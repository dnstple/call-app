# Financial Operations Runbooks (Stage 3C1)

Operational documentation for the **financial operations control plane** introduced in
`0073_financial_operations_control_plane.sql`. This control plane makes every future
financial run **explicit, scoped, auditable, rate-limited, dry-run capable, kill-switch
protected and idempotent**. Nothing in this stage moves money: actual controlled worker
activation is **Stage 3C2**, after this plane is hosted-validated.

> **Golden rule.** No support action ever requires running a *global* worker to process
> *one* record. Every operation is scoped to explicit record ids or a small bounded batch
> (maximum **25**). There is no global, unbounded execution path.

All commands below are **read-only** unless explicitly noted. No live secret values appear
in this document. The `/support/operations` page is DB-role protected (`SupportOnly` →
`app_private.is_support_admin()`); it is absent from normal navigation.

---

## Control states

Each control (`financial_operation_controls`) is one of:

| State | Meaning |
|---|---|
| `disabled` | No execution. Preview still works. **Default for every control.** |
| `dry_run_only` | Preview only; execution is rejected. |
| `scoped_execution` | Execution permitted **only** with explicit record ids (no server-filter batch). |
| `enabled` | Execution permitted for scoped and bounded-batch runs. |

Operational environments (`financial_operations_config.environment`), server-owned and
never inferred from a browser variable: `development`, `hosted_test`, `production_dry_run`,
`production_live`. Changed only through `support_set_financial_environment` (reasoned,
audited, optimistic; `production_live` needs the `ENABLE-PRODUCTION-LIVE` phrase).

### Raw workers are inert unless FOUR conditions hold (Stage 3C1 isolation)

A control being `enabled` is **not** sufficient to run a global/batch worker. Every raw
worker (`release_eligible_earnings`, `resolve_unconfirmed_attendance`, `process_plan_renewals`,
`claim_plan_transfers`, `recover_stale_transfers`, `claim_payment_refunds`,
`recover_stale_refunds`, `run_financial_reconciliation(_for_entities)`,
`process_dispute_deadline_alerts`) is inert unless **all** of these hold at once:

1. a **transaction-local approved-run context** for that exact operation is active — set only
   by `app_private.begin_scoped_execution()` after it locks and validates an approved,
   confirmed, unexpired operation run (this context cannot be forged or reused by a browser,
   an ordinary service-role RPC, a pg_cron job, or an Edge Function, because none of them run
   inside that transaction);
2. the environment is `production_live`;
3. the operation's own control is `enabled`;
4. the `production_live_operations` master control is `enabled`.

So in `development` / `hosted_test` / `production_dry_run`, **every raw worker is inert no
matter what any control is set to** — the active pg_cron jobs and settlement Edge Functions
are harmless without touching their schedules. Transition hardening: an individual control
**cannot** be set to `enabled` unless the environment is already `production_live`
(`enabled_requires_production_live`); arming the master needs its own dedicated phrase
`ARM-PRODUCTION-MASTER`; enabling a control while `production_live` needs `ENABLE-PRODUCTION-LIVE`.
Changing the environment alone, or the master alone, never makes a worker operative — all
four conditions plus an approved scoped run must agree. Expired controls read as `disabled`.

Two-person approval remains a documented later requirement.

---

## A. How to review financial readiness

1. Open **`/support/operations`** (support/operations admins only).
2. Read the **Readiness** counts. Severity colouring: red = critical, amber = warning.
   Equivalent RPC (read-only): `select public.support_financial_readiness();`
3. Review the **Kill-switch controls** panel — every control should read `disabled`
   during Stage 3C1.
4. Review **Recent operation runs** — `select public.support_recent_operation_runs(25);`

Readiness surfaces safe aggregate counts only (pending earnings, payable awaiting transfer,
stale processing transfers, retryable/permanent transfer failures, active/stale refunds,
unresolved disputes, disputes nearing deadline, active evidence reviews, unresolved
reconciliation findings, webhooks missing a result, plan-billing drift). It exposes no
Stripe secrets, provider payloads, bank/card data, private messages or review feedback.

## B. How to preview a scoped operation

Preview is **side-effect-free** on financial rows (no locks, no claims, no attempt/timestamp
changes, no notifications, no money, no Stripe).

1. On `/support/operations` choose an **Operation**, paste one or more **record ids**
   (bounded to the max batch size), enter a **reason**, click **Preview (dry-run)**.
2. Each row reports: `found`, `current_state`, `eligible`, `expected_next_state`,
   `blocking_reasons[]`, and whether an open issue / dispute / evidence hold blocks it.

Equivalent RPCs (read-only):
```sql
-- 1) request a preview run (mints an expiring run + opaque token)
select public.support_request_operation_run(
  'earning_release', 'preview', 'record_ids',
  array['<earning-uuid>']::uuid[], null, 'readiness spot check');
-- 2) generate the preview (records only run metadata; no financial mutation)
select public.support_preview_operation_run('<run-id>');
```

## C. How to execute one fixture/test record safely

Execution is **blocked** during Stage 3C1 by the default-disabled controls. When it is
enabled in Stage 3C2 it only ever runs the non-Stripe `earning_release` path over
explicitly-scoped ids. **Only ever execute against newly-created fixture rows** — never
against hosted/production financial data during validation.

Flow (request → preview → confirm → execute):
```sql
-- request an execute_scoped run for ONE fixture earning id
select public.support_request_operation_run(
  'earning_release', 'execute_scoped', 'record_ids',
  array['<fixture-earning-uuid>']::uuid[], null, 'fixture validation');
select public.support_preview_operation_run('<run-id>');       -- must preview first
select public.support_confirm_operation_run('<run-id>', '<token>');
-- turn the control on (audited, reasoned, optimistic-concurrency)
select public.support_set_financial_control('earning_release', 'disabled', 'scoped_execution', 'fixture validation');
select public.support_execute_operation_run('<run-id>', '<token>');   -- idempotent
```
Repeating the final call does **not** execute twice (the run records `executed_at`).

## D. How to stop all financial processing (kill switch)

1. Ensure every control reads `disabled` (they default to `disabled`).
2. To force a control off, run the audited transition (records an immutable event):
```sql
select public.support_set_financial_control('<control_name>', '<expected_current_state>', 'disabled', '<reason>');
```
3. Disabling the environment master switch:
```sql
select public.support_set_financial_control('production_live_operations', '<expected>', 'disabled', 'incident: halting live ops');
```
Disabling never requires the confirmation phrase — only **enabling** production-live does.
No control change ever runs a worker.

## E. Incident responses

| Symptom | First action (read-only) | Then |
|---|---|---|
| **Stuck processing transfer** | Preview `transfer_finalise` for the attempt id; confirm it is genuinely `processing` and older than the stale threshold (30 min). | Reconcile provider state in Stripe first; **never** reset the attempt row. Stage 3C2 wires the finalise executor. |
| **Retryable transfer failure** | Preview `transfer_claim` for the earning; check `blocking_reasons`. | Actionable immediately once the underlying cause is cleared; re-claim through a scoped run in 3C2. |
| **Permanent transfer failure** | Preview + read the transfer attempt state. | Investigate with Connect/Stripe; resolve via the reconciliation queue. Do not retry blindly. |
| **Refund missing a provider id** | Preview `refund_finalise`/`refund_claim`; inspect the refund state. | Reconcile the provider refund id before any retry; never fabricate a provider id. |
| **Unresolved dispute** | Preview `dispute_reconciliation`; check `internal_state`. | Handle through the existing dispute support ops; deadlines are governed by the dispute-deadline alerting. |
| **Evidence payout hold** | Preview `evidence_review_release`; check the review state. | Resolve through the existing evidence-review support workflow (reasoned release). |
| **Reconciliation finding** | Preview `financial_reconciliation` for the finding id. | Work the finding in the reconciliation queue; recheck re-runs read-only detection only. |

## F. What must never be done

- **Never** reset attempt rows (`companion_transfer_attempts`) or refund attempt counters.
- **Never** delete earnings.
- **Never** manually change `succeeded` / `processing` states by hand.
- **Never** retry Stripe without first reconciling provider state.
- **Never** run a global worker against unknown historical data.
- **Never** edit an applied migration (0001–0072 are immutable; 0073 once applied).
- **Never** mutate the protected booking `ba4f943c-3e8d-4d4c-900d-fa551ccc5387`.
- **Never** bulk-select the 177 historical diagnostic findings for execution.

## G. Pre-production sign-off checklist

- [ ] All controls read `disabled`; environment is not `production_live`.
- [ ] `0073` applied on the target project; PostgREST schema reloaded.
- [ ] Hosted Stage 3C1 tests green (controls, previews, run lifecycle, concurrency, firewall).
- [ ] Stage 3B1 / 3B2 and all transfer/refund/dispute/reconciliation tests still green.
- [ ] Readiness dashboard renders with no secrets and sensible counts.
- [ ] A fixture-scoped `earning_release` execute run validated end-to-end (request → preview
      → confirm → enable control → execute → idempotent repeat), then the control returned to
      `disabled`.
- [ ] Two-person approval requirement reviewed (see below).
- [ ] No financial cron enabled; reconciliation cron remains disabled.
- [ ] Stripe live mode **not** enabled; no live keys stored.

---

## Two-person approval — future requirement

Stage 3C1 gates production-live transitions behind a **confirmation phrase** (a second
safety parameter), not a real two-person approval, because the current support identity
model is single-role (`support_admins`). **Real dual-control approval is a documented
future requirement**: it needs a distinct "operations approver" identity plus a two-step
approve/apply record so that the requester and approver cannot be the same account. Do not
simulate it with a single identity.

---

## Historical-repair boundary (deferred, documented workflow)

**No historical data is repaired in Stage 3C1.** When scoped repair is later authorised, it
must follow this audited, one-record workflow — never a bulk backfill:

1. **Inspect one booking** (read-only) — gather its current financial state.
2. **Reconcile provider state** — compare against Stripe/Connect truth read-only.
3. **Generate a repair proposal** — a concrete, reviewable diff of intended changes.
4. **Require explicit approval** — reasoned, recorded, ideally dual-control (see above).
5. **Apply through an audited one-record repair function** — scoped to a single id, writing
   an immutable audit event; never a global sweep.
6. **Verify postconditions** — confirm the record reached the intended state and nothing
   else changed.

The protected booking `ba4f943c-3e8d-4d4c-900d-fa551ccc5387` **must not** be used as a
hosted fixture and **must not** be mutated. The 177 diagnostic findings **must not** be
bulk-selected for execution.
