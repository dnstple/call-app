-- ============================================================
-- 2G4E — protected internal issue-review queue (migration 0038).
-- Controlling design: docs/2g4-completion-architecture.md + 0034–0037.
--
-- Additive ONLY. Reuses the deployed issue/earning/credit machinery:
--   * public.resolve_conversation_issue()  (0034) — the ONLY authoritative,
--     atomic, idempotent resolution path. Redefined here solely to add
--     role-aware, deduplicated resolution notifications + a neutral shared
--     system event; the financial logic is byte-for-byte unchanged.
--   * public.issue_account_credit()         (0030) — 12-month credit ledger.
--   * app_private.is_support_admin()        (0034) — DB-backed support role.
--   * app_private.notify_account()          (0032) — deduped notifications.
-- No new issue/earning/credit tables. No Stripe transfers/payouts/refunds.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Support-authorisation reader for the browser.
--    app_private.is_support_admin() is not on the PostgREST-exposed schema;
--    this public wrapper lets the route guard ask the SERVER (never a
--    client boolean) whether the current account is support/admin.
-- ------------------------------------------------------------
create or replace function public.am_i_support()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app_private.is_support_admin();
$$;
revoke all on function public.am_i_support() from public, anon;
grant execute on function public.am_i_support() to authenticated;

-- ------------------------------------------------------------
-- 2. Queue-filter indexes.
-- ------------------------------------------------------------
create index if not exists conversation_issues_state_priority_idx
  on public.conversation_issues (state, priority, created_at desc);
create index if not exists conversation_issues_category_idx
  on public.conversation_issues (category);
create index if not exists conversation_issues_reporter_role_idx
  on public.conversation_issues (reporter_role);

-- ------------------------------------------------------------
-- 3. Safe internal queue reader (support/admin only).
--    Returns ONLY list-view fields; never the complaint description.
-- ------------------------------------------------------------
create or replace function public.get_internal_issue_queue(
  p_states text[] default null,
  p_priority text default null,
  p_category text default null,
  p_reporter_role text default null
)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not app_private.is_support_admin() then
    raise exception 'not_found: queue';
  end if;
  select coalesce(jsonb_agg(x.row order by x.high desc, x.created_at desc), '[]'::jsonb)
  into v_result
  from (
    select jsonb_build_object(
             'issue_id', i.id,
             'state', i.state,
             'priority', i.priority,
             'category', i.category,
             'reporter_role', i.reporter_role,
             'booking_id', i.booking_id,
             'member_name', nullif(trim(mp.first_name || ' ' || mp.last_name), ''),
             'companion_name', nullif(trim(cp.first_name || ' ' || cp.last_name), ''),
             'conversation_at', b.starts_at,
             'duration_minutes', b.duration_minutes,
             'created_at', i.created_at,
             'updated_at', i.updated_at,
             'earning_state', e.state,
             'held_minor', e.net_minor,
             'currency', coalesce(e.currency, 'GBP'),
             'has_attendance_evidence', exists (
               select 1 from public.call_attendance_segments s where s.booking_id = i.booking_id),
             'resolved', i.state = 'resolved'
           ) as row,
           (i.priority = 'high') as high,
           i.created_at as created_at
    from public.conversation_issues i
    join public.bookings b on b.id = i.booking_id
    join public.profiles mp on mp.id = b.member_profile_id
    join public.profiles cp on cp.id = b.companion_profile_id
    left join public.companion_earnings e on e.id = i.earning_id
    where (p_states is null or i.state = any (p_states))
      and (p_priority is null or i.priority = p_priority)
      and (p_category is null or i.category = p_category)
      and (p_reporter_role is null or i.reporter_role = p_reporter_role)
    order by (i.priority = 'high') desc, i.created_at desc
    limit 200
  ) x;
  return v_result;
end;
$$;
revoke all on function public.get_internal_issue_queue(text[], text, text, text) from public, anon;
grant execute on function public.get_internal_issue_queue(text[], text, text, text) to authenticated;

