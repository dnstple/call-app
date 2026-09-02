-- ===========================================================================
-- 0202_subscription_cancellation_flow.sql
--
-- Member-facing subscription cancellation flow (retention + Stripe portal).
--   * my_membership()               — the caller's own membership + credit balance,
--                                      so the UI can show status and gate the button.
--   * grant_retention_credit()      — a ONE-TIME free call credit offered during the
--                                      cancellation flow, only if the member has none
--                                      left. Recorded so it can't be claimed twice.
--   * submit_cancellation_feedback  — captures the required reason + notes (>=50 chars)
--                                      before the member is sent to Stripe to cancel.
-- The actual cancellation happens on Stripe's hosted billing portal; the existing
-- stripe-membership-webhook ingests the result.
-- ===========================================================================

set search_path = '';

-- One retention credit per member, ever.
create table if not exists public.retention_credit_grants (
  member_profile_id uuid primary key references public.profiles(id) on delete cascade,
  account_id        uuid not null references public.accounts(id) on delete cascade,
  granted_at        timestamptz not null default now()
);
alter table public.retention_credit_grants enable row level security;  -- definer-only

-- Cancellation reason + notes.
create table if not exists public.cancellation_feedback (
  id                uuid primary key default gen_random_uuid(),
  member_profile_id uuid references public.profiles(id) on delete set null,
  account_id        uuid references public.accounts(id) on delete set null,
  membership_id     uuid references public.memberships(id) on delete set null,
  reason            text not null,
  notes             text not null,
  created_at        timestamptz not null default now()
);
alter table public.cancellation_feedback enable row level security;   -- definer-only

-- Resolve the caller's own (owner) member profile.
create or replace function app_private.my_member_profile()
returns uuid language sql stable security definer set search_path = '' as $$
  select pa.profile_id
    from public.profile_access pa
    join public.profiles p on p.id = pa.profile_id
   where pa.account_id = auth.uid() and pa.access_role = 'owner' and p.role = 'member'
   order by pa.created_at
   limit 1;
$$;
revoke all on function app_private.my_member_profile() from public, anon;
grant execute on function app_private.my_member_profile() to authenticated;

-- The caller's membership + live credit balance.
create or replace function public.my_membership()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_profile uuid; v_m public.memberships; v_balance integer;
begin
  if auth.uid() is null then raise exception 'unauthorised'; end if;
  v_profile := app_private.my_member_profile();
  if v_profile is null then return jsonb_build_object('has_membership', false); end if;

  select * into v_m from public.memberships
   where member_profile_id = v_profile
     and status in ('pending','starter','active','past_due','paused')
   order by created_at desc limit 1;

  select count(*) into v_balance
    from public.call_credits
   where member_profile_id = v_profile and status = 'active' and expires_at > now();

  if v_m.id is null then
    return jsonb_build_object('has_membership', false, 'member_profile_id', v_profile, 'credit_balance', coalesce(v_balance, 0));
  end if;
  return jsonb_build_object(
    'has_membership', true,
    'membership_id', v_m.id,
    'member_profile_id', v_profile,
    'status', v_m.status,
    'cancel_at_period_end', v_m.cancel_at_period_end,
    'current_period_end', v_m.current_period_end,
    'has_stripe_customer', (v_m.stripe_customer_id is not null),
    'credit_balance', coalesce(v_balance, 0));
end;
$$;
revoke all on function public.my_membership() from public, anon;
grant execute on function public.my_membership() to authenticated;

-- Offer a single free credit when the member has none left. Returns the outcome.
create or replace function public.grant_retention_credit()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_profile uuid; v_m public.memberships; v_balance integer;
begin
  if auth.uid() is null then raise exception 'unauthorised'; end if;
  v_profile := app_private.my_member_profile();
  if v_profile is null then raise exception 'not_found'; end if;

  select * into v_m from public.memberships
   where member_profile_id = v_profile
     and status in ('pending','starter','active','past_due','paused')
   order by created_at desc limit 1;

  select count(*) into v_balance from public.call_credits
   where member_profile_id = v_profile and status = 'active' and expires_at > now();

  if coalesce(v_balance, 0) > 0 then
    return jsonb_build_object('granted', false, 'reason', 'has_credits', 'balance', v_balance);
  end if;
  if exists (select 1 from public.retention_credit_grants where member_profile_id = v_profile) then
    return jsonb_build_object('granted', false, 'reason', 'already_granted');
  end if;

  insert into public.retention_credit_grants (member_profile_id, account_id)
  values (v_profile, auth.uid());
  perform public.issue_call_credit(v_profile, v_m.id, 'admin', 1);

  return jsonb_build_object('granted', true);
end;
$$;
revoke all on function public.grant_retention_credit() from public, anon;
grant execute on function public.grant_retention_credit() to authenticated;

-- Capture the cancellation reason + notes (notes must be at least 50 characters).
create or replace function public.submit_cancellation_feedback(p_reason text, p_notes text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_profile uuid; v_m public.memberships;
begin
  if auth.uid() is null then raise exception 'unauthorised'; end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required' using errcode = 'P0001';
  end if;
  if p_notes is null or length(btrim(p_notes)) < 50 then
    raise exception 'notes_too_short: please tell us a little more (at least 50 characters)' using errcode = 'P0001';
  end if;
  v_profile := app_private.my_member_profile();
  select * into v_m from public.memberships
   where member_profile_id = v_profile
   order by created_at desc limit 1;

  insert into public.cancellation_feedback (member_profile_id, account_id, membership_id, reason, notes)
  values (v_profile, auth.uid(), v_m.id, btrim(p_reason), btrim(p_notes));

  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.submit_cancellation_feedback(text, text) from public, anon;
grant execute on function public.submit_cancellation_feedback(text, text) to authenticated;

select pg_notify('pgrst', 'reload schema');
