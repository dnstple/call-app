-- 0143 — Support helper: list Companions whose profile isn't publishable yet.
--
-- Powers the admin "Email incomplete companions" action. Returns each such
-- Companion with their email and WHAT is missing (photo / short bio / consent /
-- moderation). SECURITY DEFINER and granted to service_role ONLY — the calling
-- Edge Function separately verifies the caller is a support admin, so the RPC
-- itself is a trusted server-to-server helper (it also reads auth.users email,
-- which only a definer function may do).

set search_path = '';

create or replace function public.support_incomplete_companions()
returns table (
  profile_id uuid,
  account_id uuid,
  first_name text,
  email text,
  has_photo boolean,
  bio_len integer,
  consent_signed boolean,
  moderation_status text
)
language plpgsql security definer set search_path = '' as $$
begin
  return query
  select
    p.id,
    pa.account_id,
    p.first_name,
    u.email,
    coalesce(p.avatar_path, p.photo_url) is not null,
    char_length(trim(coalesce(p.bio, ''))),
    app_private.has_current_consent(p.id, 'companion_pilot'),
    coalesce(cp.moderation_status, 'pending')
  from public.profiles p
  join public.profile_access pa on pa.profile_id = p.id and pa.access_role = 'owner'
  join auth.users u on u.id = pa.account_id
  left join public.companion_profiles cp on cp.profile_id = p.id
  where p.role = 'companion'
    and coalesce(u.email, '') <> ''
    and (
         coalesce(p.avatar_path, p.photo_url) is null
      or char_length(trim(coalesce(p.bio, ''))) < 120
      or not app_private.has_current_consent(p.id, 'companion_pilot')
      or coalesce(cp.moderation_status, 'pending') <> 'approved'
    );
end;
$$;
revoke all on function public.support_incomplete_companions() from public, anon, authenticated;
grant execute on function public.support_incomplete_companions() to service_role;

select pg_notify('pgrst', 'reload schema');
