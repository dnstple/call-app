-- ===========================================================================
-- 0226_companion_referral_links.sql
--
-- Make companion invite links actually work (28 Nov 2026).
--
-- Why: 198 referral codes existed but 0 were ever redeemed. redeem_referral_code
-- (0118) only works for WAITLIST accounts (it lifts them to pilot), but since 0217
-- every new member/coordinator gets full access straight away, so redemption always
-- failed with referral_not_needed. The link format (/join?ref=) also never reached
-- the HashRouter app. This migration adds a plain ATTRIBUTION path that works for
-- any new account, plus read-only helpers for the invite page and support.
--
-- No money moves here. The cash bounty stays retired (0158): companions benefit
-- from the paid calls they have with people they invite. Support can see which
-- invited households become paying (support_referral_overview) and decide on any
-- bonus manually.
--
-- Additive and idempotent. Apply by hand; fingerprint at the bottom.
-- ===========================================================================
set search_path = '';

-- 1. Companion codes can be shared widely: raise the cap from 5 to 100 uses.
update public.referral_codes rc
   set max_uses = 100
  from public.profile_access pa
  join public.profiles p on p.id = pa.profile_id
 where pa.account_id = rc.referrer_account_id and pa.access_role = 'owner'
   and p.role = 'companion' and rc.max_uses < 100;

-- Mint new companion codes with 100 uses (members/coordinators keep 5).
create or replace function app_private.referrer_is_companion(p_account uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profile_access pa
    join public.profiles p on p.id = pa.profile_id
    where pa.account_id = p_account and pa.access_role = 'owner' and p.role = 'companion');
$$;
revoke all on function app_private.referrer_is_companion(uuid) from public, anon, authenticated;

create or replace function app_private.trg_referral_code_companion_cap()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if app_private.referrer_is_companion(new.referrer_account_id) and new.max_uses < 100 then
    new.max_uses := 100;
  end if;
  return new;
end;
$$;
drop trigger if exists referral_code_companion_cap on public.referral_codes;
create trigger referral_code_companion_cap
  before insert on public.referral_codes
  for each row execute function app_private.trg_referral_code_companion_cap();

