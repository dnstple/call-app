-- ============================================================
-- 0028 — link-based guest joining (accessibility change).
--
-- Product decision: a managed Member opening a valid secure invitation
-- link no longer types a six-digit code. The invitation URL is already a
-- high-entropy (192-bit), booking-specific, hashed-at-rest, revocable,
-- time-limited bearer credential — the code added a step for older
-- users without adding a meaningful security boundary (it was only ever
-- usable TOGETHER with the link).
--
-- What changes:
--  * new app_private.check_guest_invitation(p_token) — identical
--    validation to 0024's code path (hash lookup, revocation, expiry,
--    attempt rate limiting, first_joined_at) WITHOUT the code check;
--  * new single-argument public.exchange_guest_invitation(p_token),
--    service_role-only, used by the livekit-token Edge Function.
--
-- What does NOT change:
--  * every window/status/revocation rule stays server-side;
--  * tokens remain hashed; nothing is exposed to anon/authenticated;
--  * the 0024 code columns AND the two-argument exchange function are
--    RETAINED, functional and untouched for backward compatibility.
--    They are now unused by the product flow and may be dropped in a
--    later cleanup migration (documented, deliberate).
--  * existing invitation rows keep working through their links.
-- ============================================================

create or replace function app_private.check_guest_invitation(p_token text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_inv public.guest_call_invitations;
begin
  if p_token is null or length(p_token) < 16 or length(p_token) > 128 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  select * into v_inv
  from public.guest_call_invitations
  where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
  for update;
  if v_inv.id is null or v_inv.revoked_at is not null or v_inv.expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  -- Same sliding attempt window as 0024 — exchange attempts stay
  -- rate-limited per invitation even without a code.
  if v_inv.code_attempt_window_start is null
     or v_inv.code_attempt_window_start < now() - interval '15 minutes' then
    update public.guest_call_invitations
       set code_attempt_count = 1, code_attempt_window_start = now()
     where id = v_inv.id;
  else
    if v_inv.code_attempt_count >= 30 then
      return jsonb_build_object('ok', false, 'reason', 'rate_limited');
    end if;
    update public.guest_call_invitations
       set code_attempt_count = code_attempt_count + 1
     where id = v_inv.id;
  end if;

  update public.guest_call_invitations
     set first_joined_at = coalesce(first_joined_at, now())
   where id = v_inv.id;

  return jsonb_build_object('ok', true, 'booking_id', v_inv.booking_id, 'invitation_id', v_inv.id);
end;
$$;
revoke all on function app_private.check_guest_invitation(text) from public, anon, authenticated;

-- Service-role wrapper (the Edge Function's ONLY entry point). Browsers
-- can never call this; anonymous guests go through the Edge Function.
create or replace function public.exchange_guest_invitation(p_token text)
returns jsonb
language sql security definer
set search_path = ''
as $$
  select app_private.check_guest_invitation(p_token);
$$;
revoke all on function public.exchange_guest_invitation(text) from public, anon, authenticated;
grant execute on function public.exchange_guest_invitation(text) to service_role;
