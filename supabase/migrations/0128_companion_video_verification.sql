-- 0128 — Companion video verification.
--
-- Companions on an allowlist record a short identity video (30–90s) from their
-- profile AFTER signup. Support reviews it in the internal console and approves
-- or rejects; the profile can't be considered ready until it is approved.
--
--   * video_verification_allowlist    — emails for whom the step is active
--     (seeded with danpinchen@outlook.com; extensible without code changes).
--   * companion_verification_videos    — one row per submission.
--   * verification-videos storage bucket (private) + object policies.
--   * RPCs: my_video_verification, submit_verification_video,
--     admin_list_verification_videos, admin_review_verification_video.
--   * application_checklist gains a required "video verification" item for
--     allowlisted companions (done only once approved). Additive; apply after 0127.

set search_path = '';

-- ---------- Allowlist ----------
create table if not exists public.video_verification_allowlist (
  email text primary key,
  created_at timestamptz not null default now()
);
insert into public.video_verification_allowlist (email)
values ('danpinchen@outlook.com')
on conflict (email) do nothing;
alter table public.video_verification_allowlist enable row level security;
-- No policies: readable only by SECURITY DEFINER functions / service_role.

-- ---------- Submissions ----------
create table if not exists public.companion_verification_videos (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  storage_path text not null,
  duration_seconds integer not null check (duration_seconds between 1 and 3600),
  mime_type text not null default 'video/webm',
  size_bytes bigint,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  review_notes text,
  reviewed_by uuid references public.accounts(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists cvv_status_idx on public.companion_verification_videos (status, created_at desc);
create index if not exists cvv_profile_idx on public.companion_verification_videos (profile_id, created_at desc);
alter table public.companion_verification_videos enable row level security;
-- No table policies: all access is through the RPCs below.

-- ---------- Enable helper ----------
create or replace function app_private.video_verification_enabled(p_account uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u
    join public.video_verification_allowlist a on lower(a.email) = lower(u.email)
    where u.id = p_account);
$$;
revoke all on function app_private.video_verification_enabled(uuid) from public, anon;
grant execute on function app_private.video_verification_enabled(uuid) to authenticated;

-- ---------- Companion: my status ----------
create or replace function public.my_video_verification()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_account uuid := auth.uid();
  v_profile uuid;
  v_enabled boolean;
  v_video jsonb;
begin
  if v_account is null then raise exception 'unauthorised: sign in required' using errcode = '42501'; end if;
  v_enabled := app_private.video_verification_enabled(v_account);
  v_profile := app_private.companion_profile_for(v_account);
  if v_profile is not null then
    select to_jsonb(t) into v_video from (
      select id, status, duration_seconds, review_notes, created_at, reviewed_at
      from public.companion_verification_videos
      where profile_id = v_profile
      order by created_at desc
      limit 1) t;
  end if;
  return jsonb_build_object(
    'enabled', coalesce(v_enabled, false),
    'min_seconds', 30, 'max_seconds', 90,
    'status', coalesce(v_video->>'status', 'none'),
    'video', v_video);
end;
$$;
revoke all on function public.my_video_verification() from public, anon;
grant execute on function public.my_video_verification() to authenticated;

-- ---------- Companion: submit ----------
create or replace function public.submit_verification_video(
  p_storage_path text,
  p_duration_seconds integer,
  p_mime text default 'video/webm',
  p_size bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_account uuid := auth.uid();
  v_profile uuid;
  v_id uuid;
begin
  if v_account is null then raise exception 'unauthorised: sign in required' using errcode = '42501'; end if;
  if not app_private.video_verification_enabled(v_account) then
    raise exception 'not_enabled: video verification is not enabled for this account' using errcode = '42501';
  end if;
  v_profile := app_private.companion_profile_for(v_account);
  if v_profile is null then raise exception 'not_found: no companion profile' using errcode = '42501'; end if;
  if p_duration_seconds is null or p_duration_seconds < 30 or p_duration_seconds > 90 then
    raise exception 'duration_out_of_range: the video must be between 30 and 90 seconds' using errcode = 'P0001';
  end if;
  -- The upload must live under the caller's own profile folder.
  if p_storage_path is null or p_storage_path not like (v_profile::text || '/%') then
    raise exception 'invalid_path' using errcode = 'P0001';
  end if;

  -- One live submission per profile: clear any prior (non-approved) attempts.
  delete from public.companion_verification_videos
  where profile_id = v_profile and status <> 'approved';

  insert into public.companion_verification_videos
    (profile_id, account_id, storage_path, duration_seconds, mime_type, size_bytes)
  values (v_profile, v_account, p_storage_path, p_duration_seconds, coalesce(nullif(btrim(p_mime), ''), 'video/webm'), p_size)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'status', 'pending');
end;
$$;
revoke all on function public.submit_verification_video(text, integer, text, bigint) from public, anon;
grant execute on function public.submit_verification_video(text, integer, text, bigint) to authenticated;

-- ---------- Support: list ----------
create or replace function public.admin_list_verification_videos(p_status text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app_private.require_support();
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', vv.id, 'profile_id', vv.profile_id, 'account_id', vv.account_id,
      'name', btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')),
      'email', u.email,
      'storage_path', vv.storage_path, 'duration_seconds', vv.duration_seconds,
      'mime_type', vv.mime_type, 'size_bytes', vv.size_bytes, 'status', vv.status,
      'review_notes', vv.review_notes, 'reviewed_at', vv.reviewed_at, 'created_at', vv.created_at)
      order by vv.created_at desc), '[]'::jsonb)
    into v
  from public.companion_verification_videos vv
  join public.profiles p on p.id = vv.profile_id
  left join auth.users u on u.id = vv.account_id
  where p_status is null or vv.status = p_status;
  return v;
