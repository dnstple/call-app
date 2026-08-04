-- 0122 — application_checklist: count interests from profile_interests.
--
-- The "Choose at least three interests" item tested
-- array_length(profiles.interests) — the LEGACY array column, which signup never
-- populates (selected interests are written to the profile_interests join table
-- via replace_profile_interests). So the item always showed Incomplete even when
-- three or more interests were chosen. This counts the join table instead. Body
-- is otherwise identical to 0107. Additive; apply after 0121.

set search_path = '';

create or replace function public.application_checklist(p_account uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_account uuid := coalesce(p_account, auth.uid());
  v_profile uuid;
  v_role text;
  v_items jsonb := '[]'::jsonb;
  v_req_total int := 0; v_req_done int := 0;
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
         -- FIX: interests live in the profile_interests join table, not the
         -- legacy profiles.interests array column.
         ((select count(*) from public.profile_interests pi where pi.profile_id = p.id) >= 3)
    into b_photo, b_bio, b_interests
    from public.profiles p where p.id = v_profile;
  b_avail   := exists (select 1 from public.availability_rules a where a.companion_profile_id = v_profile);
  b_offers  := exists (select 1 from public.conversation_offers o where o.companion_profile_id = v_profile and o.active);
  b_consent := app_private.has_current_consent(v_profile, 'companion_pilot');
  b_payout  := exists (select 1 from public.connected_accounts ca where ca.account_id = v_account);

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
