-- ===========================================================================
-- 0219_automation_foundation.sql
--
-- Foundations for the automation builds (docs/automation/DESIGN.md):
--   * automation_controls — single-row kill switches. Everything defaults OFF
--     (dry-run). The outreach sender is pinned by a CHECK constraint to the one
--     permitted mailbox, info@apricoti.co.uk, so it cannot be changed by config.
--   * contact_triage       — Build 1: one triage decision per contact message.
--   * gdpr_erasure_log     — Build 1: append-only audit of every erasure
--                            (dry-run and live). Updates/deletes are blocked.
--   * automation_contact_context(message) — everything the triage agent needs
--     about a message: the message, the resolved account, and the safety
--     signals (disputes, payments, credits, bookings, earnings, managed members).
--
-- Service-role only: RLS on, no grants to anon/authenticated.
-- Run by hand in the Supabase SQL editor, then run the fingerprint at the end.
-- ===========================================================================

set search_path = '';

-- ---------------------------------------------------------------------------
-- 1. Kill switches
-- ---------------------------------------------------------------------------
create table if not exists public.automation_controls (
  id                      boolean primary key default true check (id),
  erasure_live            boolean not null default false,
  outreach_live           boolean not null default false,
  outreach_daily_cap      integer not null default 25 check (outreach_daily_cap between 0 and 30),
  -- The ONLY permitted sender. Pinned by constraint; do not relax.
  outreach_sender         text not null default 'info@apricoti.co.uk'
                            check (outreach_sender = 'info@apricoti.co.uk'),
  -- PECR sender identity. Outreach refuses to go live while this is null.
  outreach_postal_address text,
  updated_at              timestamptz not null default now(),
  updated_by              text
);
insert into public.automation_controls (id) values (true) on conflict (id) do nothing;
alter table public.automation_controls enable row level security;
revoke all on public.automation_controls from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Contact triage
-- ---------------------------------------------------------------------------
create table if not exists public.contact_triage (
  message_id         uuid primary key references public.contact_messages(id) on delete cascade,
  account_id         uuid,             -- resolved account (from_account_id, else email match)
  account_match      text not null default 'none'
                       check (account_match in ('from_account_id', 'email', 'none')),
  category           text not null check (category in (
                       'delete_account', 'refund_billing', 'technical', 'companion_query',
                       'general', 'spam', 'needs_human')),
  model_category     text,             -- what the model said before deterministic overrides
  confidence         numeric(3,2),
  reasoning          text,
  signals            jsonb not null default '{}'::jsonb,
  override_reasons   text[] not null default '{}',
  recommended_action text,
  draft_reply        text,             -- NEVER sent automatically
  status             text not null default 'proposed'
                       check (status in ('proposed', 'approved', 'executed', 'rejected', 'skipped', 'failed')),
  batch_id           uuid,
  resolution         text,
  model              text,
  triaged_at         timestamptz not null default now(),
  approved_by        text,
  approved_at        timestamptz,
  executed_at        timestamptz,
  last_error         text
);
create index if not exists contact_triage_status_idx on public.contact_triage (status, category);
create index if not exists contact_triage_batch_idx on public.contact_triage (batch_id);
alter table public.contact_triage enable row level security;
revoke all on public.contact_triage from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Erasure audit log (append-only)
-- ---------------------------------------------------------------------------
create table if not exists public.gdpr_erasure_log (
  id                      uuid primary key default gen_random_uuid(),
  account_id              uuid not null,
  source_message_id       uuid,
  approved_by             text,
  dry_run                 boolean not null,
  outcome                 text not null,  -- erased | would_erase | already_erased | refused | error
  refusal_reasons         text[] not null default '{}',
  rows_affected           jsonb not null default '{}'::jsonb,
  avatar_paths            text[] not null default '{}',   -- for Storage API removal
  storage_objects_removed text[] not null default '{}',
  error                   text,
  created_at              timestamptz not null default now()
);
create index if not exists gdpr_erasure_log_account_idx on public.gdpr_erasure_log (account_id, created_at desc);
alter table public.gdpr_erasure_log enable row level security;
revoke all on public.gdpr_erasure_log from anon, authenticated;

-- Append-only, except recording storage removal once on a live row.
create or replace function app_private.gdpr_erasure_log_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'gdpr_erasure_log is append-only';
  end if;
  if new.id is distinct from old.id
     or new.account_id is distinct from old.account_id
     or new.source_message_id is distinct from old.source_message_id
     or new.approved_by is distinct from old.approved_by
     or new.dry_run is distinct from old.dry_run
     or new.outcome is distinct from old.outcome
     or new.rows_affected is distinct from old.rows_affected
     or new.avatar_paths is distinct from old.avatar_paths
     or new.created_at is distinct from old.created_at then
    raise exception 'gdpr_erasure_log is append-only (only storage_objects_removed/error may be set)';
  end if;
  return new;
end;
$$;
drop trigger if exists gdpr_erasure_log_guard on public.gdpr_erasure_log;
create trigger gdpr_erasure_log_guard before update or delete on public.gdpr_erasure_log
  for each row execute function app_private.gdpr_erasure_log_guard();

