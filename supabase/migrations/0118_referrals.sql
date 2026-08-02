-- 0118 — Referrals: invite codes, redemption, and a self-service pilot grant.
--
-- A pilot participant (member or companion with pilot/full access) can invite
-- others. The invitee redeems the code to move from 'waitlist' straight to
-- 'pilot' — authorised by holding a valid unused code, NOT by support. Reuses
-- the 0103/0104 access spine (ensure_access_row, access_snapshot, audit_access,
-- enqueue_access_event) so every grant is audited and notified exactly like a
-- support grant, and the invitee inherits the referrer's cohort so pilot
-- feature access works immediately.
--
-- Abuse controls: only pilot/full accounts can mint; one active code per
-- referrer; per-code use cap; one redemption per invitee account; no self-
-- referral; blocked accounts can never be granted; row-locked use counting so a
-- code can never be over-redeemed. Additive. Apply after 0117.

set search_path = '';

-- ---------- tables ----------
create table if not exists public.referral_codes (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null unique,
  referrer_account_id uuid not null references public.accounts(id) on delete cascade,
  max_uses            integer not null default 5 check (max_uses between 1 and 100),
  uses                integer not null default 0 check (uses >= 0),
  expires_at          timestamptz,
  revoked             boolean not null default false,
  created_at          timestamptz not null default now()
);
-- One live code per referrer (revoked codes don't count).
create unique index if not exists referral_codes_one_active
  on public.referral_codes (referrer_account_id) where not revoked;
alter table public.referral_codes enable row level security;
drop policy if exists "referral codes: read own" on public.referral_codes;
create policy "referral codes: read own" on public.referral_codes
  for select to authenticated using (referrer_account_id = auth.uid());

create table if not exists public.referral_redemptions (
  id                  uuid primary key default gen_random_uuid(),
  code_id             uuid not null references public.referral_codes(id) on delete cascade,
  referrer_account_id uuid not null references public.accounts(id) on delete cascade,
  invitee_account_id  uuid not null references public.accounts(id) on delete cascade,
  redeemed_at         timestamptz not null default now(),
  unique (invitee_account_id)   -- an account can only be referred once
);
create index if not exists referral_redemptions_referrer_idx
  on public.referral_redemptions (referrer_account_id, redeemed_at desc);
alter table public.referral_redemptions enable row level security;
drop policy if exists "referral redemptions: referrer reads" on public.referral_redemptions;
create policy "referral redemptions: referrer reads" on public.referral_redemptions
  for select to authenticated using (referrer_account_id = auth.uid());

-- ---------- code generator (unambiguous alphabet: no 0/O/1/I/L) ----------
create or replace function app_private.gen_referral_code()
returns text language plpgsql volatile set search_path = '' as $$
declare alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; res text := ''; i int;
begin
  for i in 1..8 loop
    res := res || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return res;
end;
$$;
revoke all on function app_private.gen_referral_code() from public, anon, authenticated;

-- ---------- referrer: fetch or mint my code (+ stats) ----------
create or replace function public.my_referral_code()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_level text;
  v public.referral_codes;
  v_accepted int;
begin
  if v_uid is null then raise exception 'unauthorised: sign in required' using errcode = '42501'; end if;
  select access_level into v_level from public.account_access where account_id = v_uid;
  if coalesce(v_level, 'waitlist') not in ('pilot', 'full') then
    raise exception 'referral_not_eligible: pilot access required to invite'
      using errcode = 'P0001', hint = 'referral_not_eligible';
  end if;

  select * into v from public.referral_codes where referrer_account_id = v_uid and not revoked limit 1;
  if not found then
    loop
      begin
        insert into public.referral_codes (code, referrer_account_id)
        values (app_private.gen_referral_code(), v_uid)
        returning * into v;
        exit;
      exception when unique_violation then
        -- Either a code collision (retry) or the one-active-per-referrer guard
        -- (another session minted first) — take the existing row if present.
        select * into v from public.referral_codes where referrer_account_id = v_uid and not revoked limit 1;
        if found then exit; end if;
      end;
    end loop;
  end if;

  select count(*) into v_accepted from public.referral_redemptions where code_id = v.id;
  return jsonb_build_object(
    'code', v.code,
    'uses', v.uses,
    'max_uses', v.max_uses,
    'remaining', greatest(v.max_uses - v.uses, 0),
    'accepted', v_accepted);
end;
$$;
revoke all on function public.my_referral_code() from public, anon;
grant execute on function public.my_referral_code() to authenticated;

-- ---------- invitee: redeem a code -> self-service pilot grant ----------
create or replace function public.redeem_referral_code(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_norm text;
  v_code public.referral_codes;
  v_level text;
  v_before jsonb;
begin
  if v_uid is null then raise exception 'unauthorised: sign in required' using errcode = '42501'; end if;
  v_norm := upper(btrim(coalesce(p_code, '')));
  if v_norm = '' then raise exception 'referral_invalid' using errcode = 'P0001', hint = 'referral_invalid'; end if;

  -- Row-lock the code so uses can never exceed max_uses under concurrency.
  select * into v_code from public.referral_codes
   where code = v_norm and not revoked and (expires_at is null or expires_at > now())
   for update;
  if not found then raise exception 'referral_invalid' using errcode = 'P0001', hint = 'referral_invalid'; end if;
  if v_code.uses >= v_code.max_uses then
    raise exception 'referral_exhausted' using errcode = 'P0001', hint = 'referral_exhausted'; end if;
  if v_code.referrer_account_id = v_uid then
    raise exception 'referral_self' using errcode = 'P0001', hint = 'referral_self'; end if;
  if exists (select 1 from public.referral_redemptions where invitee_account_id = v_uid) then
    raise exception 'referral_already_used' using errcode = 'P0001', hint = 'referral_already_used'; end if;

  perform app_private.ensure_access_row(v_uid);
  select access_level into v_level from public.account_access where account_id = v_uid;
  if v_level = 'blocked' then
    raise exception 'referral_unavailable' using errcode = 'P0001', hint = 'referral_unavailable'; end if;
  if v_level in ('pilot', 'full') then
    raise exception 'referral_not_needed' using errcode = 'P0001', hint = 'referral_not_needed'; end if;

  v_before := app_private.access_snapshot(v_uid);
  update public.account_access set
     access_level = 'pilot',
     granted_at = now(),
     cohort_id = coalesce(cohort_id,
       (select cohort_id from public.account_access where account_id = v_code.referrer_account_id)),
     updated_at = now()
   where account_id = v_uid;

  insert into public.referral_redemptions (code_id, referrer_account_id, invitee_account_id)
  values (v_code.id, v_code.referrer_account_id, v_uid);
  update public.referral_codes set uses = uses + 1 where id = v_code.id;

  perform app_private.audit_access(v_uid, 'referral_redeemed', v_before,
    app_private.access_snapshot(v_uid), 'Referral code ' || v_norm);
  perform app_private.enqueue_access_event(v_uid, 'pilot_access_granted', v_uid::text);

  -- Thank the referrer in-app (no email category => in-app only).
  insert into public.notifications (user_id, type, title, body, dedupe_key)
  values (v_code.referrer_account_id, 'referral_accepted', 'Your invite was accepted',
          'Someone you invited has joined the pilot. Thank you for helping your community grow.',
          'referral_accepted:' || v_uid::text)
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;

  return jsonb_build_object('ok', true, 'access_level', 'pilot');
end;
$$;
revoke all on function public.redeem_referral_code(text) from public, anon;
grant execute on function public.redeem_referral_code(text) to authenticated;

select pg_notify('pgrst', 'reload schema');