end;
$$;
revoke all on function public.admin_list_verification_videos(text) from public, anon;
grant execute on function public.admin_list_verification_videos(text) to authenticated;

-- ---------- Support: review ----------
create or replace function public.admin_review_verification_video(
  p_id uuid, p_decision text, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_account uuid; v_updated int;
begin
  perform app_private.require_support();
  if p_decision not in ('approved', 'rejected') then
    raise exception 'invalid_decision' using errcode = 'P0001';
  end if;
  select account_id into v_account from public.companion_verification_videos where id = p_id;
  if v_account is null then raise exception 'not_found' using errcode = 'P0001'; end if;

  update public.companion_verification_videos set
    status = p_decision,
    review_notes = nullif(btrim(p_notes), ''),
    reviewed_by = auth.uid(),
    reviewed_at = now()
  where id = p_id;
  get diagnostics v_updated = row_count;

  perform app_private.audit_access(v_account, 'verification_video_' || p_decision,
    jsonb_build_object('video_id', p_id), null, p_notes);

  return jsonb_build_object('ok', true, 'id', p_id, 'status', p_decision, 'updated', v_updated);
end;
$$;
revoke all on function public.admin_review_verification_video(uuid, text, text) from public, anon;
grant execute on function public.admin_review_verification_video(uuid, text, text) to authenticated;

-- ---------- Storage: private bucket + policies ----------
-- Object path: {profile_id}/{uuid}.webm — never user-defined names.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('verification-videos', 'verification-videos', false, 104857600,
        array['video/webm', 'video/mp4'])
on conflict (id) do nothing;

drop policy if exists "verif videos: upload own (allowlisted)" on storage.objects;
create policy "verif videos: upload own (allowlisted)" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'verification-videos'
    and app_private.can_edit_profile(((storage.foldername(name))[1])::uuid)
    and app_private.video_verification_enabled(auth.uid())
  );

drop policy if exists "verif videos: read own or support" on storage.objects;
create policy "verif videos: read own or support" on storage.objects
  for select to authenticated using (
    bucket_id = 'verification-videos'
    and (
      app_private.is_support_admin()
      or app_private.can_edit_profile(((storage.foldername(name))[1])::uuid)
    )
  );

drop policy if exists "verif videos: delete own or support" on storage.objects;
create policy "verif videos: delete own or support" on storage.objects
  for delete to authenticated using (
    bucket_id = 'verification-videos'
    and (
      app_private.is_support_admin()
      or app_private.can_edit_profile(((storage.foldername(name))[1])::uuid)
    )
  );

