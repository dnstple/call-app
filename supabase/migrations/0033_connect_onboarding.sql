-- ============================================================
-- 2G3 — Stripe Connect onboarding + payment readiness (migration 0033).
--
-- Express accounts, separate charges & transfers. Stripe's HOSTED
-- onboarding collects every sensitive detail (bank, identity, DOB, tax)
-- — this schema stores ONLY safe status fields, synchronised by
-- account.updated webhooks / server retrieval, never by browsers and
-- never by redirects. One connected account per Companion account.
--
-- Paid-acceptance gate: a webhook-funded (stripe_test) booking cannot be
-- accepted until the Companion's account is transfer-ready. Server
-- enforced by trigger — a disabled frontend button is merely decoration.
-- Simulated/mock bookings (no stripe_test order) are untouched.
-- ============================================================

alter table public.connected_accounts
  add column if not exists companion_profile_id uuid references public.profiles(id),
  add column if not exists account_type text not null default 'express',
  add column if not exists transfers_capability text not null default 'inactive',
  add column if not exists requirements_eventually_due text[] not null default '{}',
  add column if not exists country text not null default 'GB',
  add column if not exists default_currency text not null default 'gbp',
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists connected_accounts_stripe_idx
  on public.connected_accounts (stripe_account_id);

-- ---------- readiness (the ONE definition everything uses) ----------
create or replace function app_private.companion_payments_ready(p_companion_profile uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.connected_accounts ca
    join public.profile_access pa
      on pa.account_id = ca.account_id
     and pa.profile_id = p_companion_profile
     and pa.access_role = 'owner'
     and pa.consent_status <> 'withdrawn'
    where ca.payouts_enabled
      and ca.transfers_capability = 'active'
      and ca.details_submitted
  );
$$;
revoke all on function app_private.companion_payments_ready(uuid) from public, anon;
grant execute on function app_private.companion_payments_ready(uuid) to authenticated;

-- Caller-facing readiness for THEIR profile (safe boolean only — used by
-- the acceptance UI; never exposes another Companion's Stripe state).
create or replace function public.my_payments_ready(p_companion uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app_private.companion_payments_ready(p_companion)
  and exists (
    select 1 from public.profile_access pa
    where pa.profile_id = p_companion and pa.account_id = auth.uid()
  );
$$;
revoke all on function public.my_payments_ready(uuid) from public, anon;
grant execute on function public.my_payments_ready(uuid) to authenticated;

-- ---------- server-enforced paid-acceptance gate ----------
create or replace function app_private.gate_paid_acceptance()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.status = 'confirmed' and old.status in ('requested', 'change_proposed') then
    -- Only REAL Stripe-funded bookings are gated; simulation is exempt.
    if exists (
      select 1 from public.payment_orders po
      where po.booking_id = new.id
        and po.provider = 'stripe_test'
        and po.status = 'succeeded'
    ) and not app_private.companion_payments_ready(new.companion_profile_id) then
      raise exception 'not_ready: set up payments before accepting paid conversations';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app_private.gate_paid_acceptance() from public, anon, authenticated;
drop trigger if exists bookings_paid_acceptance_gate on public.bookings;
create trigger bookings_paid_acceptance_gate
  before update on public.bookings
  for each row execute function app_private.gate_paid_acceptance();

-- Declining / suggesting another time stays available while onboarding is
-- incomplete — the gate touches ONLY requested→confirmed transitions.
