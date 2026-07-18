-- ============================================================
-- 0029 — relationship-scoped profile-image visibility (additive).
--
-- Why the existing safe summaries are insufficient: list_conversations
-- and my_bookings expose safe NAMES but no avatar paths, and the 0003
-- rules only let a viewer see an avatar for profiles they hold access to
-- or publicly discoverable Companions. A Companion therefore cannot see
-- the Member's photo for their own bookings/threads, and the frontend
-- had no batched, RLS-respecting way to resolve avatars for a list.
--
-- This migration adds:
--  * app_private.can_view_profile_image(p_profile) — own/managed access,
--    public Companion, or a REAL relationship (a conversation the caller
--    can access, or a booking whose other side the caller holds);
--  * public.get_profile_avatar_paths(uuid[]) — ONE batched lookup for a
--    page of rows (no N+1), returning paths only for permitted profiles;
--  * one additional PERMISSIVE storage read policy so those same viewers
--    can sign the avatar object. The bucket stays PRIVATE; anonymous
--    users still see nothing; unrelated accounts still see nothing.
-- Nothing existing is rewritten or dropped.
-- ============================================================

create or replace function app_private.can_view_profile_image(p_profile uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select
    app_private.has_profile_access(p_profile)
    or app_private.is_discoverable_companion(p_profile)
    -- A messaging relationship the caller genuinely participates in.
    or exists (
      select 1 from public.conversations c
      where (c.member_profile_id = p_profile or c.companion_profile_id = p_profile)
        and app_private.can_access_conversation(c.id)
    )
    -- A booking relationship (covers requested bookings that have no
    -- materialised thread yet — e.g. a Companion deciding on a request).
    or exists (
      select 1
      from public.bookings b
      join public.profile_access pa
        on pa.account_id = auth.uid()
       and pa.consent_status <> 'withdrawn'
       and pa.profile_id in (b.member_profile_id, b.companion_profile_id)
      where b.member_profile_id = p_profile
         or b.companion_profile_id = p_profile
    );
$$;
revoke all on function app_private.can_view_profile_image(uuid) from public, anon;
grant execute on function app_private.can_view_profile_image(uuid) to authenticated;

-- Batched avatar-path lookup: ONE call per page of rows. Permitted
-- profiles only; everything else is silently absent (never an error that
-- would reveal existence). Input capped defensively.
create or replace function public.get_profile_avatar_paths(p_profiles uuid[])
returns table (profile_id uuid, avatar_path text)
language sql stable security definer
set search_path = ''
as $$
  select p.id, p.avatar_path
  from public.profiles p
  where p.id in (select distinct u.x from unnest(p_profiles) as u(x) limit 100)
    and app_private.can_view_profile_image(p.id);
$$;
revoke all on function public.get_profile_avatar_paths(uuid[]) from public, anon;
grant execute on function public.get_profile_avatar_paths(uuid[]) to authenticated;

-- Additional permissive read policy on the PRIVATE avatars bucket for the
-- same relationship rule (signed-URL creation checks SELECT permission).
drop policy if exists "avatars: read for related people" on storage.objects;
create policy "avatars: read for related people" on storage.objects
  for select to authenticated using (
    bucket_id = 'profile-avatars'
    and app_private.can_view_profile_image(((storage.foldername(name))[1])::uuid)
  );
