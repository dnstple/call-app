-- ===========================================================================
-- 0181_relax_companion_completeness.sql
--
-- Membership/credit model cleanup: companions no longer set their own prices
-- (calls are a fixed credit value) and self-managed availability/rates are being
-- hidden. So a companion's public-readiness no longer requires an active priced
-- conversation offer OR an availability rule — only a photo, a meaningful
-- description, a headline and at least one interest.
--
-- Redefines the single source of truth (app_private.companion_profile_complete)
-- used by activate_companion_profile(), the activation guard trigger and the
-- completion checklist. The discoverable_companions view is unchanged (it only
-- ever required photo + bio). Additive: no data is removed; existing offers /
-- availability rows simply stop being a gate.
-- ===========================================================================

set search_path = '';

create or replace function app_private.companion_profile_complete(p_profile uuid)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_p public.profiles;
  v_bio text;
begin
  select * into v_p from public.profiles where id = p_profile and role = 'companion';
  if v_p.id is null then return false; end if;

  -- Photo required — initials are not a public Companion identity.
  if coalesce(v_p.avatar_path, v_p.photo_url) is null then return false; end if;

  -- Meaningful description: 120–1000 chars trimmed, not one repeated character.
  v_bio := trim(coalesce(v_p.bio, ''));
  if char_length(v_bio) < 120 or char_length(v_bio) > 1000 then return false; end if;
  if char_length(replace(v_bio, substr(v_bio, 1, 1), '')) < 20 then return false; end if;
  if lower(v_bio) like 'lorem ipsum%' then return false; end if;

  if trim(coalesce(v_p.headline, '')) = '' then return false; end if;

  if not exists (select 1 from public.profile_interests pi where pi.profile_id = p_profile) then
    return false;
  end if;

  -- NOTE (0181): availability-rule and priced-offer requirements REMOVED.
  -- Pricing is fixed by the credit model; availability/rates are no longer
  -- companion-managed, so neither gates public readiness anymore.
  return true;
end;
$$;
revoke all on function app_private.companion_profile_complete(uuid) from public, anon, authenticated;

-- Refresh the activation error wording (completeness now = photo/description/
-- headline/interests). The completeness check itself is the relaxed function.
create or replace function public.activate_companion_profile(p_profile uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'unauthorised: sign in required';
  end if;
  if not exists (
    select 1 from public.profile_access pa
    where pa.profile_id = p_profile
      and pa.account_id = auth.uid()
      and pa.can_edit
      and pa.consent_status <> 'withdrawn'
  ) then
    raise exception 'not_found: profile';
  end if;
  if not app_private.companion_profile_complete(p_profile) then
    raise exception 'incomplete_profile: add a photo, a fuller description, a headline and interests first';
  end if;
  update public.profiles
     set profile_status = 'active', visibility = 'public'
   where id = p_profile;
  return jsonb_build_object('active', true);
end;
$$;
revoke all on function public.activate_companion_profile(uuid) from public, anon;
grant execute on function public.activate_companion_profile(uuid) to authenticated;

-- Application checklist (Pilot Hub): drop the two prompts companions no longer
-- need — "Set your availability" and "Add at least one conversation offer with a
-- price". Mirrors 0128 exactly minus those two required items, so a companion is
-- application-complete on email + photo + bio + interests + consent (+ video when
-- enabled). Payout stays a deferred (optional) item.
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
  b_consent boolean; b_payout boolean;
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
