-- 0104 — Pilot admin authority + application submission RPCs.
--
-- Builds on 0103's access/cohort/launch foundation. Everything here is
-- SECURITY DEFINER with an explicit authority check at the top:
--   * application RPCs      → the signed-in Companion, for their OWN account;
--   * admin RPCs            → support admins only (app_private.is_support_admin);
--   * actor is ALWAYS auth.uid() — never a client-supplied id;
--   * timestamps are server-generated (now());
--   * adverse actions (reject/suspend/revoke/block) REQUIRE a reason;
--   * repeated actions are idempotent; audit history is append-only;
--   * no user deletion, no impersonation, no secret fields returned.
--
-- Approval NEVER auto-grants access; cohort assignment NEVER auto-approves;
-- support-admin status NEVER grants a product feature. Moderation, consent,
-- blocking, payment and payout authority are untouched.
--
-- Additive only. Apply hosted after 0103.

set search_path = '';

-- ===========================================================================
-- 0. Shared helpers.
-- ===========================================================================

-- Raise unless the caller is a support admin.
create or replace function app_private.require_support()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not app_private.is_support_admin() then
    raise exception 'unauthorised: support only' using errcode = '42501';
  end if;
end;
$$;
revoke all on function app_private.require_support() from public, anon, authenticated;

