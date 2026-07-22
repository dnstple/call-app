-- ============================================================
-- Stage 3A operational fix — unify the managed (guest) Member into the ONE call
-- session's Member participant slot (migration 0066).
--
-- Additive to the immutable 0001–0065 baseline. A Coordinator-managed Member has
-- NO owner account, so 0064's ensure_call_session creates only the Companion
-- participant row; the guest joins with identity `guest_member-<invitationId>`,
-- which matches no call_participants row, so ingest_call_event returns
-- `ignored_unexpected_identity` and the Member is never marked present. Sharing
-- the room name (commit 86c4750) fixes LiveKit-level audio but NOT the durable
-- presence/duration model or support diagnostics.
--
-- This migration lets the Member slot be occupied by a VERIFIED guest invitation
-- instead of an owner account, and adds a service-role RPC that provisions that
-- slot with a SERVER-DERIVED identity (never a browser-supplied string, never a
-- bare prefix). The authenticated owner-account rule is unchanged: a guest may
-- take the Member slot ONLY when the Member profile has no owner account, and can
-- never overwrite an account-held slot or occupy the Companion slot.
--
-- ingest_call_event (0064/0065) is unchanged: it already accepts a participant
-- event ONLY when its identity matches an existing call_participants row. Once
-- the guest identity is written to the Member slot here, the existing row-match
-- logic records the guest's presence, duration and abort counts as the Member.
--
-- No money, no booking completion, no cron, no Stripe/LiveKit calls.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The Member slot may be held by a verified guest invitation (no account).
-- ------------------------------------------------------------
alter table public.call_participants alter column account_id drop not null;
alter table public.call_participants
  add column if not exists guest_invitation_id uuid references public.guest_call_invitations(id);

-- Exactly one holder: an owner ACCOUNT, or a verified guest INVITATION (Member
-- slot only). Never both, never neither. A guest can never hold the Companion.
do $$
begin
  alter table public.call_participants
    add constraint call_participants_owner_xor_guest check (
      (account_id is not null and guest_invitation_id is null)
      or (account_id is null and guest_invitation_id is not null and booking_role = 'member'));
exception when duplicate_object then null;
end $$;

-- ------------------------------------------------------------
-- 2. Service-role: provision the Member slot for a VERIFIED guest invitation.
--    The identity is server-derived (`guest_member-<invitationId>`); the booking,
--    invitation validity and no-owner rule are all enforced here.
-- ------------------------------------------------------------
create or replace function app_private.ensure_guest_member_participant(
  p_booking uuid, p_invitation uuid, p_identity text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_b public.bookings;
  v_inv public.guest_call_invitations;
  v_session public.call_sessions;
  v_member_owner uuid;
  v_expected_identity text := 'guest_member-' || p_invitation::text;
begin
  -- The identity is fully server-derived; a caller cannot inject an arbitrary one.
  if p_identity is distinct from v_expected_identity then
    raise exception 'identity_mismatch';
  end if;

  select * into v_b from public.bookings where id = p_booking;
  if v_b.id is null then raise exception 'not_found'; end if;
  if v_b.status <> 'confirmed' then raise exception 'not_eligible'; end if;

  -- The invitation must exist, belong to THIS booking, and be live.
  select * into v_inv from public.guest_call_invitations
    where id = p_invitation and booking_id = p_booking;
  if v_inv.id is null or v_inv.revoked_at is not null or v_inv.expires_at < now() then
    raise exception 'not_found';
  end if;

  -- A guest may ONLY hold the Member slot when the Member has no own account.
  v_member_owner := app_private.profile_owner_account(v_b.member_profile_id);
  if v_member_owner is not null then
    raise exception 'member_has_owner';
  end if;

  -- One stable session (provisions the Companion slot too).
  perform app_private.ensure_call_session(p_booking);
  select * into v_session from public.call_sessions where booking_id = p_booking;
  if v_session.id is null then raise exception 'not_found'; end if;

  -- Occupy the Member slot as the verified guest. Never overwrite an
  -- account-held slot (the WHERE guard); a rejoin reuses the SAME logical row.
  insert into public.call_participants
    (call_session_id, account_id, booking_role, provider_identity, guest_invitation_id)
  values (v_session.id, null, 'member', v_expected_identity, p_invitation)
  on conflict (call_session_id, booking_role) do update
    set provider_identity = excluded.provider_identity,
        guest_invitation_id = excluded.guest_invitation_id,
        updated_at = now()
    where public.call_participants.account_id is null;

  return jsonb_build_object(
    'call_session_id', v_session.id, 'room_name', v_session.room_name,
    'scheduled_start', v_session.scheduled_start, 'scheduled_end', v_session.scheduled_end);
end;
$$;
revoke all on function app_private.ensure_guest_member_participant(uuid, uuid, text) from public, anon, authenticated;
grant execute on function app_private.ensure_guest_member_participant(uuid, uuid, text) to service_role;

-- Public, service-role-only wrapper (PostgREST exposure for the Edge Function).
create or replace function public.ensure_guest_member_participant(
  p_booking uuid, p_invitation uuid, p_identity text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return app_private.ensure_guest_member_participant(p_booking, p_invitation, p_identity);
end;
$$;
revoke all on function public.ensure_guest_member_participant(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.ensure_guest_member_participant(uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- 3. Extend the support diagnostic surface so a guest-held Member slot is
--    legible (whether the slot is an account or an invitation). Support-only.
-- ------------------------------------------------------------
create or replace function public.support_call_diagnostics(p_booking uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb; v_s public.call_sessions;
begin
  if not app_private.is_support_admin() then raise exception 'not_found: diagnostics'; end if;
  select * into v_s from public.call_sessions where booking_id = p_booking;
  if v_s.id is null then return jsonb_build_object('session', null); end if;
  select jsonb_build_object(
    'session', jsonb_build_object(
      'id', v_s.id, 'booking_id', v_s.booking_id, 'provider', v_s.provider, 'room_name', v_s.room_name,
      'state', v_s.state, 'scheduled_start', v_s.scheduled_start, 'scheduled_end', v_s.scheduled_end,
      'first_participant_joined_at', v_s.first_participant_joined_at, 'both_connected_at', v_s.both_connected_at,
      'room_finished_at', v_s.room_finished_at, 'anomaly_count', v_s.anomaly_count,
      'last_provider_event_at', v_s.last_provider_event_at),
    'participants', coalesce((select jsonb_agg(jsonb_build_object(
        'account_id', p.account_id, 'guest_invitation_id', p.guest_invitation_id,
        'holder', case when p.account_id is not null then 'account' else 'guest' end,
        'booking_role', p.booking_role, 'provider_identity', p.provider_identity,
        'first_joined_at', p.first_joined_at, 'last_joined_at', p.last_joined_at, 'last_left_at', p.last_left_at,
        'join_count', p.join_count, 'connection_abort_count', p.connection_abort_count,
        'connected_seconds', p.connected_seconds, 'currently_connected', p.currently_connected)
      order by p.booking_role) from public.call_participants p where p.call_session_id = v_s.id), '[]'::jsonb),
    'latest_events', coalesce((select jsonb_agg(jsonb_build_object(
        'event_type', e.event_type, 'result', e.result, 'error_code', e.error_code,
        'provider_created_at', e.provider_created_at, 'received_at', e.received_at)
      order by e.received_at desc) from (
        select * from public.call_provider_events where call_session_id = v_s.id order by received_at desc limit 20) e), '[]'::jsonb)
  ) into v;
  return v;
end;
$$;
revoke all on function public.support_call_diagnostics(uuid) from public, anon;
grant execute on function public.support_call_diagnostics(uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');