-- 2. Public preview of a code: who invited you (first name only) and, for an
--    active companion, their public profile id so the invitee can book them.
create or replace function public.referral_preview(p_code text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_norm text := upper(btrim(coalesce(p_code, '')));
  v_ref uuid;
  v_first text;
  v_role text;
  v_profile uuid;
begin
  if v_norm !~ '^[A-Z0-9]{6,12}$' then return jsonb_build_object('valid', false); end if;
  select rc.referrer_account_id into v_ref
    from public.referral_codes rc
   where rc.code = v_norm and not rc.revoked
     and (rc.expires_at is null or rc.expires_at > now()) and rc.uses < rc.max_uses;
  if v_ref is null then return jsonb_build_object('valid', false); end if;
  select p.first_name, p.role::text,
         case when p.role = 'companion' and p.visibility = 'public' and p.profile_status = 'active'
              then p.id end
    into v_first, v_role, v_profile
    from public.profile_access pa join public.profiles p on p.id = pa.profile_id
   where pa.account_id = v_ref and pa.access_role = 'owner'
   limit 1;
  return jsonb_build_object('valid', true, 'first_name', nullif(btrim(coalesce(v_first, '')), ''),
                            'referrer_role', v_role, 'companion_profile_id', v_profile);
end;
$$;
revoke all on function public.referral_preview(text) from public;
grant execute on function public.referral_preview(text) to anon, authenticated;

-- 3. Attach a code to a NEW account (attribution only; access is unchanged).
--    Best-effort and silent: returns {ok:false, reason} rather than raising, so
--    the app can call it once after sign-up without ever blocking anyone.
create or replace function public.attach_referral(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_norm text := upper(btrim(coalesce(p_code, '')));
  v_code public.referral_codes;
  v_created timestamptz;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'signed_out'); end if;
  if v_norm !~ '^[A-Z0-9]{6,12}$' then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if exists (select 1 from public.referral_redemptions where invitee_account_id = v_uid) then
    return jsonb_build_object('ok', false, 'reason', 'already_attached');
  end if;
  -- Only genuinely new accounts count (created in the last 14 days).
  select created_at into v_created from auth.users where id = v_uid;
  if v_created is null or v_created < now() - interval '14 days' then
    return jsonb_build_object('ok', false, 'reason', 'not_new');
  end if;
  select * into v_code from public.referral_codes
   where code = v_norm and not revoked and (expires_at is null or expires_at > now())
   for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if v_code.referrer_account_id = v_uid then return jsonb_build_object('ok', false, 'reason', 'self'); end if;
  if v_code.uses >= v_code.max_uses then return jsonb_build_object('ok', false, 'reason', 'exhausted'); end if;
  if exists (select 1 from public.account_access where account_id = v_code.referrer_account_id and access_level = 'blocked') then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  insert into public.referral_redemptions (code_id, referrer_account_id, invitee_account_id)
  values (v_code.id, v_code.referrer_account_id, v_uid);
  update public.referral_codes set uses = uses + 1 where id = v_code.id;

  insert into public.notifications (user_id, type, title, body, dedupe_key)
  values (v_code.referrer_account_id, 'referral_accepted', 'Someone you invited has joined',
          'A person you invited has created an Apricoti account. Thank you for helping them find good conversation.',
          'referral_accepted:' || v_uid::text)
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;

  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.attach_referral(text) from public, anon;
grant execute on function public.attach_referral(text) to authenticated;

-- 4. Who invited me? (for the "book your free first call with X" prompt)
create or replace function public.my_referrer()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_ref uuid; v_first text; v_profile uuid;
begin
  if v_uid is null then return null; end if;
  select referrer_account_id into v_ref from public.referral_redemptions where invitee_account_id = v_uid limit 1;
  if v_ref is null then return null; end if;
  select p.first_name,
         case when p.role = 'companion' and p.visibility = 'public' and p.profile_status = 'active' then p.id end
    into v_first, v_profile
    from public.profile_access pa join public.profiles p on p.id = pa.profile_id
   where pa.account_id = v_ref and pa.access_role = 'owner' limit 1;
  return jsonb_build_object('first_name', v_first, 'companion_profile_id', v_profile);
end;
$$;
revoke all on function public.my_referrer() from public, anon;
grant execute on function public.my_referrer() to authenticated;

-- 5. My invite stats (no personal details about invitees).
create or replace function public.my_referral_stats()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_joined int; v_booked int; v_paying int;
begin
  if v_uid is null then raise exception 'unauthorised' using errcode = '42501'; end if;
  select count(*),
         count(*) filter (where exists (select 1 from public.bookings b where b.booked_by_account_id = r.invitee_account_id)),
         count(*) filter (where app_private.household_paid_calls(r.invitee_account_id) > 0)
    into v_joined, v_booked, v_paying
    from public.referral_redemptions r where r.referrer_account_id = v_uid;
  return jsonb_build_object('joined', v_joined, 'booked', v_booked, 'paying', v_paying);
end;
$$;
revoke all on function public.my_referral_stats() from public, anon;
grant execute on function public.my_referral_stats() to authenticated;

-- 6. Support overview: one row per referrer with at least one invitee.
create or replace function public.support_referral_overview()
returns table (referrer_account_id uuid, referrer_name text, referrer_role text, code text,
               joined int, booked int, paying int, paid_calls int, last_joined_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app_private.is_support_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
  select r.referrer_account_id,
         max(btrim(coalesce(p.first_name, '') || ' ' || left(coalesce(p.last_name, ''), 1))),
         max(p.role::text), max(rc.code),
         count(*)::int,
         count(*) filter (where exists (select 1 from public.bookings b where b.booked_by_account_id = r.invitee_account_id))::int,
         count(*) filter (where app_private.household_paid_calls(r.invitee_account_id) > 0)::int,
         coalesce(sum(app_private.household_paid_calls(r.invitee_account_id)), 0)::int,
         max(r.redeemed_at)
    from public.referral_redemptions r
    join public.referral_codes rc on rc.id = r.code_id
    left join public.profile_access pa on pa.account_id = r.referrer_account_id and pa.access_role = 'owner'
    left join public.profiles p on p.id = pa.profile_id
   group by r.referrer_account_id
   order by 7 desc, 5 desc;
end;
$$;
revoke all on function public.support_referral_overview() from public, anon;
grant execute on function public.support_referral_overview() to authenticated;

-- ---------------------------------------------------------------------------
-- Fingerprint (every column should be true):
-- select
--   to_regprocedure('public.attach_referral(text)') is not null as attach,
--   to_regprocedure('public.referral_preview(text)') is not null as preview,
--   to_regprocedure('public.my_referrer()') is not null as my_referrer,
--   to_regprocedure('public.my_referral_stats()') is not null as stats,
--   to_regprocedure('public.support_referral_overview()') is not null as overview,
--   exists (select 1 from pg_trigger where tgname = 'referral_code_companion_cap') as cap_trigger,
--   not exists (select 1 from public.referral_codes rc
--               where app_private.referrer_is_companion(rc.referrer_account_id) and rc.max_uses < 100) as caps_raised;
-- ---------------------------------------------------------------------------