-- The owner Companion profile for an account (null when not a Companion).
create or replace function app_private.companion_profile_for(p_account uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select p.id
  from public.profile_access pa
  join public.profiles p on p.id = pa.profile_id
  where pa.account_id = p_account and pa.access_role = 'owner' and p.role = 'companion'
  order by pa.created_at
  limit 1;
$$;
revoke all on function app_private.companion_profile_for(uuid) from public, anon, authenticated;

-- The account's product role (from its owner profile).
create or replace function app_private.account_role(p_account uuid)
returns text language sql stable security definer set search_path = '' as $$
  select p.role::text
  from public.profile_access pa
  join public.profiles p on p.id = pa.profile_id
  where pa.account_id = p_account and pa.access_role = 'owner'
  order by pa.created_at
  limit 1;
$$;
revoke all on function app_private.account_role(uuid) from public, anon, authenticated;

-- Append-only audit write. Actor is ALWAYS the authenticated caller.
create or replace function app_private.audit_access(
  p_target uuid, p_action text, p_before jsonb, p_after jsonb, p_reason text)
returns void language sql security definer set search_path = '' as $$
  insert into public.access_audit_log
    (target_account_id, actor_account_id, action, before_state, after_state, reason)
  values (p_target, auth.uid(), p_action, p_before, p_after, p_reason);
$$;
revoke all on function app_private.audit_access(uuid, text, jsonb, jsonb, text) from public, anon, authenticated;

-- Snapshot of an account_access row (for before/after audit states).
create or replace function app_private.access_snapshot(p_account uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'access_level', aa.access_level,
    'application_status', aa.application_status,
    'cohort_id', aa.cohort_id
  )
  from public.account_access aa where aa.account_id = p_account;
$$;
revoke all on function app_private.access_snapshot(uuid) from public, anon, authenticated;

-- Ensure an account_access row exists (fail-closed default) before mutating.
create or replace function app_private.ensure_access_row(p_account uuid)
returns void language sql security definer set search_path = '' as $$
  insert into public.account_access (account_id, access_level, application_status)
  values (p_account, 'waitlist', 'incomplete')
  on conflict (account_id) do nothing;
$$;
revoke all on function app_private.ensure_access_row(uuid) from public, anon, authenticated;

-- ===========================================================================
-- 1. Route pilot access events through the durable email outbox.
--    (Re-defines the 0093 category map, adding the access event families as
--     'system'. Existing mappings are preserved and still take precedence.)
-- ===========================================================================
create or replace function app_private.email_category_for_type(p_type text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_type = 'message_received' then 'messages'
    when p_type like 'booking_%' or p_type = 'attendance_reminder' or p_type like 'plan_%' then 'bookings'
    when p_type like 'payment_%' or p_type like 'billing_%' or p_type like 'refund_%' then 'billing'
    when p_type like 'concern_%' or p_type like 'issue_%' or p_type like 'dispute_%' then 'safety'
    when p_type like 'application_%' or p_type like 'pilot_%' or p_type like 'cohort_%'
      or p_type like 'access_%' or p_type in ('added_to_waitlist', 'full_access_granted') then 'system'
    else null
  end;
$$;
revoke all on function app_private.email_category_for_type(text) from public, anon, authenticated;

-- User-facing copy for an access event. Never leaks enum/error values.
create or replace function app_private.access_event_copy(p_event text)
returns jsonb language sql immutable set search_path = '' as $$
  select case p_event
    when 'application_received'        then jsonb_build_object('title','Application received','body','Thanks — your Companion application has been submitted. We''ll review it and let you know what happens next.')
    when 'application_ready_for_review' then jsonb_build_object('title','A Companion application is ready for review','body','A Companion has submitted their application for review.')
    when 'application_under_review'    then jsonb_build_object('title','Your application is under review','body','Our team is reviewing your Companion application. We''ll be in touch soon.')
    when 'application_approved'        then jsonb_build_object('title','Your application has been approved','body','Good news — your Companion application has been approved. We''ll let you know as soon as a pilot place is ready for you.')
    when 'application_rejected'        then jsonb_build_object('title','Update on your application','body','Thank you for applying to be a Companion. After review we''re not able to move your application forward at this time.')
    when 'added_to_waitlist'           then jsonb_build_object('title','You''re on the Companion waitlist','body','You''re on the waitlist for the Apricoti Companion pilot. We''ll contact you when a place becomes available.')
    when 'pilot_access_granted'        then jsonb_build_object('title','Your pilot access is ready','body','You now have pilot access to Apricoti. Sign in to set up conversations and start connecting.')
    when 'full_access_granted'         then jsonb_build_object('title','Full access enabled','body','Your Apricoti account now has full access.')
    when 'access_revoked'              then jsonb_build_object('title','Your access has changed','body','Your Apricoti pilot access has been updated. Please check your Pilot Hub for details.')
    when 'cohort_assigned'             then jsonb_build_object('title','You''ve been added to a pilot cohort','body','You''ve been assigned to an Apricoti pilot cohort. We''ll let you know when it opens.')
    when 'cohort_opening_reminder'     then jsonb_build_object('title','Your pilot cohort is opening','body','Your Apricoti pilot cohort is opening soon. Sign in to get ready.')
    else jsonb_build_object('title','Apricoti update','body','There''s an update on your Apricoti account.')
  end;
$$;
revoke all on function app_private.access_event_copy(text) from public, anon, authenticated;

-- Enqueue an access event as an in-app notification (idempotent per dedupe).
-- The 0093 trigger mirrors it into the durable email_outbox automatically.
create or replace function app_private.enqueue_access_event(
  p_account uuid, p_event text, p_dedupe_suffix text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_copy jsonb; v_id uuid; v_dedupe text;
begin
  if p_account is null then return null; end if;
  v_copy := app_private.access_event_copy(p_event);
  v_dedupe := p_event || ':' || coalesce(p_dedupe_suffix, '');
  insert into public.notifications (user_id, type, title, body, dedupe_key)
  values (p_account, p_event, v_copy->>'title', v_copy->>'body', v_dedupe)
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing
  returning id into v_id;
  return v_id;   -- null when deduped (already delivered for this transition)
end;
$$;
revoke all on function app_private.enqueue_access_event(uuid, text, text) from public, anon, authenticated;

-- ===========================================================================
-- 2. Authoritative application checklist (server-side; never trusts client).
-- ===========================================================================
-- Returns { role, is_companion, items:[{key,label,category,done,section}],
--           required_total, required_done, complete, completion_pct }.
-- category ∈ required | recommended | deferred. Payout setup is classified
-- DEFERRED per the held-earnings architecture (not required before review).
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
  -- Only the account itself, or a support admin, may read a checklist.
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
         (coalesce(array_length(p.interests,1),0) >= 3)
    into b_photo, b_bio, b_interests
    from public.profiles p where p.id = v_profile;
  b_avail   := exists (select 1 from public.availability_rules a where a.companion_id = v_profile);
  b_offers  := exists (select 1 from public.conversation_offers o where o.companion_profile_id = v_profile and o.active);
  b_consent := app_private.has_current_consent(v_profile, 'companion_pilot');
  b_payout  := exists (select 1 from public.connected_accounts ca where ca.account_id = v_account);

  -- required items
  v_items := jsonb_build_array(
    jsonb_build_object('key','verified_email','label','Confirm your email address','category','required','done',coalesce(b_email,false),'section','settings'),
    jsonb_build_object('key','profile_photo','label','Add a profile photo','category','required','done',coalesce(b_photo,false),'section','profile'),
    jsonb_build_object('key','biography','label','Write a short biography (at least 120 characters)','category','required','done',coalesce(b_bio,false),'section','profile'),
    jsonb_build_object('key','interests','label','Choose at least three interests','category','required','done',coalesce(b_interests,false),'section','profile'),
    jsonb_build_object('key','availability','label','Set your availability','category','required','done',coalesce(b_avail,false),'section','availability'),
    jsonb_build_object('key','conversation_offers','label','Add at least one conversation offer with a price','category','required','done',coalesce(b_offers,false),'section','availability'),
    jsonb_build_object('key','safeguarding_consent','label','Agree to the safeguarding and conduct terms','category','required','done',coalesce(b_consent,false),'section','settings'),
    -- payout setup: separate, DEFERRED (held earnings until later) — not blocking review
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

-- ===========================================================================
-- 3. Application submission (Companion, own account).
-- ===========================================================================
create or replace function public.submit_application()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_account uuid := auth.uid();
  v_check jsonb;
  v_before jsonb;
  v_status text;
  v_suffix text;
  r record;
begin
  if v_account is null then raise exception 'unauthorised: sign in required' using errcode = '42501'; end if;
  perform app_private.ensure_access_row(v_account);

  select application_status into v_status from public.account_access where account_id = v_account;

  -- Idempotent: already in/after review → no state change, no duplicate events.
  if v_status in ('ready_for_review','under_review','approved') then
    return jsonb_build_object('status', v_status, 'changed', false,
      'message', 'Your application has already been submitted.');
  end if;

  -- Server-side revalidation of the authoritative checklist.
  v_check := public.application_checklist(v_account);
  if not (v_check->>'is_companion')::boolean then
    raise exception 'not_a_companion: only Companion accounts submit an application' using errcode = 'P0001';
  end if;
  if not (v_check->>'complete')::boolean then
    raise exception 'application_incomplete: required setup steps are not finished' using errcode = 'P0001';
  end if;

  v_before := app_private.access_snapshot(v_account);
  update public.account_access
     set application_status = 'ready_for_review', submitted_at = now(), updated_at = now()
   where account_id = v_account;

  v_suffix := extract(epoch from now())::bigint::text;
  perform app_private.audit_access(v_account, 'application_submitted', v_before,
          app_private.access_snapshot(v_account), null);
  -- Confirmation to the applicant.
  perform app_private.enqueue_access_event(v_account, 'application_received', v_suffix);
  -- Notify every support admin (in-app + durable outbox).
  for r in select account_id from public.support_admins loop
    perform app_private.enqueue_access_event(r.account_id, 'application_ready_for_review', v_account::text || ':' || v_suffix);
  end loop;

  return jsonb_build_object('status', 'ready_for_review', 'changed', true,
    'message', 'Your application has been submitted for review.');
end;
$$;
revoke all on function public.submit_application() from public, anon;
grant execute on function public.submit_application() to authenticated;

-- ===========================================================================
-- 4. Admin application workflow actions (support only, audited).
-- ===========================================================================

-- Internal: apply an application_status transition + audit + optional event.
create or replace function app_private.admin_set_app_status(
  p_account uuid, p_status text, p_action text, p_event text, p_reason text, p_clear_submitted boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_before jsonb;
begin
  perform app_private.require_support();
  perform app_private.ensure_access_row(p_account);
  v_before := app_private.access_snapshot(p_account);
  update public.account_access set
     application_status = p_status,
     reviewed_at = case when p_status in ('under_review','approved','rejected') then now() else reviewed_at end,
     reviewed_by = case when p_status in ('under_review','approved','rejected') then auth.uid() else reviewed_by end,
     submitted_at = case when p_clear_submitted then null else submitted_at end,
     suspended_at = case when p_status = 'suspended' then now() else suspended_at end,
     updated_at = now()
   where account_id = p_account;
  perform app_private.audit_access(p_account, p_action, v_before, app_private.access_snapshot(p_account), p_reason);
  if p_event is not null then
    perform app_private.enqueue_access_event(p_account, p_event, extract(epoch from now())::bigint::text);
  end if;
  return app_private.access_snapshot(p_account);
end;
$$;
revoke all on function app_private.admin_set_app_status(uuid, text, text, text, text, boolean) from public, anon, authenticated;

create or replace function public.admin_mark_under_review(p_account uuid, p_reason text default null)
returns jsonb language sql security definer set search_path = '' as $$
  select app_private.admin_set_app_status(p_account, 'under_review', 'application_under_review', 'application_under_review', p_reason, false);
$$;

create or replace function public.admin_approve_application(p_account uuid, p_reason text default null)
returns jsonb language sql security definer set search_path = '' as $$
  -- Approval records the decision only. It does NOT grant access.
  select app_private.admin_set_app_status(p_account, 'approved', 'application_approved', 'application_approved', p_reason, false);
$$;

create or replace function public.admin_reject_application(p_account uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required: a reason is required to reject an application' using errcode = 'P0001';
  end if;
  return app_private.admin_set_app_status(p_account, 'rejected', 'application_rejected', 'application_rejected', p_reason, false);
end;
$$;

create or replace function public.admin_return_to_incomplete(p_account uuid, p_reason text default null)
returns jsonb language sql security definer set search_path = '' as $$
  -- Lets the Companion edit and resubmit. No adverse-event email.
  select app_private.admin_set_app_status(p_account, 'incomplete', 'application_returned', null, p_reason, true);
$$;

create or replace function public.admin_suspend_account(p_account uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required: a reason is required to suspend an account' using errcode = 'P0001';
  end if;
  -- Soft, reversible: preserves access_level; the evaluator treats suspended as blocked.
  return app_private.admin_set_app_status(p_account, 'suspended', 'account_suspended', null, p_reason, false);
end;
$$;

create or replace function public.admin_restore_account(p_account uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_before jsonb; v_new text;
begin
  perform app_private.require_support();
  perform app_private.ensure_access_row(p_account);
  v_before := app_private.access_snapshot(p_account);
  -- Recompute a sensible non-suspended status from history.
  select case
    when reviewed_at is not null and (v_before->>'application_status') = 'suspended' then 'approved'
    when submitted_at is not null then 'ready_for_review'
    else 'incomplete' end
  into v_new from public.account_access where account_id = p_account;
  update public.account_access set application_status = v_new, suspended_at = null, updated_at = now()
   where account_id = p_account and application_status = 'suspended';
  perform app_private.audit_access(p_account, 'account_restored', v_before, app_private.access_snapshot(p_account), p_reason);
  return app_private.access_snapshot(p_account);
end;
$$;

-- ===========================================================================
-- 5. Access-level grants (support only, audited). Independent of approval.
-- ===========================================================================
create or replace function app_private.admin_set_access_level(
  p_account uuid, p_level text, p_action text, p_event text, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_before jsonb;
begin
  perform app_private.require_support();
  perform app_private.ensure_access_row(p_account);
  v_before := app_private.access_snapshot(p_account);
  update public.account_access set
     access_level = p_level,
     granted_at = case when p_level in ('pilot','full') then now() else granted_at end,
     granted_by = case when p_level in ('pilot','full') then auth.uid() else granted_by end,
     updated_at = now()
   where account_id = p_account;
  perform app_private.audit_access(p_account, p_action, v_before, app_private.access_snapshot(p_account), p_reason);
  if p_event is not null then
    perform app_private.enqueue_access_event(p_account, p_event, extract(epoch from now())::bigint::text);
  end if;
  return app_private.access_snapshot(p_account);
end;
$$;
revoke all on function app_private.admin_set_access_level(uuid, text, text, text, text) from public, anon, authenticated;

create or replace function public.admin_grant_waitlist(p_account uuid, p_reason text default null)
returns jsonb language sql security definer set search_path = '' as $$
  select app_private.admin_set_access_level(p_account, 'waitlist', 'access_granted_waitlist', 'added_to_waitlist', p_reason);
$$;

create or replace function public.admin_grant_full(p_account uuid, p_reason text default null)
returns jsonb language sql security definer set search_path = '' as $$
  select app_private.admin_set_access_level(p_account, 'full', 'access_granted_full', 'full_access_granted', p_reason);
$$;

create or replace function public.admin_revoke_access(p_account uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required: a reason is required to revoke access' using errcode = 'P0001';
  end if;
  return app_private.admin_set_access_level(p_account, 'waitlist', 'access_revoked', 'access_revoked', p_reason);
end;
$$;

create or replace function public.admin_block_access(p_account uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason_required: a reason is required to block access' using errcode = 'P0001';
  end if;
  return app_private.admin_set_access_level(p_account, 'blocked', 'access_blocked', null, p_reason);
end;
$$;

create or replace function public.admin_unblock_access(p_account uuid, p_reason text default null)
returns jsonb language sql security definer set search_path = '' as $$
  select app_private.admin_set_access_level(p_account, 'waitlist', 'access_unblocked', 'added_to_waitlist', p_reason);
$$;

-- Grant pilot, optionally assigning a cohort (capacity enforced below).
create or replace function public.admin_grant_pilot(p_account uuid, p_cohort uuid default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_res jsonb;
begin
  perform app_private.require_support();
  if p_cohort is not null then
    perform public.admin_assign_cohort(p_account, p_cohort, p_reason);
  end if;
  v_res := app_private.admin_set_access_level(p_account, 'pilot', 'access_granted_pilot', 'pilot_access_granted', p_reason);
  return v_res;
end;
$$;
revoke all on function public.admin_grant_pilot(uuid, uuid, text) from public, anon;
grant execute on function public.admin_grant_pilot(uuid, uuid, text) to authenticated;

-- ===========================================================================
-- 6. Cohort assignment (support only). Enforces capacity + status server-side.
--    Assignment NEVER changes application_status (no silent approval).
-- ===========================================================================
create or replace function public.admin_assign_cohort(p_account uuid, p_cohort uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_before jsonb; v_status text; v_max int; v_count int; v_already boolean;
begin
  perform app_private.require_support();
  perform app_private.ensure_access_row(p_account);
  select status, max_size into v_status, v_max from public.pilot_cohorts where id = p_cohort;
  if v_status is null then raise exception 'cohort_not_found' using errcode = 'P0001'; end if;
  if v_status in ('completed','archived') then
    raise exception 'cohort_closed: this cohort is not accepting new assignments' using errcode = 'P0001';
  end if;
  select exists(select 1 from public.account_access where account_id = p_account and cohort_id = p_cohort) into v_already;
  if not v_already and v_max is not null then
    select count(*) into v_count from public.account_access where cohort_id = p_cohort;
    if v_count >= v_max then
      raise exception 'cohort_full: this cohort is at capacity' using errcode = 'P0001';
    end if;
  end if;
  v_before := app_private.access_snapshot(p_account);
  update public.account_access set cohort_id = p_cohort, updated_at = now() where account_id = p_account;
  perform app_private.audit_access(p_account, 'cohort_assigned', v_before, app_private.access_snapshot(p_account), p_reason);
  perform app_private.enqueue_access_event(p_account, 'cohort_assigned', p_cohort::text);
  return app_private.access_snapshot(p_account);
end;
$$;
revoke all on function public.admin_assign_cohort(uuid, uuid, text) from public, anon;
grant execute on function public.admin_assign_cohort(uuid, uuid, text) to authenticated;

create or replace function public.admin_remove_cohort(p_account uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_before jsonb;
begin
  perform app_private.require_support();
  v_before := app_private.access_snapshot(p_account);
  update public.account_access set cohort_id = null, updated_at = now() where account_id = p_account;
  perform app_private.audit_access(p_account, 'cohort_removed', v_before, app_private.access_snapshot(p_account), p_reason);
  return app_private.access_snapshot(p_account);
end;
$$;
revoke all on function public.admin_remove_cohort(uuid, text) from public, anon;
grant execute on function public.admin_remove_cohort(uuid, text) to authenticated;

-- ===========================================================================
-- 7. Per-account feature overrides + private notes (support only).
-- ===========================================================================
create or replace function public.admin_set_feature_override(
  p_account uuid, p_feature text, p_enabled boolean, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_support();
  if not exists (select 1 from public.pilot_features where feature_key = p_feature) then
    raise exception 'unknown_feature' using errcode = 'P0001';
  end if;
  insert into public.account_feature_overrides (account_id, feature_key, enabled, reason, granted_by)
  values (p_account, p_feature, p_enabled, p_reason, auth.uid())
  on conflict (account_id, feature_key) do update
    set enabled = excluded.enabled, reason = excluded.reason, granted_by = excluded.granted_by, created_at = now();
  perform app_private.audit_access(p_account, 'feature_override_set', null,
    jsonb_build_object('feature', p_feature, 'enabled', p_enabled), p_reason);
  return jsonb_build_object('feature', p_feature, 'enabled', p_enabled);
end;
$$;
revoke all on function public.admin_set_feature_override(uuid, text, boolean, text) from public, anon;
grant execute on function public.admin_set_feature_override(uuid, text, boolean, text) to authenticated;

create or replace function public.admin_clear_feature_override(p_account uuid, p_feature text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_support();
  delete from public.account_feature_overrides where account_id = p_account and feature_key = p_feature;
  perform app_private.audit_access(p_account, 'feature_override_cleared', jsonb_build_object('feature', p_feature), null, null);
  return jsonb_build_object('feature', p_feature, 'cleared', true);
end;
$$;
revoke all on function public.admin_clear_feature_override(uuid, text) from public, anon;
grant execute on function public.admin_clear_feature_override(uuid, text) to authenticated;

create or replace function public.admin_add_note(p_account uuid, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform app_private.require_support();
  if p_note is null or btrim(p_note) = '' then raise exception 'note_required' using errcode = 'P0001'; end if;
  insert into public.account_admin_notes (account_id, note, author_account_id)
  values (p_account, p_note, auth.uid()) returning id into v_id;
  perform app_private.audit_access(p_account, 'note_added', null, jsonb_build_object('note_id', v_id), null);
  return jsonb_build_object('id', v_id);
end;
$$;
revoke all on function public.admin_add_note(uuid, text) from public, anon;
grant execute on function public.admin_add_note(uuid, text) to authenticated;

-- Private notes are NEVER visible to the reviewed account — support read only.
create or replace function public.admin_list_notes(p_account uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app_private.require_support();
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', n.id, 'note', n.note, 'author', a.display_name, 'created_at', n.created_at) order by n.created_at desc), '[]'::jsonb)
  into v from public.account_admin_notes n
  left join public.accounts a on a.id = n.author_account_id
  where n.account_id = p_account;
  return v;
end;
$$;
revoke all on function public.admin_list_notes(uuid) from public, anon;
grant execute on function public.admin_list_notes(uuid) to authenticated;

-- ===========================================================================
-- 8. Cohort CRUD + feature matrix (support only).
-- ===========================================================================
create or replace function public.admin_create_cohort(
  p_name text, p_description text default null, p_status text default 'draft',
  p_starts_on date default null, p_ends_on date default null, p_max_size integer default null)
returns public.pilot_cohorts language plpgsql security definer set search_path = '' as $$
declare v public.pilot_cohorts;
begin
  perform app_private.require_support();
  if p_name is null or btrim(p_name) = '' then raise exception 'name_required' using errcode = 'P0001'; end if;
  if p_status not in ('draft','recruiting','active','completed','archived') then raise exception 'invalid_status' using errcode = 'P0001'; end if;
  insert into public.pilot_cohorts (name, description, status, starts_on, ends_on, max_size, created_by)
  values (btrim(p_name), p_description, p_status, p_starts_on, p_ends_on, p_max_size, auth.uid())
  returning * into v;
  perform app_private.audit_access(null, 'cohort_created', null, to_jsonb(v), null);
  return v;
end;
$$;
revoke all on function public.admin_create_cohort(text, text, text, date, date, integer) from public, anon;
grant execute on function public.admin_create_cohort(text, text, text, date, date, integer) to authenticated;

create or replace function public.admin_update_cohort(
  p_cohort uuid, p_name text default null, p_description text default null,
  p_status text default null, p_starts_on date default null, p_ends_on date default null,
  p_max_size integer default null)
returns public.pilot_cohorts language plpgsql security definer set search_path = '' as $$
declare v_before public.pilot_cohorts; v public.pilot_cohorts;
begin
  perform app_private.require_support();
  select * into v_before from public.pilot_cohorts where id = p_cohort;
  if v_before.id is null then raise exception 'cohort_not_found' using errcode = 'P0001'; end if;
  if p_status is not null and p_status not in ('draft','recruiting','active','completed','archived') then
    raise exception 'invalid_status' using errcode = 'P0001';
  end if;
  update public.pilot_cohorts set
    name = coalesce(nullif(btrim(p_name),''), name),
    description = coalesce(p_description, description),
    status = coalesce(p_status, status),
    starts_on = coalesce(p_starts_on, starts_on),
    ends_on = coalesce(p_ends_on, ends_on),
    max_size = coalesce(p_max_size, max_size),
    updated_at = now()
  where id = p_cohort returning * into v;
  perform app_private.audit_access(null, 'cohort_updated', to_jsonb(v_before), to_jsonb(v), null);
  return v;
end;
$$;
revoke all on function public.admin_update_cohort(uuid, text, text, text, date, date, integer) from public, anon;
grant execute on function public.admin_update_cohort(uuid, text, text, text, date, date, integer) to authenticated;

create or replace function public.admin_set_cohort_feature(p_cohort uuid, p_feature text, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_support();
  if not exists (select 1 from public.pilot_features where feature_key = p_feature) then
    raise exception 'unknown_feature' using errcode = 'P0001';
  end if;
  insert into public.cohort_feature_access (cohort_id, feature_key, enabled)
  values (p_cohort, p_feature, p_enabled)
  on conflict (cohort_id, feature_key) do update set enabled = excluded.enabled;
  perform app_private.audit_access(null, 'cohort_feature_set', null,
    jsonb_build_object('cohort', p_cohort, 'feature', p_feature, 'enabled', p_enabled), null);
  return jsonb_build_object('cohort', p_cohort, 'feature', p_feature, 'enabled', p_enabled);
end;
$$;
revoke all on function public.admin_set_cohort_feature(uuid, text, boolean) from public, anon;
grant execute on function public.admin_set_cohort_feature(uuid, text, boolean) to authenticated;

-- ===========================================================================
-- 9. Bulk preview + bulk grants (support only). Capacity enforced server-side.
-- ===========================================================================
create or replace function public.admin_bulk_preview(p_account_ids uuid[], p_action text, p_cohort uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_rows jsonb := '[]'::jsonb; v_max int; v_count int; v_remaining int; a uuid; v_ok boolean; v_reason text;
begin
  perform app_private.require_support();
  if p_action = 'grant_pilot' then
    if p_cohort is not null then
      select max_size into v_max from public.pilot_cohorts where id = p_cohort;
      select count(*) into v_count from public.account_access where cohort_id = p_cohort;
      v_remaining := case when v_max is null then null else greatest(v_max - v_count, 0) end;
    end if;
  end if;
  foreach a in array coalesce(p_account_ids, '{}') loop
    v_ok := true; v_reason := 'ok';
    if not exists (select 1 from public.accounts where id = a) then
      v_ok := false; v_reason := 'account_not_found';
    elsif p_action = 'grant_pilot' and p_cohort is not null and v_remaining is not null then
      if v_remaining <= 0 and not exists (select 1 from public.account_access where account_id = a and cohort_id = p_cohort) then
        v_ok := false; v_reason := 'cohort_full';
      elsif v_ok and not exists (select 1 from public.account_access where account_id = a and cohort_id = p_cohort) then
        v_remaining := v_remaining - 1;
      end if;
    end if;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('account_id', a, 'eligible', v_ok, 'reason', v_reason));
  end loop;
  return jsonb_build_object('action', p_action, 'cohort', p_cohort,
    'capacity_remaining', v_remaining, 'items', v_rows);
end;
$$;
revoke all on function public.admin_bulk_preview(uuid[], text, uuid) from public, anon;
grant execute on function public.admin_bulk_preview(uuid[], text, uuid) to authenticated;

create or replace function public.admin_bulk_grant_pilot(p_account_ids uuid[], p_cohort uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a uuid; v_done int := 0; v_skipped int := 0; v_items jsonb := '[]'::jsonb;
begin
  perform app_private.require_support();
  foreach a in array coalesce(p_account_ids, '{}') loop
    begin
      perform public.admin_grant_pilot(a, p_cohort, p_reason);
      v_done := v_done + 1;
      v_items := v_items || jsonb_build_array(jsonb_build_object('account_id', a, 'granted', true));
    exception when others then
      v_skipped := v_skipped + 1;
      v_items := v_items || jsonb_build_array(jsonb_build_object('account_id', a, 'granted', false, 'reason', sqlerrm));
    end;
  end loop;
  perform app_private.audit_access(null, 'bulk_pilot_grant', null,
    jsonb_build_object('cohort', p_cohort, 'granted', v_done, 'skipped', v_skipped), p_reason);
  return jsonb_build_object('granted', v_done, 'skipped', v_skipped, 'items', v_items);
end;
$$;
revoke all on function public.admin_bulk_grant_pilot(uuid[], uuid, text) from public, anon;
grant execute on function public.admin_bulk_grant_pilot(uuid[], uuid, text) to authenticated;

create or replace function public.admin_bulk_return_waitlist(p_account_ids uuid[], p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a uuid; v_done int := 0;
begin
  perform app_private.require_support();
  if p_reason is null or btrim(p_reason) = '' then raise exception 'reason_required' using errcode = 'P0001'; end if;
  foreach a in array coalesce(p_account_ids, '{}') loop
    perform app_private.admin_set_access_level(a, 'waitlist', 'access_revoked', 'added_to_waitlist', p_reason);
    v_done := v_done + 1;
  end loop;
  perform app_private.audit_access(null, 'bulk_return_waitlist', null, jsonb_build_object('count', v_done), p_reason);
  return jsonb_build_object('returned', v_done);
end;
$$;
revoke all on function public.admin_bulk_return_waitlist(uuid[], text) from public, anon;
grant execute on function public.admin_bulk_return_waitlist(uuid[], text) to authenticated;

-- ===========================================================================
-- 10. Notification resend + history (support only). Delivery status visible.
-- ===========================================================================
create or replace function public.admin_resend_notification(p_account uuid, p_event text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_suffix text;
begin
  perform app_private.require_support();
  -- Fresh dedupe suffix so a resend is a NEW record (audited), not deduped away.
  v_suffix := 'resend:' || extract(epoch from clock_timestamp())::bigint::text;
  v_id := app_private.enqueue_access_event(p_account, p_event, v_suffix);
  perform app_private.audit_access(p_account, 'notification_resent',
    null, jsonb_build_object('event', p_event, 'notification_id', v_id), p_reason);
  return jsonb_build_object('notification_id', v_id, 'event', p_event);
end;
$$;
revoke all on function public.admin_resend_notification(uuid, text, text) from public, anon;
grant execute on function public.admin_resend_notification(uuid, text, text) to authenticated;

create or replace function public.admin_notification_history(p_account uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app_private.require_support();
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', n.id, 'type', n.type, 'title', n.title, 'created_at', n.created_at,
    'read', n.read,
    'email_status', o.status, 'email_sent_at', o.sent_at
  ) order by n.created_at desc), '[]'::jsonb)
  into v
  from public.notifications n
  left join public.email_outbox o on o.notification_id = n.id
  where n.user_id = p_account
    and (n.type like 'application_%' or n.type like 'pilot_%' or n.type like 'cohort_%'
         or n.type like 'access_%' or n.type in ('added_to_waitlist','full_access_granted'));
  return v;
end;
$$;
revoke all on function public.admin_notification_history(uuid) from public, anon;
grant execute on function public.admin_notification_history(uuid) to authenticated;

-- ===========================================================================
-- 11. Admin dashboards + list + detail (support only; server-side pagination).
-- ===========================================================================
create or replace function public.admin_access_dashboard()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app_private.require_support();
  select jsonb_build_object(
    'total', (select count(*) from public.account_access),
    'by_role', (select coalesce(jsonb_object_agg(role, n), '{}'::jsonb) from (
        select coalesce(app_private.account_role(aa.account_id),'unknown') role, count(*) n
        from public.account_access aa group by 1) r),
    'by_application_status', (select coalesce(jsonb_object_agg(application_status, n), '{}'::jsonb) from (
        select application_status, count(*) n from public.account_access group by 1) s),
    'by_access_level', (select coalesce(jsonb_object_agg(access_level, n), '{}'::jsonb) from (
        select access_level, count(*) n from public.account_access group by 1) l),
    'by_cohort', (select coalesce(jsonb_object_agg(name, n), '{}'::jsonb) from (
        select coalesce(c.name,'(none)') name, count(*) n
        from public.account_access aa left join public.pilot_cohorts c on c.id = aa.cohort_id
        group by 1) cc)
  ) into v;
  return v;
end;
$$;
revoke all on function public.admin_access_dashboard() from public, anon;
grant execute on function public.admin_access_dashboard() to authenticated;

create or replace function public.admin_list_accounts(
  p_search text default null, p_role text default null, p_status text default null,
  p_access text default null, p_cohort uuid default null,
  p_sort text default 'registered', p_dir text default 'desc',
  p_limit integer default 25, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_rows jsonb; v_total int; v_lim int := least(greatest(coalesce(p_limit,25),1),100); v_off int := greatest(coalesce(p_offset,0),0);
begin
  perform app_private.require_support();
  with base as (
    select aa.account_id, aa.access_level, aa.application_status, aa.cohort_id,
           aa.submitted_at, aa.updated_at as last_active, ac.created_at as registered,
           app_private.account_role(aa.account_id) as role,
           c.name as cohort_name,
           p.first_name, p.last_name, p.email, p.photo_url
    from public.account_access aa
    join public.accounts ac on ac.id = aa.account_id
    left join public.pilot_cohorts c on c.id = aa.cohort_id
    left join lateral (
      select pr.first_name, pr.last_name, pr.email, pr.photo_url
      from public.profile_access pax join public.profiles pr on pr.id = pax.profile_id
      where pax.account_id = aa.account_id and pax.access_role = 'owner'
      order by pax.created_at limit 1) p on true
  ), filtered as (
    select * from base
    where (p_search is null or btrim(p_search) = ''
           or (coalesce(first_name,'')||' '||coalesce(last_name,'')) ilike '%'||p_search||'%'
           or coalesce(email,'') ilike '%'||p_search||'%')
      and (p_role is null   or role = p_role)
      and (p_status is null or application_status = p_status)
      and (p_access is null or access_level = p_access)
      and (p_cohort is null or cohort_id = p_cohort)
  )
  select count(*) into v_total from filtered;

  with base as (
    select aa.account_id, aa.access_level, aa.application_status, aa.cohort_id,
           aa.submitted_at, aa.updated_at as last_active, ac.created_at as registered,
           app_private.account_role(aa.account_id) as role, c.name as cohort_name,
           p.first_name, p.last_name, p.email
    from public.account_access aa
    join public.accounts ac on ac.id = aa.account_id
    left join public.pilot_cohorts c on c.id = aa.cohort_id
    left join lateral (
      select pr.first_name, pr.last_name, pr.email
      from public.profile_access pax join public.profiles pr on pr.id = pax.profile_id
      where pax.account_id = aa.account_id and pax.access_role = 'owner'
      order by pax.created_at limit 1) p on true
  ), filtered as (
    select * from base
    where (p_search is null or btrim(p_search) = ''
           or (coalesce(first_name,'')||' '||coalesce(last_name,'')) ilike '%'||p_search||'%'
           or coalesce(email,'') ilike '%'||p_search||'%')
      and (p_role is null   or role = p_role)
      and (p_status is null or application_status = p_status)
      and (p_access is null or access_level = p_access)
      and (p_cohort is null or cohort_id = p_cohort)
  )
  select coalesce(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb) into v_rows from (
    select account_id, role, application_status, access_level, cohort_name,
           first_name, last_name, email, registered, last_active
    from filtered
    order by
      case when p_sort='registered'  and p_dir='asc'  then registered end asc,
      case when p_sort='registered'  and p_dir<>'asc' then registered end desc,
      case when p_sort='last_active' and p_dir='asc'  then last_active end asc,
      case when p_sort='last_active' and p_dir<>'asc' then last_active end desc,
      registered desc
    limit v_lim offset v_off
  ) x;

  return jsonb_build_object('total', v_total, 'limit', v_lim, 'offset', v_off, 'rows', v_rows);
end;
$$;
revoke all on function public.admin_list_accounts(text, text, text, text, uuid, text, text, integer, integer) from public, anon;
grant execute on function public.admin_list_accounts(text, text, text, text, uuid, text, text, integer, integer) to authenticated;

create or replace function public.admin_account_detail(p_account uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_aa public.account_access; v_profile uuid; v jsonb; v_email_confirmed boolean;
begin
  perform app_private.require_support();
  select * into v_aa from public.account_access where account_id = p_account;
  v_profile := app_private.companion_profile_for(p_account);
  v_email_confirmed := exists (select 1 from auth.users u where u.id = p_account and u.email_confirmed_at is not null);

  select jsonb_build_object(
    'account_id', p_account,
    'role', app_private.account_role(p_account),
    'email_confirmed', v_email_confirmed,
    'application_status', v_aa.application_status,
    'access_level', v_aa.access_level,
    'cohort_id', v_aa.cohort_id,
    'submitted_at', v_aa.submitted_at,
    'reviewed_at', v_aa.reviewed_at,
    'granted_at', v_aa.granted_at,
    'profile', (select jsonb_build_object(
        'first_name', pr.first_name, 'last_name', pr.last_name, 'headline', pr.headline,
        'bio', pr.bio, 'interests', pr.interests, 'photo_url', pr.photo_url,
        'profile_status', pr.profile_status, 'visibility', pr.visibility)
        from public.profiles pr where pr.id = v_profile),
    'checklist', case when v_profile is not null then public.application_checklist(p_account) else null end,
    'overrides', (select coalesce(jsonb_agg(jsonb_build_object('feature', feature_key, 'enabled', enabled, 'reason', reason)), '[]'::jsonb)
        from public.account_feature_overrides where account_id = p_account),
    'notes', public.admin_list_notes(p_account),
    'notifications', public.admin_notification_history(p_account),
    'audit', (select coalesce(jsonb_agg(jsonb_build_object(
        'action', action, 'actor', actor_account_id, 'reason', reason,
        'before', before_state, 'after', after_state, 'created_at', created_at) order by created_at desc), '[]'::jsonb)
        from public.access_audit_log where target_account_id = p_account)
  ) into v;
  return v;
end;
$$;
revoke all on function public.admin_account_detail(uuid) from public, anon;
grant execute on function public.admin_account_detail(uuid) to authenticated;

-- Support-only cohort list with live occupancy.
create or replace function public.admin_list_cohorts()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app_private.require_support();
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'name', c.name, 'description', c.description, 'status', c.status,
    'starts_on', c.starts_on, 'ends_on', c.ends_on, 'max_size', c.max_size,
    'occupancy', (select count(*) from public.account_access aa where aa.cohort_id = c.id),
    'features', (select coalesce(jsonb_object_agg(feature_key, enabled), '{}'::jsonb)
                 from public.cohort_feature_access where cohort_id = c.id)
  ) order by c.created_at desc), '[]'::jsonb)
  into v from public.pilot_cohorts c;
  return v;
end;
$$;
revoke all on function public.admin_list_cohorts() from public, anon;
grant execute on function public.admin_list_cohorts() to authenticated;

select pg_notify('pgrst', 'reload schema');
