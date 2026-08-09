-- 0144 — In-app nudge for Companions whose profile isn't publishable yet.
--
-- Replaces the email nudge with an IN-APP notification (support has emailed
-- manually). Uses the established app_private.notify_account helper, so it shows
-- in the Companion's in-app notifications and is deduped per Companion per day.
-- The notification TYPE ('profile_incomplete_nudge') maps to no email category
-- (0093), so this never generates an email.

set search_path = '';

create or replace function public.support_nudge_incomplete_companions()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_count integer := 0;
  v_day text := to_char(now(), 'YYYY-MM-DD');
begin
  if not app_private.is_support_admin() then raise exception 'unauthorised: support only'; end if;

  for r in
    select p.id as profile_id, pa.account_id
    from public.profiles p
    join public.profile_access pa on pa.profile_id = p.id and pa.access_role = 'owner'
    left join public.companion_profiles cp on cp.profile_id = p.id
    where p.role = 'companion'
      and (
           coalesce(p.avatar_path, p.photo_url) is null
        or char_length(trim(coalesce(p.bio, ''))) < 120
        or not app_private.has_current_consent(p.id, 'companion_pilot')
        or coalesce(cp.moderation_status, 'pending') <> 'approved'
      )
  loop
    perform app_private.notify_account(
      r.account_id,
      'profile_incomplete_nudge',
      'Complete your Apricoti profile',
      'Please accept the Companion Consent Agreement, finish any remaining profile sections, and add a clear, recent head-and-shoulders photo so members can book calls with you.',
      null,
      'profile_nudge:' || r.account_id::text || ':' || v_day);
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('ok', true, 'notified', v_count);
end;
$$;
revoke all on function public.support_nudge_incomplete_companions() from public, anon;
grant execute on function public.support_nudge_incomplete_companions() to authenticated;

select pg_notify('pgrst', 'reload schema');
