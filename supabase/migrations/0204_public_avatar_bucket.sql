-- ===========================================================================
-- 0204_public_avatar_bucket.sql
--
-- Reduce egress: serve profile avatars from a PUBLIC, CDN-cacheable bucket with
-- stable URLs instead of per-render 1-hour signed URLs. Signed URLs change every
-- time and aren't cached at the edge, so the same photo was re-downloaded on
-- every Explore grid / profile / cover render. Public URLs are stable, so the
-- browser and Supabase's CDN cache each photo and repeat views cost ~0 egress.
-- The frontend now serves getPublicUrl(...) and uploads with a 1-year cache header.
--
-- Trade-off: an avatar is readable by anyone holding its (unguessable) object URL
-- — standard for profile photos, which are already shown across the app. Upload
-- and delete remain controlled by the existing storage RLS policies.
-- ===========================================================================

set search_path = '';

update storage.buckets set public = true where id = 'profile-avatars';

select pg_notify('pgrst', 'reload schema');
