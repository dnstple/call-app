-- ============================================================
-- Redesign Phase C — secure guest-call invitations (migration 0024).
--
-- Managed Members have no login. They join exactly one confirmed booking
-- through a high-entropy invitation link plus a short access code.
--
-- Security model:
--  * raw token and code are generated server-side, returned ONCE to the
--    creating Coordinator, and stored ONLY as sha256 hashes;
--  * one active invitation per booking (regenerating revokes the old one);
--  * time-limited: valid from creation until call end + 30 min grace;
--  * revocable; automatically revoked when the booking is cancelled or
--    its start time changes;
--  * anonymous access ONLY through the narrow validate RPC below and the
--    livekit-token Edge Function guest branch (service role, code checked,
--    short-lived restricted room token). No anon SELECT on any table;
--  * code attempts are rate-limited per invitation; unknown tokens fail
--    neutrally and reveal nothing about other bookings;
--  * reconnect grace: joining does not consume the invitation — it stays
--    exchangeable until expiry/revocation, and each exchanged room token
--    lives only 15 minutes.
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.guest_call_invitations (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  token_hash text not null unique,
  code_hash text not null,
  created_by_account_id uuid not null references public.accounts(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  first_joined_at timestamptz,
  code_attempt_count integer not null default 0,
  code_attempt_window_start timestamptz
);

-- Exactly one ACTIVE invitation per booking (concurrency-safe).
create unique index if not exists guest_invitations_one_active
  on public.guest_call_invitations (booking_id) where revoked_at is null;
create index if not exists guest_invitations_booking_idx
  on public.guest_call_invitations (booking_id);

-- RLS on, and NO client policies: browsers never read this table.
-- Coordinators use the status RPC; guests use the validate RPC; the Edge
-- Function uses the service role.
alter table public.guest_call_invitations enable row level security;

-- ---------- authority helper ----------
-- May this account manage guest access for this booking? Only an account
-- with non-withdrawn access to the MEMBER side (owner or coordinator).
create or replace function app_private.can_manage_guest_access(p_booking uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.bookings b
    join public.profile_access pa on pa.profile_id = b.member_profile_id
    where b.id = p_booking
      and pa.account_id = auth.uid()
      and pa.consent_status <> 'withdrawn'
  );
$$;
revoke all on function app_private.can_manage_guest_access(uuid) from public, anon, authenticated;

-- ---------- create / regenerate ----------
-- Returns the raw link token and access code EXACTLY ONCE. Regenerating
-- revokes any previous invitation for the booking.
create or replace function public.create_guest_invitation(p_booking uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_booking public.bookings;
  v_token text;
  v_code text;
  v_id uuid;
  v_expires timestamptz;
begin
  if auth.uid() is null then
    raise exception 'unauthorised: sign in required';
  end if;
  if not app_private.can_manage_guest_access(p_booking) then
    -- Neutral: does not reveal whether the booking exists.
    raise exception 'not_found: booking';
  end if;
  select * into v_booking from public.bookings where id = p_booking;
  if v_booking.status <> 'confirmed' then
    raise exception 'not_eligible: only confirmed conversations can have guest invitations';
  end if;
  if v_booking.ends_at + interval '30 minutes' < now() then
    raise exception 'not_eligible: this conversation has already ended';
  end if;

  -- Revoke any existing active invitation (rotation).
  update public.guest_call_invitations
     set revoked_at = now()
   where booking_id = p_booking and revoked_at is null;

  -- High-entropy secrets, hashed at rest.
  v_token := encode(extensions.gen_random_bytes(24), 'hex');   -- 192 bits
  v_code  := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint & 2147483647) % 1000000)::text, 6, '0');
  v_expires := v_booking.ends_at + interval '30 minutes';

  insert into public.guest_call_invitations
    (booking_id, token_hash, code_hash, created_by_account_id, expires_at)
  values
    (p_booking,
     encode(extensions.digest(v_token, 'sha256'), 'hex'),
     encode(extensions.digest(v_code, 'sha256'), 'hex'),
     auth.uid(), v_expires)
  returning id into v_id;

  -- Trusted system message (no secrets in the payload).
  begin
    perform app_private.post_system_message(
      c.id, 'guest_invitation_created',
      jsonb_build_object('booking_id', p_booking),
      'guest_invitation_created:' || p_booking::text || ':' || v_id::text)
    from public.conversations c
    where c.member_profile_id = v_booking.member_profile_id
      and c.companion_profile_id = v_booking.companion_profile_id;
  exception when others then null; -- messaging thread may not exist yet
  end;

  return jsonb_build_object(
    'invitation_id', v_id,
    'token', v_token,
    'code', v_code,
    'expires_at', v_expires);
