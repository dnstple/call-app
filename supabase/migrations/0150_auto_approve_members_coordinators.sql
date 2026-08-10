-- ===========================================================================
-- 0150_auto_approve_members_coordinators.sql
--
-- Members and Coordinators are auto-approved the moment they finish onboarding,
-- so they can immediately browse companions (Explore) and book calls. Companions
-- continue through manual review (moderation + application), unchanged.
--
-- Why access_level = 'full' (not 'pilot'): app_private.account_has_feature only
-- grants a *pilot* account a feature when that account's cohort has the feature
-- enabled (cohort_feature_access). Auto-granting 'pilot' without a cohort would
-- leave members with no Explore/booking access. 'full' returns true for all
-- released features directly, which is exactly what a member/coordinator needs.
--
-- Safety:
--   * Only acts when the account is still a fresh 'waitlist' row that has not
--     been touched by an admin (application_status in incomplete/ready/under
--     review). Never overrides 'blocked', 'suspended', or an already-granted
--     ('pilot'/'full') / 'approved' / 'rejected' state.
--   * Companions (accounts that own a companion profile) are never auto-approved.
--   * Goes through the audited access spine (ensure_access_row + audit_access +
--     enqueue_access_event) rather than a raw update, so the change is logged
--     and the member is notified ('full_access_granted').
-- ===========================================================================

-- Auto-approve the given account IFF it is a member/coordinator (owns no
-- companion profile) and is still an untouched waitlist row. Idempotent and
-- self-service safe: no require_support(), designed to be called from
-- complete_onboarding() as the owning account.
create or replace function app_private.auto_approve_member_coordinator(p_account uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_companion boolean;
  v_before jsonb;
  v_updated integer;
begin
  if p_account is null then
    return;
  end if;

  -- Determine role from the account's OWNED profile(s). A coordinator owns a
  -- 'coordinator' profile; a member owns a 'member' profile; a companion owns a
  -- 'companion' profile. Managed member profiles are linked as 'coordinator'
  -- (not 'owner'), so they never mislabel a coordinator as a member/companion.
  select coalesce(bool_or(pr.role = 'companion'), false)
    into v_is_companion
    from public.profile_access pa
    join public.profiles pr on pr.id = pa.profile_id
   where pa.account_id = p_account
     and pa.access_role = 'owner';

  -- Companions keep going through manual review (moderation + application).
  if v_is_companion then
    return;
  end if;

  -- Make sure a fail-closed access row exists, then snapshot for audit.
  perform app_private.ensure_access_row(p_account);
  v_before := app_private.access_snapshot(p_account);

  -- Grant full access + mark approved, but ONLY for an untouched waitlist row.
  -- This deliberately never clobbers an admin decision (blocked/suspended/
  -- rejected/approved) or an existing pilot/full grant.
  update public.account_access
     set access_level       = 'full',
         application_status = 'approved',
         granted_at         = now(),
         granted_by         = p_account,
         reviewed_at        = now(),
         updated_at         = now()
   where account_id = p_account
     and access_level = 'waitlist'
     and application_status in ('incomplete', 'ready_for_review', 'under_review');
  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    return;  -- nothing to do (already granted, blocked, suspended, or decided)
  end if;

  perform app_private.audit_access(
    p_account,
    'auto_approved_onboarding',
    v_before,
    app_private.access_snapshot(p_account),
    'Auto-approved on onboarding completion (member/coordinator).'
  );
  perform app_private.enqueue_access_event(
    p_account, 'full_access_granted', extract(epoch from now())::bigint::text);
end;
$$;
revoke all on function app_private.auto_approve_member_coordinator(uuid) from public, anon, authenticated;

-- Re-define complete_onboarding() to also run the auto-approval. Marking the
-- account onboarding_complete is unchanged; the auto-approval is best-effort in
-- the sense that it only ever helps (members/coordinators) and never touches
-- companions or admin-decided accounts.
create or replace function public.complete_onboarding()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.accounts
     set onboarding_complete = true, updated_at = now()
   where id = auth.uid();

  perform app_private.auto_approve_member_coordinator(auth.uid());
end;
$$;
revoke all on function public.complete_onboarding() from public, anon;
grant execute on function public.complete_onboarding() to authenticated;

-- Backfill: approve existing member/coordinator accounts that are stuck on an
-- untouched waitlist row so they get access without re-onboarding. Companions
-- and admin-decided rows are skipped by the helper's own guards.
do $$
declare r record;
begin
  for r in
    select aa.account_id
      from public.account_access aa
     where aa.access_level = 'waitlist'
       and aa.application_status in ('incomplete', 'ready_for_review', 'under_review')
  loop
    perform app_private.auto_approve_member_coordinator(r.account_id);
  end loop;
end $$;
