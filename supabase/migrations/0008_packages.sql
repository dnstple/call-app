-- ============================================================
-- Stage 2E3A — package persistence and secure credit accounting.
--
-- A package = a fixed number of conversations with ONE Companion
-- (e.g. 4 × 30 minutes). NO payment is taken: every purchase is
-- explicitly SIMULATED (is_simulated = true, enforced by a check until
-- the payments milestone). Credits live in an append-only ledger and
-- balances are always CALCULATED from it — browser state is never
-- trusted. No booking integration yet (reserve/consume arrive in 2E3B).
--
-- The Stage-1 package tables (no policies, no data in Supabase mode)
-- are rebuilt to the server-derived model.
-- ============================================================

-- ---------- drop the unused Stage-1 package objects ----------
alter table public.transactions drop constraint if exists transactions_package_purchase_id_fkey;
drop table if exists public.package_purchases cascade;
drop table if exists public.package_offers cascade;

-- ---------- package offers ----------
create table public.package_offers (
  id uuid primary key default gen_random_uuid(),
  companion_profile_id uuid not null references public.profiles(id),
  title text not null default '',
  conversation_count integer not null check (conversation_count between 2 and 20),
  duration_minutes integer not null check (duration_minutes in (15, 30, 45, 60)),
  -- Total package price in integer minor units (£1 – £2,000).
  price_minor integer not null check (price_minor between 100 and 200000),
  currency text not null default 'GBP' check (currency = 'GBP'),
  supported_methods text[] not null default '{phone}',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index package_offers_companion_idx on public.package_offers (companion_profile_id, active);

-- ---------- package purchases (SIMULATED — no payment) ----------
create table public.package_purchases (
  id uuid primary key default gen_random_uuid(),
  buyer_account_id uuid not null references public.accounts(id),
  member_profile_id uuid not null references public.profiles(id),
  companion_profile_id uuid not null references public.profiles(id),
  package_offer_id uuid not null references public.package_offers(id),
  -- Server-side snapshots (offers can change later):
  title text not null,
  conversation_count integer not null check (conversation_count between 2 and 20),
  duration_minutes integer not null check (duration_minutes in (15, 30, 45, 60)),
  price_minor integer not null check (price_minor >= 0),
  currency text not null default 'GBP' check (currency = 'GBP'),
  -- HONEST BOUNDARY: no payment exists. The check is relaxed only when
  -- the payments milestone genuinely introduces paid purchases.
  is_simulated boolean not null default true check (is_simulated = true),
  status text not null default 'active' check (status in ('active', 'exhausted', 'cancelled')),
  purchased_at timestamptz not null default now(),
  expires_at timestamptz, -- no automatic expiry in this stage
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index package_purchases_member_idx on public.package_purchases (member_profile_id);
create index package_purchases_buyer_idx on public.package_purchases (buyer_account_id);

-- Re-point the Stage-1 transactions column at the new table.
alter table public.transactions
  add constraint transactions_package_purchase_id_fkey
  foreign key (package_purchase_id) references public.package_purchases(id) on delete set null;

-- ---------- append-only credit ledger ----------
-- Balance = grants + releases + adjustments − reserves − consumes.
-- Only 'grant' is written in this stage; the other types exist so 2E3B
-- can reserve/consume without a schema change.
create table public.package_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  package_purchase_id uuid not null references public.package_purchases(id) on delete cascade,
  booking_id uuid references public.bookings(id),
  entry_type text not null check (entry_type in ('grant', 'reserve', 'release', 'consume', 'adjustment')),
  quantity integer not null check (quantity > 0),
  created_by_account_id uuid references public.accounts(id),
  reason text,
  created_at timestamptz not null default now()
);
create index package_ledger_purchase_idx on public.package_credit_ledger (package_purchase_id);

-- ---------- authorisation helper ----------
create or replace function app_private.can_read_purchase(p_purchase uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.package_purchases pp
    where pp.id = p_purchase
      and (
        pp.buyer_account_id = auth.uid()
        or app_private.has_profile_access(pp.member_profile_id)
      )
  );
$$;
revoke all on function app_private.can_read_purchase(uuid) from public, anon;
grant execute on function app_private.can_read_purchase(uuid) to authenticated;

-- ---------- RLS ----------
alter table public.package_offers enable row level security;
alter table public.package_purchases enable row level security;
alter table public.package_credit_ledger enable row level security;

-- Offers: readable for discoverable companions and their own editors;
-- ALL writes go through the functions below.
create policy "package offers: public read for discoverable"
  on public.package_offers
  for select to authenticated
  using (
    app_private.is_discoverable_companion(companion_profile_id)
    or app_private.has_profile_access(companion_profile_id)
  );

-- Purchases: the buyer and accounts managing the Member. (The Companion
-- does not see purchase records in this stage — documented.)
create policy "package purchases: buyer and member side read"
  on public.package_purchases
  for select to authenticated
  using (
    buyer_account_id = auth.uid()
    or app_private.has_profile_access(member_profile_id)
  );

-- Ledger: readable when the purchase is readable; NEVER writable directly.
create policy "package ledger: purchase readers"
  on public.package_credit_ledger
  for select to authenticated
  using (app_private.can_read_purchase(package_purchase_id));

-- ============================================================
-- Offer management (companion editors only)
-- ============================================================
create or replace function app_private.assert_package_offer_input(
  p_count integer, p_duration integer, p_price integer
)
returns void
language plpgsql immutable
set search_path = ''
as $$
begin
  if p_count is null or p_count < 2 or p_count > 20 then
    raise exception 'invalid_count: a package holds between 2 and 20 conversations';
  end if;
  if p_duration is null or p_duration not in (15, 30, 45, 60) then
    raise exception 'invalid_offer: durations are 15, 30, 45 or 60 minutes';
  end if;
  if p_price is null or p_price < 100 or p_price > 200000 then
    raise exception 'invalid_price: the package price must be between £1 and £2,000';
  end if;
end;
$$;
revoke all on function app_private.assert_package_offer_input(integer, integer, integer) from public, anon, authenticated;

create or replace function public.create_package_offer(
  p_profile uuid,
  p_title text,
  p_count integer,
  p_duration integer,
  p_price_minor integer,
  p_methods text[] default '{phone}'
)
returns public.package_offers
language plpgsql security definer
set search_path = ''
as $$
declare v public.package_offers;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not app_private.can_edit_profile(p_profile) then
    raise exception 'You cannot manage offers for this profile';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_profile and p.role = 'companion') then
    raise exception 'invalid_offer: packages belong to companion profiles';
  end if;
  perform app_private.assert_package_offer_input(p_count, p_duration, p_price_minor);

  insert into public.package_offers (
    companion_profile_id, title, conversation_count, duration_minutes, price_minor, supported_methods
  ) values (
    p_profile,
    coalesce(nullif(trim(p_title), ''), p_count || ' × ' || p_duration || '-minute conversations'),
    p_count, p_duration, p_price_minor, coalesce(p_methods, '{phone}')
  )
  returning * into v;
  return v;