-- ---------------------------------------------------------------------------
-- 4. Safety signals for one account
-- ---------------------------------------------------------------------------
create or replace function public.automation_account_signals(p_account uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_owned   uuid[];
  v_managed uuid[];
  v_email   text;
  r         jsonb;
begin
  if p_account is null then return '{}'::jsonb; end if;

  select coalesce(array_agg(profile_id), '{}') into v_owned
    from public.profile_access where account_id = p_account and access_role = 'owner';
  select coalesce(array_agg(profile_id), '{}') into v_managed
    from public.profile_access where account_id = p_account and access_role = 'coordinator'
     and not (profile_id = any (v_owned));
  select email into v_email from auth.users where id = p_account;

  r := jsonb_build_object(
    'account_exists',      exists (select 1 from public.accounts where id = p_account),
    'auth_email',          v_email,
    'already_erased',      coalesce(v_email like 'erased+%', false),
    'account_created_at',  (select created_at from public.accounts where id = p_account),
    'last_sign_in_at',     (select last_sign_in_at from auth.users where id = p_account),
    'roles',               (select coalesce(jsonb_agg(distinct role::text), '[]'::jsonb)
                              from public.profiles where id = any (v_owned)),
    'owned_profiles',      to_jsonb(v_owned),
    'managed_profiles',    to_jsonb(v_managed),
    'open_disputes',       (select count(*) from public.payment_disputes d
                              join public.payment_orders o on o.id = d.payment_order_id
                             where d.closed_at is null
                               and (o.coordinator_account_id = p_account or o.member_profile_id = any (v_owned))),
    'payments_30d',        (select count(*) from public.payment_orders o
                             where o.created_at > now() - interval '30 days'
                               and (o.coordinator_account_id = p_account or o.member_profile_id = any (v_owned)))
                           + (select count(*) from public.memberships m
                               where (m.payer_account_id = p_account or m.member_profile_id = any (v_owned))
                                 and greatest(m.starter_paid_at, m.current_period_start) > now() - interval '30 days'),
    'pending_refunds',     (select count(*) from public.payment_refunds
                             where payer_account_id = p_account and completed_at is null),
    'active_membership',   (select count(*) from public.memberships m
                             where (m.payer_account_id = p_account or m.member_profile_id = any (v_owned))
                               and m.status in ('pending', 'starter', 'active', 'past_due', 'paused')),
    'unused_credits',      (select count(*) from public.call_credits c
                             where (c.account_id = p_account or c.member_profile_id = any (v_owned))
                               and c.status = 'active' and c.expires_at > now()),
    'upcoming_bookings',   (select count(*) from public.bookings b
                             where b.starts_at > now()
                               and b.status not in ('cancelled', 'declined', 'completed')
                               and (b.member_profile_id = any (v_owned) or b.companion_profile_id = any (v_owned)
                                    or b.booked_by_account_id = p_account)),
    'unpaid_earnings',     (select count(*) from public.companion_earnings
                             where companion_account_id = p_account
                               and transfer_state in ('not_ready', 'transfer_pending'))
  );
  return r;
end;
$$;
revoke all on function public.automation_account_signals(uuid) from public, anon, authenticated;
grant execute on function public.automation_account_signals(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Context for one contact message (resolves the account by id, then email)
-- ---------------------------------------------------------------------------
create or replace function public.automation_contact_context(p_message uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  m       public.contact_messages%rowtype;
  v_acct  uuid;
  v_match text := 'none';
  v_n     integer;
begin
  select * into m from public.contact_messages where id = p_message;
  if not found then return null; end if;

  if m.from_account_id is not null then
    v_acct := m.from_account_id; v_match := 'from_account_id';
  elsif nullif(trim(m.email), '') is not null then
    select count(*) into v_n from auth.users where lower(email) = lower(trim(m.email));
    if v_n = 1 then
      select id into v_acct from auth.users where lower(email) = lower(trim(m.email));
      v_match := 'email';
    end if;
  end if;

  return jsonb_build_object(
    'message', jsonb_build_object(
      'id', m.id, 'name', m.name, 'email', m.email, 'message', m.message,
      'created_at', m.created_at, 'from_account_id', m.from_account_id),
    'account_id', v_acct,
    'account_match', v_match,
    'email_matches_account', case when v_acct is null then null
      else lower(trim(coalesce(m.email, ''))) = lower(coalesce((select email from auth.users where id = v_acct), '')) end,
    'other_messages_from_sender', (select count(*) from public.contact_messages x
      where x.id <> m.id and (x.from_account_id = v_acct
        or (nullif(trim(m.email), '') is not null and lower(x.email) = lower(trim(m.email))))),
    'signals', public.automation_account_signals(v_acct)
  );
end;
$$;
revoke all on function public.automation_contact_context(uuid) from public, anon, authenticated;
grant execute on function public.automation_contact_context(uuid) to service_role;

select pg_notify('pgrst', 'reload schema');

-- ---------------------------------------------------------------------------
-- FINGERPRINT — all columns should be true:
-- select
--   (to_regclass('public.automation_controls') is not null)                           as controls,
--   (select outreach_live = false and erasure_live = false from public.automation_controls) as all_off,
--   (to_regclass('public.contact_triage') is not null)                                as triage,
--   (to_regclass('public.gdpr_erasure_log') is not null)                              as erasure_log,
--   (to_regprocedure('public.automation_contact_context(uuid)') is not null)          as context_fn;
-- ---------------------------------------------------------------------------