end;
$$;
revoke all on function public.create_guest_invitation(uuid) from public, anon;
grant execute on function public.create_guest_invitation(uuid) to authenticated;

-- ---------- revoke ----------
create or replace function public.revoke_guest_invitation(p_booking uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_revoked int;
begin
  if auth.uid() is null then
    raise exception 'unauthorised: sign in required';
  end if;
  if not app_private.can_manage_guest_access(p_booking) then
    raise exception 'not_found: booking';
  end if;
  update public.guest_call_invitations
     set revoked_at = now()
   where booking_id = p_booking and revoked_at is null;
  get diagnostics v_revoked = row_count;
  if v_revoked > 0 then
    begin
      perform app_private.post_system_message(
        c.id, 'guest_invitation_revoked',
        jsonb_build_object('booking_id', p_booking),
        'guest_invitation_revoked:' || p_booking::text || ':' || now()::text)
      from public.conversations c
      join public.bookings b on b.id = p_booking
      where c.member_profile_id = b.member_profile_id
        and c.companion_profile_id = b.companion_profile_id;
    exception when others then null;
    end;
  end if;
end;
$$;
revoke all on function public.revoke_guest_invitation(uuid) from public, anon;
grant execute on function public.revoke_guest_invitation(uuid) to authenticated;

-- ---------- coordinator-side status (no secrets) ----------
create or replace function public.get_guest_invitation_status(p_booking uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_row public.guest_call_invitations;
begin
  if auth.uid() is null or not app_private.can_manage_guest_access(p_booking) then
    raise exception 'not_found: booking';
  end if;
  select * into v_row
  from public.guest_call_invitations
  where booking_id = p_booking and revoked_at is null
  order by created_at desc limit 1;
  if v_row.id is null then
    return jsonb_build_object('has_active', false);
  end if;
  return jsonb_build_object(
    'has_active', true,
    'created_at', v_row.created_at,
    'expires_at', v_row.expires_at,
    'first_joined_at', v_row.first_joined_at);
end;
$$;
revoke all on function public.get_guest_invitation_status(uuid) from public, anon;
grant execute on function public.get_guest_invitation_status(uuid) to authenticated;

-- ---------- anonymous validation (link opened) ----------
-- Neutral by design: every failure is the same 'invalid' state. Success
-- returns ONLY safe display fields — never ids of other records, never
-- hashes, never the code. The room token itself requires the access code
-- and is issued by the Edge Function, not here.
create or replace function public.validate_guest_invitation(p_token text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_inv public.guest_call_invitations;
  v_b public.bookings;
  v_companion text;
  v_member text;
  v_state text;
begin
  if p_token is null or length(p_token) < 16 or length(p_token) > 128 then
    return jsonb_build_object('state', 'invalid');
  end if;
  select * into v_inv
  from public.guest_call_invitations
  where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  if v_inv.id is null or v_inv.revoked_at is not null then
    return jsonb_build_object('state', 'invalid');
  end if;
  if v_inv.expires_at < now() then
    return jsonb_build_object('state', 'expired');
  end if;
  select * into v_b from public.bookings where id = v_inv.booking_id;
  if v_b.id is null or v_b.status <> 'confirmed' then
    return jsonb_build_object('state', 'invalid');
  end if;

  select p.first_name into v_companion from public.profiles p where p.id = v_b.companion_profile_id;
  select p.first_name into v_member from public.profiles p where p.id = v_b.member_profile_id;

  v_state := case
    when now() < v_b.starts_at - interval '15 minutes' then 'waiting'
    when now() > v_b.ends_at + interval '30 minutes' then 'expired'
    else 'open'
  end;

  return jsonb_build_object(
    'state', v_state,
    'companion_name', coalesce(v_companion, 'Your Companion'),
    'member_name', coalesce(v_member, ''),
    'starts_at', v_b.starts_at,
    'ends_at', v_b.ends_at,
    'duration_minutes', v_b.duration_minutes,
    'timezone', v_b.timezone);
end;
$$;
revoke all on function public.validate_guest_invitation(text) from public;
grant execute on function public.validate_guest_invitation(text) to anon, authenticated;

-- ---------- code attempt rate limiting (used by the Edge Function) ----------
-- 10 attempts per 15-minute window per invitation. SECURITY DEFINER so the
-- service role records attempts atomically; returns whether the attempt is
-- allowed AND whether the code matched. Never exposed to anon directly.
create or replace function app_private.check_guest_code(p_token text, p_code text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_inv public.guest_call_invitations;
begin
  select * into v_inv
  from public.guest_call_invitations
  where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
  for update;
  if v_inv.id is null or v_inv.revoked_at is not null or v_inv.expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  -- Sliding attempt window.
  if v_inv.code_attempt_window_start is null
     or v_inv.code_attempt_window_start < now() - interval '15 minutes' then
    update public.guest_call_invitations
       set code_attempt_count = 1, code_attempt_window_start = now()
     where id = v_inv.id;
  else
    if v_inv.code_attempt_count >= 10 then
      return jsonb_build_object('ok', false, 'reason', 'rate_limited');
    end if;
    update public.guest_call_invitations
       set code_attempt_count = code_attempt_count + 1
     where id = v_inv.id;
  end if;

  if v_inv.code_hash <> encode(extensions.digest(coalesce(p_code, ''), 'sha256'), 'hex') then
    return jsonb_build_object('ok', false, 'reason', 'wrong_code');
  end if;

  update public.guest_call_invitations
     set first_joined_at = coalesce(first_joined_at, now())
   where id = v_inv.id;

  return jsonb_build_object('ok', true, 'booking_id', v_inv.booking_id, 'invitation_id', v_inv.id);
end;
$$;
revoke all on function app_private.check_guest_code(text, text) from public, anon, authenticated;

-- Service-role wrapper for the Edge Function (PostgREST exposes only the
-- public schema). Locked to service_role — browsers cannot call it.
create or replace function public.exchange_guest_invitation(p_token text, p_code text)
returns jsonb
language sql security definer
set search_path = ''
as $$
  select app_private.check_guest_code(p_token, p_code);
$$;
revoke all on function public.exchange_guest_invitation(text, text) from public, anon, authenticated;
grant execute on function public.exchange_guest_invitation(text, text) to service_role;

-- ---------- lifecycle: cancellation / reschedule revokes access ----------
create or replace function app_private.revoke_guest_invitations_on_change()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if (new.status = 'cancelled' and old.status <> 'cancelled')
     or (new.starts_at <> old.starts_at) then
    update public.guest_call_invitations
       set revoked_at = now()
     where booking_id = new.id and revoked_at is null;
  end if;
  return new;
end;
$$;
revoke all on function app_private.revoke_guest_invitations_on_change() from public, anon, authenticated;
drop trigger if exists bookings_revoke_guest_invitations on public.bookings;
create trigger bookings_revoke_guest_invitations
  after update on public.bookings
  for each row execute function app_private.revoke_guest_invitations_on_change();