end;
$$;

create or replace function public.update_package_offer(
  p_offer uuid,
  p_title text default null,
  p_count integer default null,
  p_duration integer default null,
  p_price_minor integer default null,
  p_methods text[] default null,
  p_active boolean default null
)
returns public.package_offers
language plpgsql security definer
set search_path = ''
as $$
declare v public.package_offers;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select * into v from public.package_offers where id = p_offer for update;
  if v.id is null or not app_private.can_edit_profile(v.companion_profile_id) then
    raise exception 'Offer not found';
  end if;
  perform app_private.assert_package_offer_input(
    coalesce(p_count, v.conversation_count),
    coalesce(p_duration, v.duration_minutes),
    coalesce(p_price_minor, v.price_minor)
  );
  update public.package_offers set
    title = coalesce(nullif(trim(p_title), ''), title),
    conversation_count = coalesce(p_count, conversation_count),
    duration_minutes = coalesce(p_duration, duration_minutes),
    price_minor = coalesce(p_price_minor, price_minor),
    supported_methods = coalesce(p_methods, supported_methods),
    active = coalesce(p_active, active),
    updated_at = now()
  where id = p_offer
  returning * into v;
  return v;
end;
$$;

-- Offers are archived, never destroyed (purchases snapshot them anyway).
create or replace function public.archive_package_offer(p_offer uuid)
returns public.package_offers
language plpgsql security definer
set search_path = ''
as $$
begin
  return public.update_package_offer(p_offer, p_active => false);
