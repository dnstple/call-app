-- ============================================================
-- 2G6A fix — restore issue-resolution notifications (migration 0047).
--
-- 0046 redefined resolve_conversation_issue to cap customer credit by the
-- per-occurrence payer_charge_minor, but was rebuilt from the OLD 0034 body,
-- which only notified the reporter. That dropped the role-aware Companion +
-- Coordinator resolution notifications (and their dedupe keys) added in 0038,
-- regressing the validated 2G4E test.
--
-- This redefinition is the 0038 body VERBATIM (all notifications, dedupe keys
-- 'issue-resolved-companion:' / 'issue-resolved-coordinator:', the neutral
-- shared system event, and the four outcomes) PLUS the only 0046 change: the
-- occurrence-level customer-charge cap (v_charge). The internal note is still
-- never included in any user notification.
-- ============================================================
create or replace function public.resolve_conversation_issue(
  p_issue uuid, p_outcome text, p_note text,
  p_companion_minor integer, p_credit_minor integer, p_idempotency text
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_issue public.conversation_issues;
  v_e public.companion_earnings;
  v_order public.payment_orders;
  v_charge integer;
begin
  if not app_private.is_support_admin() then
    raise exception 'not_found: issue';
  end if;
  if exists (select 1 from public.issue_resolutions where idempotency_key = p_idempotency) then
    return jsonb_build_object('ok', true, 'repeat', true);
  end if;
  select * into v_issue from public.conversation_issues where id = p_issue for update;
  if v_issue.id is null then raise exception 'not_found: issue'; end if;
  if v_issue.state = 'resolved' then
    return jsonb_build_object('ok', true, 'repeat', true);
  end if;
  if p_note is null or trim(p_note) = '' then
    raise exception 'note_required: add a resolution note';
  end if;
  select * into v_e from public.companion_earnings where id = v_issue.earning_id for update;
  select * into v_order from public.payment_orders where id = v_e.payment_order_id;
  -- 2G6A: occurrence-scoped customer charge (equals order.total_minor for
  -- directly-funded one-offs; the single conversation's cost for plan periods).
  v_charge := coalesce(v_e.payer_charge_minor, v_order.total_minor);

  if p_outcome = 'companion_payable_full' then
    p_companion_minor := v_e.net_minor; p_credit_minor := 0;
  elsif p_outcome = 'customer_credit_full' then
    p_companion_minor := 0; p_credit_minor := v_charge;
  elsif p_outcome = 'issue_dismissed_release' then
    p_companion_minor := v_e.net_minor; p_credit_minor := 0;
  elsif p_outcome = 'partial_resolution' then
    if p_companion_minor is null or p_credit_minor is null
       or p_companion_minor < 0 or p_credit_minor < 0
       or p_companion_minor > v_e.net_minor
       or p_credit_minor > v_charge
       or (p_companion_minor + p_credit_minor) > v_charge then
      raise exception 'invalid_amounts: partial resolution exceeds the payment';
    end if;
  else
    raise exception 'invalid_outcome: unknown resolution outcome';
  end if;

  if p_credit_minor > 0 then
    perform public.issue_account_credit(
      v_e.payer_account_id, p_credit_minor, 'refund_resolution', v_issue.id,
      'Issue resolution credit', 'resolution-credit-' || v_issue.id::text);
  end if;

  update public.companion_earnings
     set state = case when p_companion_minor > 0 then 'payable' else 'reversed' end,
         net_minor = case when p_outcome = 'partial_resolution' then p_companion_minor else net_minor end,
         payable_at = case when p_companion_minor > 0 then coalesce(payable_at, now()) else payable_at end,
         updated_at = now()
   where id = v_e.id;

  insert into public.issue_resolutions
    (issue_id, earning_id, resolver_account_id, outcome, note,
     companion_amount_minor, credit_amount_minor, idempotency_key)
  values (v_issue.id, v_e.id, auth.uid(), p_outcome, trim(p_note),
          p_companion_minor, p_credit_minor, p_idempotency);

  update public.conversation_issues
     set state = 'resolved', resolved_at = now(), updated_at = now()
   where id = v_issue.id;

  -- Role-aware, deduplicated resolution notifications (Companion + Coordinator).
  -- Neutral wording; no complaint text, amounts (beyond the Coordinator's own
  -- credit acknowledgement), internal note or resolver identity.
  if p_outcome = 'customer_credit_full' then
    perform app_private.notify_account(
      v_e.companion_account_id, 'issue_resolved', 'Issue resolved',
      'The conversation issue has been resolved. No earnings are due for this conversation.',
      v_issue.booking_id, 'issue-resolved-companion:' || v_issue.id::text);
    perform app_private.notify_account(
      v_e.payer_account_id, 'account_credit_issued', 'Account credit issued',
      'Account credit has been added following the conversation review.',
      v_issue.booking_id, 'issue-resolved-coordinator:' || v_issue.id::text);
  elsif p_outcome = 'partial_resolution' then
    perform app_private.notify_account(
      v_e.companion_account_id, 'issue_resolved', 'Issue resolved',
      'The conversation issue has been resolved and your earning has been updated.',
      v_issue.booking_id, 'issue-resolved-companion:' || v_issue.id::text);
    perform app_private.notify_account(
      v_e.payer_account_id, 'issue_resolved', 'Issue resolved',
      'The conversation issue has been reviewed and a resolution has been applied.',
      v_issue.booking_id, 'issue-resolved-coordinator:' || v_issue.id::text);
  else
    -- companion_payable_full or issue_dismissed_release
    perform app_private.notify_account(
      v_e.companion_account_id, 'issue_resolved', 'Issue resolved',
      'The conversation review is complete and your earnings are ready for payout.',
      v_issue.booking_id, 'issue-resolved-companion:' || v_issue.id::text);
    perform app_private.notify_account(
      v_e.payer_account_id, 'issue_resolved', 'Issue resolved',
      'The conversation issue has been reviewed and resolved.',
      v_issue.booking_id, 'issue-resolved-coordinator:' || v_issue.id::text);
  end if;

  -- One neutral shared system event in the conversation thread (no private
  -- text/amounts/identities). Best-effort: skip silently if no thread exists.
  begin
    perform app_private.post_system_message(c.id, 'conversation_issue_resolved', '{}'::jsonb,
      'issue_resolved:' || v_issue.id::text)
    from public.conversations c, public.bookings b
    where b.id = v_issue.booking_id
      and c.member_profile_id = b.member_profile_id
      and c.companion_profile_id = b.companion_profile_id;
  exception when others then null;
  end;

  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.resolve_conversation_issue(uuid, text, text, integer, integer, text)
  from public, anon;
grant execute on function public.resolve_conversation_issue(uuid, text, text, integer, integer, text)
  to authenticated; -- internally gated by is_support_admin()

select pg_notify('pgrst', 'reload schema');
