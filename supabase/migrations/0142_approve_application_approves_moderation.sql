-- 0142 — Approving a Companion's application also approves their moderation.
--
-- Previously admin_approve_application only recorded the application decision;
-- companion_profiles.moderation_status stayed 'pending', so an approved
-- Companion still wasn't discoverable until a SEPARATE Trust & Safety approval.
-- This aligns them: approving the application in the access console approves the
-- Companion for discovery too, leaving only the Community Agreement for them to
-- sign. Only a 'pending' moderation is auto-approved (never overrides a
-- deliberate suspend/reject). Reuses the audited support_set_companion_moderation.

set search_path = '';

create or replace function public.admin_approve_application(p_account uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb; v_profile uuid;
begin
  -- Record the application decision (existing behaviour).
  v_result := app_private.admin_set_app_status(
    p_account, 'approved', 'application_approved', 'application_approved', p_reason, false);

  -- Also approve the Companion for discovery, if they own a companion profile
  -- that is still pending moderation.
  select p.id into v_profile
    from public.profiles p
    join public.profile_access pa on pa.profile_id = p.id
    join public.companion_profiles cp on cp.profile_id = p.id
   where pa.account_id = p_account
     and pa.access_role = 'owner'
     and p.role = 'companion'
     and cp.moderation_status = 'pending'
   limit 1;
  if v_profile is not null then
    perform public.support_set_companion_moderation(v_profile, 'approved', null);
  end if;

  return v_result;
end;
$$;

select pg_notify('pgrst', 'reload schema');