end;
$$;

-- ============================================================
-- Simulated purchase + atomic initial credit grant
-- ============================================================
create or replace function public.get_package_balance(p_purchase uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_granted integer;
  v_reserved integer;
  v_consumed integer;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not app_private.can_read_purchase(p_purchase) then
    raise exception 'Purchase not found';
  end if;
  select
    coalesce(sum(quantity) filter (where entry_type in ('grant', 'release', 'adjustment')), 0),
    coalesce(sum(quantity) filter (where entry_type = 'reserve'), 0),
    coalesce(sum(quantity) filter (where entry_type = 'consume'), 0)
  into v_granted, v_reserved, v_consumed
  from public.package_credit_ledger
  where package_purchase_id = p_purchase;

  return jsonb_build_object(
    'purchase_id', p_purchase,
    'granted', v_granted,
    'reserved', v_reserved,
    'consumed', v_consumed,
    'remaining', v_granted - v_reserved - v_consumed
  );
end;
$$;

create or replace function public.create_simulated_package_purchase(
  p_member uuid,
  p_offer uuid
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_offer public.package_offers;
  v_purchase public.package_purchases;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if not app_private.can_act_for_member(p_member) then
    raise exception 'member_not_accessible: you cannot purchase for this member';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_member and p.role = 'member') then
    raise exception 'member_not_accessible: purchases are for member profiles';
  end if;

  select * into v_offer from public.package_offers where id = p_offer for update;
  if v_offer.id is null
     or not (app_private.is_discoverable_companion(v_offer.companion_profile_id)
             or app_private.has_profile_access(v_offer.companion_profile_id)) then
    raise exception 'invalid_offer: package not found';
  end if;
  if not v_offer.active then
    raise exception 'offer_inactive: this package is no longer available';
  end if;

  -- Snapshot everything server-side; the browser never supplies prices,
  -- counts or the buyer. The purchase is SIMULATED — no payment exists.
  insert into public.package_purchases (
    buyer_account_id, member_profile_id, companion_profile_id, package_offer_id,
    title, conversation_count, duration_minutes, price_minor, currency, is_simulated
  ) values (
    auth.uid(), p_member, v_offer.companion_profile_id, v_offer.id,
    v_offer.title, v_offer.conversation_count, v_offer.duration_minutes,
    v_offer.price_minor, v_offer.currency, true
  )
  returning * into v_purchase;

  -- Initial grant in the SAME transaction: balance always comes from here.
  insert into public.package_credit_ledger (
    package_purchase_id, entry_type, quantity, created_by_account_id, reason
  ) values (
    v_purchase.id, 'grant', v_offer.conversation_count, auth.uid(),
    'Initial grant — simulated purchase, no payment taken'
  );

  return jsonb_build_object(
    'purchase', to_jsonb(v_purchase),
    'balance', public.get_package_balance(v_purchase.id)
  );
end;
$$;

-- ---------- lock the functions down ----------
revoke all on function public.create_package_offer(uuid, text, integer, integer, integer, text[]) from public, anon;
revoke all on function public.update_package_offer(uuid, text, integer, integer, integer, text[], boolean) from public, anon;
revoke all on function public.archive_package_offer(uuid) from public, anon;
revoke all on function public.create_simulated_package_purchase(uuid, uuid) from public, anon;
revoke all on function public.get_package_balance(uuid) from public, anon;
grant execute on function public.create_package_offer(uuid, text, integer, integer, integer, text[]) to authenticated;
grant execute on function public.update_package_offer(uuid, text, integer, integer, integer, text[], boolean) to authenticated;
grant execute on function public.archive_package_offer(uuid) to authenticated;
grant execute on function public.create_simulated_package_purchase(uuid, uuid) to authenticated;
grant execute on function public.get_package_balance(uuid) to authenticated;
