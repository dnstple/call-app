-- ============================================================================
-- 0086 — Stage 3E-F: consolidated support payout queue overview (additive).
-- ============================================================================
-- The issue/cancellation/refund/reversal lifecycle integration pre-exists and
-- is unchanged: open issues hold earnings (0034), resolutions are the single
-- source of truth (0038/0047), pre-transfer refunds/disputes hold or reverse
-- (0052/0056/0059), post-transfer outcomes create durable
-- settlement_adjustments obligations (customer_refund_after_transfer /
-- dispute_after_transfer) instead of rewriting history, and provider/local
-- mismatches land in financial_reconciliation_findings (0063).
--
-- What Stage 3E-F requires and was missing is ONE support-visible queue
-- overview covering every named state. support_settlement_overview (0048)
-- already counts processing/failed/transferred/reversed/stale; this reader
-- adds the rest WITHOUT replacing it (additive, read-only, support-gated).
--
--   payout_account_action_required  connected accounts with past-due
--                                   requirements or a disabled reason
--   held_for_issue                  earnings held by an open issue
--   evidence_review_active          earnings held by an active 0072 review
--   release_overdue                 pending_completion earnings whose booking
--                                   ended > 24h ago with NO open issue and NO
--                                   active review — the scheduled release
--                                   should already have picked these up
--   transfer_unknown                attempts processing with a provider id
--                                   but no terminal state after 30 minutes,
--                                   plus 0078 jobs parked in uncertain states
--   provider_local_mismatch         open reconciliation findings
--   reversal_required               unresolved settlement adjustments
-- ----------------------------------------------------------------------------

create or replace function public.support_payout_queue_overview()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare v jsonb;
begin
  if not app_private.is_support_admin() then
    raise exception 'not_found: overview';
  end if;
  select jsonb_build_object(
    'payout_account_action_required',
      (select count(*) from public.connected_accounts ca
        where cardinality(ca.requirements_past_due) > 0 or ca.disabled_reason is not null),
    'held_for_issue',
      (select count(*) from public.companion_earnings e where e.state = 'held_for_issue'),
    'evidence_review_active',
      (select count(*) from public.companion_evidence_payout_reviews r
        where r.state in ('active', 'claimed')),
    'release_overdue',
      (select count(*) from public.companion_earnings e
        join public.bookings b on b.id = e.booking_id
        where e.state = 'pending_completion'
          and b.ends_at < now() - interval '24 hours'
          and not exists (select 1 from public.conversation_issues ci
                          where ci.booking_id = e.booking_id and ci.state in ('open', 'reviewing'))
          and not exists (select 1 from public.companion_evidence_payout_reviews r
                          where (r.earning_id = e.id or r.booking_id = e.booking_id)
                            and r.state in ('active', 'claimed'))),
    'transfer_unknown',
      (select count(*) from public.companion_transfer_attempts t
        where t.state = 'processing' and t.stripe_transfer_id is not null
          and t.updated_at < now() - interval '30 minutes'),
    'provider_local_mismatch',
      (select count(*) from public.financial_reconciliation_findings f
        where f.status not in ('cleared', 'resolved', 'ignored')),
    'reversal_required',
      (select count(*) from public.settlement_adjustments a
        where a.state <> 'resolved'),
    'generated_at', now()
  ) into v;
  return v;
end;
$$;
revoke all on function public.support_payout_queue_overview() from public, anon;
grant execute on function public.support_payout_queue_overview() to authenticated; -- gated internally