-- ---------- Checklist gate ----------
-- Add a required "video verification" item for allowlisted companions (done only
-- once approved). Body is 0122 + the conditional video item.
create or replace function public.application_checklist(p_account uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_account uuid := coalesce(p_account, auth.uid());
  v_profile uuid;
  v_role text;
  v_items jsonb := '[]'::jsonb;
  v_req_total int := 0; v_req_done int := 0;
  v_video_enabled boolean := false; b_video boolean := false;
  b_email boolean; b_photo boolean; b_bio boolean; b_interests boolean;
  b_avail boolean; b_offers boolean; b_consent boolean; b_payout boolean;
begin
  if v_account is null then raise exception 'unauthorised: sign in required' using errcode = '42501'; end if;
  if v_account <> auth.uid() and not app_private.is_support_admin() then
    raise exception 'unauthorised' using errcode = '42501';
  end if;

  v_role := app_private.account_role(v_account);
  v_profile := app_private.companion_profile_for(v_account);
  if v_profile is null then
    return jsonb_build_object('role', v_role, 'is_companion', false,
      'items', '[]'::jsonb, 'required_total', 0, 'required_done', 0,
      'complete', false, 'completion_pct', 0);
  end if;

  b_email := exists (select 1 from auth.users u where u.id = v_account and u.email_confirmed_at is not null);
  select (coalesce(p.photo_url,'') <> ''),
         (length(btrim(p.bio)) >= 120),
         ((select count(*) from public.profile_interests pi where pi.profile_id = p.id) >= 3)
    into b_photo, b_bio, b_interests
    from public.profiles p where p.id = v_profile;
  b_avail   := exists (select 1 from public.availability_rules a where a.companion_profile_id = v_profile);
  b_offers  := exists (select 1 from public.conversation_offers o where o.companion_profile_id = v_profile and o.active);
  b_consent := app_private.has_current_consent(v_profile, 'companion_pilot');
  b_payout  := exists (select 1 from public.connected_accounts ca where ca.account_id = v_account);

  v_video_enabled := app_private.video_verification_enabled(v_account);
  if v_video_enabled then
    b_video := exists (select 1 from public.companion_verification_videos vv
                       where vv.profile_id = v_profile and vv.status = 'approved');
  end if;

  v_items := jsonb_build_array(
    jsonb_build_object('key','verified_email','label','Confirm your email address','category','required','done',coalesce(b_email,false),'section','settings'),
    jsonb_build_object('key','profile_photo','label','Add a profile photo','category','required','done',coalesce(b_photo,false),'section','profile'),
    jsonb_build_object('key','biography','label','Write a short biography (at least 120 characters)','category','required','done',coalesce(b_bio,false),'section','profile'),
    jsonb_build_object('key','interests','label','Choose at least three interests','category','required','done',coalesce(b_interests,false),'section','profile'),
    jsonb_build_object('key','availability','label','Set your availability','category','required','done',coalesce(b_avail,false),'section','availability'),
    jsonb_build_object('key','conversation_offers','label','Add at least one conversation offer with a price','category','required','done',coalesce(b_offers,false),'section','availability'),
    jsonb_build_object('key','safeguarding_consent','label','Agree to the safeguarding and conduct terms','category','required','done',coalesce(b_consent,false),'section','settings'),
    jsonb_build_object('key','payout_setup','label','Set up payouts (you can do this later)','category','deferred','done',coalesce(b_payout,false),'section','settings')
  );
  if v_video_enabled then
    v_items := v_items || jsonb_build_array(
      jsonb_build_object('key','video_verification','label','Complete video verification','category','required','done',coalesce(b_video,false),'section','profile'));
  end if;

  select count(*) filter (where (i->>'category') = 'required'),
         count(*) filter (where (i->>'category') = 'required' and (i->>'done')::boolean)
    into v_req_total, v_req_done
    from jsonb_array_elements(v_items) i;

  return jsonb_build_object(
    'role', v_role, 'is_companion', true, 'items', v_items,
    'required_total', v_req_total, 'required_done', v_req_done,
    'complete', (v_req_done = v_req_total),
    'completion_pct', case when v_req_total = 0 then 0 else round(100.0 * v_req_done / v_req_total) end
  );
end;
$$;
revoke all on function public.application_checklist(uuid) from public, anon;
grant execute on function public.application_checklist(uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');