-- ------------------------------------------------------------
-- 4. Safe internal issue-detail reader (support/admin only).
--    Returns the case-review data ONLY. Never returns Stripe/bank secrets,
--    webhook secrets, raw Stripe payloads, LiveKit tokens/identities,
--    private Coordinator platform feedback, or another booking's data.
-- ------------------------------------------------------------
create or replace function public.get_internal_issue_detail(p_issue uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_i public.conversation_issues;
  v_b public.bookings;
  v_e public.companion_earnings;
  v_o public.payment_orders;
  v_att public.conversation_attendance;
  v_rev public.conversation_reviews;
  v_res public.issue_resolutions;
  v_credit public.credit_ledger;
  v_mp public.profiles;
  v_cp public.profiles;
  v_comp integer;
  v_mem integer;
begin
  if not app_private.is_support_admin() then
    raise exception 'not_found: issue';
  end if;
  select * into v_i from public.conversation_issues where id = p_issue;
  if v_i.id is null then raise exception 'not_found: issue'; end if;

  select * into v_b from public.bookings where id = v_i.booking_id;
  select * into v_e from public.companion_earnings where id = v_i.earning_id;
  select * into v_o from public.payment_orders where id = v_e.payment_order_id;
  select * into v_att from public.conversation_attendance where booking_id = v_i.booking_id;
  select * into v_rev from public.conversation_reviews where booking_id = v_i.booking_id;
  select * into v_res from public.issue_resolutions where issue_id = v_i.id;
  select * into v_credit from public.credit_ledger
    where idempotency_key = 'resolution-credit-' || v_i.id::text;
  select coalesce(sum(duration_seconds), 0) into v_comp
    from public.call_attendance_segments where booking_id = v_i.booking_id and side = 'companion';
  select coalesce(sum(duration_seconds), 0) into v_mem
    from public.call_attendance_segments where booking_id = v_i.booking_id and side = 'member';
  select * into v_mp from public.profiles where id = v_b.member_profile_id;
  select * into v_cp from public.profiles where id = v_b.companion_profile_id;

  return jsonb_build_object(
    'issue_id', v_i.id,
    'category', v_i.category,
    'priority', v_i.priority,
    'state', v_i.state,
    'reporter_role', v_i.reporter_role,
    'description', v_i.description,               -- support-only complaint text
    'created_at', v_i.created_at,
    'updated_at', v_i.updated_at,
    'resolved_at', v_i.resolved_at,
    'booking_id', v_b.id,
    'conversation_at', v_b.starts_at,
    'duration_minutes', v_b.duration_minutes,
    'member_name', nullif(trim(v_mp.first_name || ' ' || v_mp.last_name), ''),
    'companion_name', nullif(trim(v_cp.first_name || ' ' || v_cp.last_name), ''),
    'currency', coalesce(v_e.currency, 'GBP'),
    'customer_value_minor', v_o.subtotal_minor,
    'service_fee_minor', v_o.service_fee_minor,
    'customer_total_minor', v_o.total_minor,
    'companion_entitlement_minor', v_e.net_minor,
    'commission_rate_pct', v_e.commission_rate_pct,
    'commission_minor', v_e.commission_minor,
    'earning_state', v_e.state,
    'payable_at', v_e.payable_at,
    'transfer_state', v_e.transfer_state,
    'attendance_outcome', v_att.outcome,
    'attendance_source', v_att.source,
    'review_submitted', v_rev.id is not null,
    'review_approved', coalesce(v_rev.approved, false),
    'review_rating', v_rev.rating,
    'attendance_summary', jsonb_build_object(
      'companion_seconds', v_comp,
      'member_seconds', v_mem,
      'both_two_minutes', (v_comp >= 120 and v_mem >= 120),
      'companion_no_show_threshold', (v_comp >= 600 and v_mem < 120)),
    'credit_status', jsonb_build_object(
      'issued', v_credit.id is not null,
      'amount_minor', v_credit.amount_minor,
      'expires_at', v_credit.expires_at),
    'resolution', case when v_res.id is null then null else jsonb_build_object(
      'id', v_res.id,
      'outcome', v_res.outcome,
      'note', v_res.note,                          -- support-only internal note
      'companion_amount_minor', v_res.companion_amount_minor,
      'credit_amount_minor', v_res.credit_amount_minor,
      'resolver_account_id', v_res.resolver_account_id,
      'created_at', v_res.created_at) end);
end;
$$;
revoke all on function public.get_internal_issue_detail(uuid) from public, anon;
grant execute on function public.get_internal_issue_detail(uuid) to authenticated;

-- ------------------------------------------------------------
-- 5. Additive redefine of resolve_conversation_issue — SAME financial logic
--    as 0034, plus role-aware deduplicated notifications and one neutral
--    shared system event. The reporter-only notification is replaced by one
--    Companion + one Coordinator notification (each deterministic, deduped),
--    so both parties are informed without leaking private text or amounts.
-- ------------------------------------------------------------
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

  if p_outcome = 'companion_payable_full' then
    p_companion_minor := v_e.net_minor; p_credit_minor := 0;
  elsif p_outcome = 'customer_credit_full' then
    p_companion_minor := 0; p_credit_minor := v_order.total_minor; -- incl. service fee
  elsif p_outcome = 'issue_dismissed_release' then
    p_companion_minor := v_e.net_minor; p_credit_minor := 0;
  elsif p_outcome = 'partial_resolution' then
    if p_companion_minor is null or p_credit_minor is null
       or p_companion_minor < 0 or p_credit_minor < 0
       or p_companion_minor > v_e.net_minor
       or p_credit_minor > v_order.total_minor
       or (p_companion_minor + p_credit_minor) > v_order.total_minor then
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
