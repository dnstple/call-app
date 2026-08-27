-- ===========================================================================
-- 0160_membership_and_credit_ledger.sql  (Membership restructure — Phase 2)
--
-- Data foundation for the new subscription/credits model. NO Stripe wiring yet
-- (Phase 3) and NO booking consumption wiring yet (Phase 4) — this migration
-- creates the tables and the credit primitives so later phases plug in.
--
--   * memberships     — one subscription state row per member profile.
--   * call_credits    — PER-CREDIT ledger; each credit is a row with its own
--                       3-month expiry. 1 credit = one 45-minute call.
--   * primitives      — issue / balance / consume / refund / expire, plus a
--                       member-facing my_call_credits() read.
--
-- Money model reminder: a credit is worth £8.33 of companion allocation; the
-- companion is paid on call COMPLETION (Phase 5), not when the credit is issued.
-- ===========================================================================

set search_path = '';

-- ---------------------------------------------------------------------------
-- 1. Membership subscription state (one live membership per member profile).
-- ---------------------------------------------------------------------------
create table if not exists public.memberships (
  id                    uuid primary key default gen_random_uuid(),
  member_profile_id     uuid not null references public.profiles(id) on delete cascade,
  payer_account_id      uuid not null references public.accounts(id),   -- member self OR managing coordinator
  stripe_customer_id     text,
  stripe_subscription_id text unique,
  status                text not null default 'pending'
    check (status in ('pending','starter','active','past_due','paused','cancelled','expired')),
  starter_paid_at       timestamptz,
  anchor_at             timestamptz,          -- when monthly billing begins (starter + 7 days)
  current_period_start  timestamptz,
  current_period_end    timestamptz,
  paid_through_at       timestamptz,
  cancel_at_period_end  boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
-- At most one active-ish membership per member.
create unique index if not exists memberships_one_live_per_member
  on public.memberships (member_profile_id)
  where status in ('pending','starter','active','past_due','paused');

alter table public.memberships enable row level security;
drop policy if exists "memberships: read own" on public.memberships;
create policy "memberships: read own" on public.memberships
  for select to authenticated using (
    payer_account_id = auth.uid()
    or exists (select 1 from public.profile_access pa
                where pa.profile_id = memberships.member_profile_id and pa.account_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 2. Per-credit ledger (each row = one 45-minute call credit).
-- ---------------------------------------------------------------------------
create table if not exists public.call_credits (
  id                  uuid primary key default gen_random_uuid(),
  member_profile_id   uuid not null references public.profiles(id) on delete cascade,
  account_id          uuid not null references public.accounts(id) on delete cascade,  -- holder (member owner or payer)
  membership_id       uuid references public.memberships(id) on delete set null,
  source              text not null check (source in ('starter','weekly','extra','admin')),
  issued_at           timestamptz not null default now(),
  expires_at          timestamptz not null,     -- issued_at + 3 months
  status              text not null default 'active'
    check (status in ('active','consumed','expired','refunded')),
  consumed_at         timestamptz,
  consumed_booking_id uuid references public.bookings(id) on delete set null,
  created_at          timestamptz not null default now()
);
create index if not exists call_credits_member_active
  on public.call_credits (member_profile_id, status, expires_at);
create index if not exists call_credits_booking
  on public.call_credits (consumed_booking_id) where consumed_booking_id is not null;

alter table public.call_credits enable row level security;
drop policy if exists "call_credits: read own" on public.call_credits;
create policy "call_credits: read own" on public.call_credits
  for select to authenticated using (
    exists (select 1 from public.profile_access pa
             where pa.profile_id = call_credits.member_profile_id and pa.account_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 3. Credit primitives.
-- ---------------------------------------------------------------------------

-- Issue N credits to a member (starter / weekly / extra / admin). Service role
-- (Stripe webhook + accrual job in Phase 3) or admin grant.
create or replace function public.issue_call_credit(
  p_member_profile uuid, p_membership uuid, p_source text, p_count integer default 1)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_account uuid; v_n integer := greatest(coalesce(p_count, 1), 1); i integer;
begin
  if p_source not in ('starter','weekly','extra','admin') then
    raise exception 'invalid_source';
  end if;
  -- Holder = the member's owner account, else the membership payer (coordinator).
  select pa.account_id into v_account from public.profile_access pa
   where pa.profile_id = p_member_profile and pa.access_role = 'owner' limit 1;
  if v_account is null and p_membership is not null then
    select payer_account_id into v_account from public.memberships where id = p_membership;
  end if;
  if v_account is null then
    raise exception 'no_holder_account: cannot resolve who holds these credits';
  end if;
  for i in 1..v_n loop
    insert into public.call_credits
      (member_profile_id, account_id, membership_id, source, issued_at, expires_at)
    values
      (p_member_profile, v_account, p_membership, p_source, now(), now() + interval '3 months');
  end loop;
  return v_n;
end;
$$;
revoke all on function public.issue_call_credit(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.issue_call_credit(uuid, uuid, text, integer) to service_role;

-- Active, non-expired balance (+ next expiry) for a member the caller can act for.
create or replace function public.my_call_credits(p_member_profile uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_balance integer; v_next timestamptz; v_soon integer;
begin
  if auth.uid() is null then raise exception 'unauthorised'; end if;
  if not exists (select 1 from public.profile_access pa
                  where pa.profile_id = p_member_profile and pa.account_id = auth.uid()) then
    raise exception 'not_found';
  end if;
  select count(*), min(expires_at),
         count(*) filter (where expires_at <= now() + interval '14 days')
    into v_balance, v_next, v_soon
    from public.call_credits
   where member_profile_id = p_member_profile and status = 'active' and expires_at > now();
  return jsonb_build_object(
    'balance', coalesce(v_balance, 0),
    'next_expiry', v_next,
    'expiring_soon', coalesce(v_soon, 0));
end;
$$;
revoke all on function public.my_call_credits(uuid) from public, anon;
grant execute on function public.my_call_credits(uuid) to authenticated;

-- Consume the SOONEST-expiring active credit (FIFO by expiry) for a booking.
-- Callable only by someone who can act for the member. Wired into booking in Phase 4.
create or replace function public.consume_call_credit(p_member_profile uuid, p_booking uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not exists (select 1 from public.profile_access pa
                  where pa.profile_id = p_member_profile and pa.account_id = auth.uid()) then
    raise exception 'not_authorised_for_member' using errcode = '42501';
  end if;
  select id into v_id from public.call_credits
   where member_profile_id = p_member_profile and status = 'active' and expires_at > now()
   order by expires_at asc
   limit 1 for update skip locked;
  if v_id is null then raise exception 'no_credits' using errcode = 'P0001'; end if;
  update public.call_credits
     set status = 'consumed', consumed_at = now(), consumed_booking_id = p_booking
   where id = v_id;
  return v_id;
end;
$$;
revoke all on function public.consume_call_credit(uuid, uuid) from public, anon;
grant execute on function public.consume_call_credit(uuid, uuid) to authenticated;

-- Refund the credit tied to a booking (cancellation / admin takeover with no call
-- delivered). Service role. Returns credits refunded.
create or replace function public.refund_call_credit(p_booking uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.call_credits
     set status = 'active', consumed_at = null, consumed_booking_id = null
   where consumed_booking_id = p_booking and status = 'consumed'
     and expires_at > now();   -- only refund if still within its life
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.refund_call_credit(uuid) from public, anon, authenticated;
grant execute on function public.refund_call_credit(uuid) to service_role;

-- Expire past-life active credits (daily job).
create or replace function public.expire_call_credits()
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.call_credits set status = 'expired'
   where status = 'active' and expires_at <= now();
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.expire_call_credits() from public, anon, authenticated;
grant execute on function public.expire_call_credits() to service_role;

-- Schedule the daily expiry sweep (pure SQL — no edge function needed).
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable — schedule select public.expire_call_credits() daily yourself.';
    return;
  end if;
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'expire-call-credits';
  perform cron.schedule('expire-call-credits', '15 3 * * *',
    $cron$select public.expire_call_credits();$cron$);
  raise notice 'Scheduled expire-call-credits daily at 03:15 UTC.';
exception when others then
  raise notice 'expire-call-credits scheduling skipped (%).', sqlerrm;
end $$;

select pg_notify('pgrst', 'reload schema');
