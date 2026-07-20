-- ============================================================
-- 2G4D — scheduled post-conversation processing (migration 0037).
-- Controlling design: docs/2g4-completion-architecture.md + 0034–0036.
--
-- This migration adds ONLY automation + the outstanding notifications.
-- It REUSES the existing financial state machine and never duplicates it:
--   * public.release_eligible_earnings()      (0034) — unchanged, reused
--   * app_private.make_earning_payable()       (0034) — writes payable_at once
--   * app_private.ensure_companion_earning()   (0034) — snapshot-only earning
--   * app_private.notify_account()             (0032) — deduped notifications
-- Eligibility everywhere stays the single provider guard: a succeeded
-- provider='stripe_test' payment order. No Stripe transfers, no payouts,
-- no refunds, no email/SMS/push — those belong to later phases.
--
-- Scheduling: Supabase Postgres Cron (pg_cron) invokes ONE narrow
-- orchestrator, public.process_post_conversation_tasks(), every 15 minutes.
-- There is NO public/unauthenticated batch endpoint. Where pg_cron is not
-- available (local/CI), the functions still exist and are invoked manually:
--     select public.process_post_conversation_tasks();
-- ============================================================

-- ------------------------------------------------------------
-- 1. Run-audit table (observability for scheduled runs).
--    Service-role writes via the definer functions; support may read.
-- ------------------------------------------------------------
create table if not exists public.post_conversation_run_audit (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  review_prompts_created integer,
  reminders_created integer,
  attendance_resolved integer,
  earnings_released integer,
  status text not null default 'running' check (status in ('running', 'ok', 'error')),
  error_detail text,
  created_at timestamptz not null default now()
);
create index if not exists post_conversation_run_audit_time_idx
  on public.post_conversation_run_audit (started_at desc);
alter table public.post_conversation_run_audit enable row level security;
-- No client writes at all. Support admins may read for observability.
drop policy if exists "run audit: support reads" on public.post_conversation_run_audit;
create policy "run audit: support reads" on public.post_conversation_run_audit
  for select to authenticated using (app_private.is_support_admin());

-- ------------------------------------------------------------
-- 2. Two-hour Companion attendance reminders (service-only).
--    One deterministic reminder per eligible booking; retries create
--    zero duplicates (pre-filter + notify_account dedupe index).
-- ------------------------------------------------------------
create or replace function public.create_companion_attendance_reminders()
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_companion_account uuid;
  v_member_name text;
  v_count integer := 0;
begin
  for v_row in
    select b.id as booking_id, b.companion_profile_id, b.member_profile_id
    from public.bookings b
    join public.payment_orders po
      on po.booking_id = b.id and po.provider = 'stripe_test' and po.status = 'succeeded'
    where b.ends_at <= now() - interval '2 hours'
      -- authoritative eligibility, NOT a strict status match:
      and b.status not in ('cancelled', 'declined')
      -- Companion has not submitted a final outcome AND no system-derived
      -- final attendance exists (any attendance row is final).
      and not exists (select 1 from public.conversation_attendance a where a.booking_id = b.id)
      -- an open issue supersedes the reminder.
      and not exists (select 1 from public.conversation_issues i
                      where i.booking_id = b.id and i.state <> 'resolved')
      -- do not repeat the same reminder every 15 minutes.
      and not exists (select 1 from public.notifications n
                      where n.related_booking_id = b.id
                        and n.dedupe_key = 'attendance-reminder-2h:' || b.id::text)
    limit 200
  loop
    select pa.account_id into v_companion_account
    from public.profile_access pa
    where pa.profile_id = v_row.companion_profile_id
      and pa.access_role = 'owner' and pa.consent_status <> 'withdrawn'
    limit 1;
    if v_companion_account is null then continue; end if;

    select first_name into v_member_name from public.profiles where id = v_row.member_profile_id;

    -- Directs the Companion to the conversation detail (related booking only,
    -- so the notification opens /conversations/{booking}). No payment claim.
    perform app_private.notify_account(
      v_companion_account, 'attendance_reminder', 'Confirm your conversation',
      'Please confirm whether your conversation with '
        || coalesce(v_member_name, 'your member') || ' took place.',
      v_row.booking_id, 'attendance-reminder-2h:' || v_row.booking_id::text);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.create_companion_attendance_reminders() from public, anon, authenticated;
grant execute on function public.create_companion_attendance_reminders() to service_role;

-- ------------------------------------------------------------
-- 3. Coordinator review prompts (service-only).
--    One deterministic prompt per funded booking after it ends; the Home
--    Needs-attention experience already surfaces the review too. Does NOT
--    require the Companion to confirm first, and is never a payment warning.
-- ------------------------------------------------------------
create or replace function public.create_review_prompts()
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_member_name text;
  v_companion_name text;
  v_count integer := 0;
begin
  for v_row in
    select b.id as booking_id, b.booked_by_account_id, b.member_profile_id, b.companion_profile_id
    from public.bookings b
    join public.payment_orders po
      on po.booking_id = b.id and po.provider = 'stripe_test' and po.status = 'succeeded'
    where b.ends_at <= now()
      and b.status not in ('cancelled', 'declined')
      and not exists (select 1 from public.conversation_reviews r where r.booking_id = b.id)
      and not exists (select 1 from public.conversation_issues i
                      where i.booking_id = b.id and i.state <> 'resolved')
      and not exists (select 1 from public.notifications n
                      where n.related_booking_id = b.id
                        and n.dedupe_key = 'review-prompt:' || b.id::text)
    limit 200
  loop
    select first_name into v_member_name from public.profiles where id = v_row.member_profile_id;
    select first_name into v_companion_name from public.profiles where id = v_row.companion_profile_id;
    perform app_private.notify_account(
      v_row.booked_by_account_id, 'review_prompt', 'How did the conversation go?',
      'Tell us how ' || coalesce(v_member_name, 'your member') || '’s conversation with '
        || coalesce(v_companion_name, 'the companion') || ' went.',
      v_row.booking_id, 'review-prompt:' || v_row.booking_id::text);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.create_review_prompts() from public, anon, authenticated;
grant execute on function public.create_review_prompts() to service_role;

-- ------------------------------------------------------------
-- 4. 24-hour fallback — REDEFINED additively to add neutral, role-aware
--    notifications and to relax the over-strict status gate. The financial
--    state machine is UNCHANGED: same trusted segment thresholds, same
--    make_earning_payable (payable_at once), same held_for_issue + unclear
--    manual-review case. Open/safety issues still exclude a booking. All
--    added notifications are deterministic + deduped, so retries produce no
--    duplicate attendance rows, issues or notifications.
-- ------------------------------------------------------------
create or replace function public.resolve_unconfirmed_attendance()
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_comp integer;
  v_mem integer;
  v_earning uuid;
  v_companion_account uuid;
  v_member_name text;
  v_companion_name text;
  v_count integer := 0;
begin
  for v_row in
    select b.id as booking_id, b.ends_at, b.booked_by_account_id,
           b.member_profile_id, b.companion_profile_id
    from public.bookings b
    join public.payment_orders po
      on po.booking_id = b.id and po.provider = 'stripe_test' and po.status = 'succeeded'
    where b.ends_at + interval '24 hours' <= now()
      -- authoritative eligibility, not an exact status match.
      and b.status not in ('cancelled', 'declined', 'change_proposed')
      and not exists (select 1 from public.conversation_attendance a where a.booking_id = b.id)
      and not exists (select 1 from public.conversation_issues i
                      where i.booking_id = b.id and i.state <> 'resolved')
    limit 100
    for update of b skip locked
  loop
    v_earning := app_private.ensure_companion_earning(v_row.booking_id);
    if v_earning is null then continue; end if;

    select companion_account_id into v_companion_account
      from public.companion_earnings where id = v_earning;
    select first_name into v_member_name from public.profiles where id = v_row.member_profile_id;
    select first_name into v_companion_name from public.profiles where id = v_row.companion_profile_id;

    select coalesce(sum(duration_seconds), 0) into v_comp
      from public.call_attendance_segments
      where booking_id = v_row.booking_id and side = 'companion';
    select coalesce(sum(duration_seconds), 0) into v_mem
      from public.call_attendance_segments
      where booking_id = v_row.booking_id and side = 'member';

    if v_comp >= 120 and v_mem >= 120 then
      -- System-derived apparent completion (source stays 'system'; no forged
      -- Companion statement). end+24h always satisfies the 12-hour half.
      insert into public.conversation_attendance
        (booking_id, outcome, source, explanation)
      values (v_row.booking_id, 'took_place', 'system',
              'Apparent completion from trusted attendance')
      on conflict (booking_id) do nothing;
      perform app_private.make_earning_payable(v_earning);
      -- Neutral notifications; never expose raw durations.
      perform app_private.notify_account(
        v_companion_account, 'conversation_completed', 'Conversation completed',
        'We confirmed the conversation attendance from the call record.',
        v_row.booking_id, 'fallback-completed:' || v_row.booking_id::text);
      perform app_private.notify_account(
        v_row.booked_by_account_id, 'conversation_completed', 'Conversation completed',
        'The conversation between ' || coalesce(v_member_name, 'the member') || ' and '
          || coalesce(v_companion_name, 'the companion') || ' has been marked as completed.',
        v_row.booking_id, 'fallback-completed:' || v_row.booking_id::text);

    elsif v_comp >= 600 and v_mem < 120 then
      -- Likely Member no-show; never accuse the Member in shared messaging.
      insert into public.conversation_attendance
        (booking_id, outcome, source, explanation)
      values (v_row.booking_id, 'member_no_show', 'system',
              'Likely Member no-show from trusted attendance')
      on conflict (booking_id) do nothing;
      perform app_private.make_earning_payable(v_earning);
      perform app_private.notify_account(
        v_companion_account, 'attendance_confirmed', 'Attendance confirmed',
        'Your attendance was confirmed and your earnings are ready for payout.',
        v_row.booking_id, 'fallback-attendance:' || v_row.booking_id::text);
      perform app_private.notify_account(
        v_row.booked_by_account_id, 'attendance_updated', 'Conversation attendance updated',
        'The conversation attendance was reviewed using the call record.',
        v_row.booking_id, 'fallback-attendance:' || v_row.booking_id::text);

    else
      -- Evidence unclear: ensure the earning is held and one manual-review
      -- case exists. Never auto-credit the customer or auto-pay the Companion.
      update public.companion_earnings set state = 'held_for_issue', updated_at = now()
       where id = v_earning and state = 'pending_completion';
      insert into public.conversation_issues
        (booking_id, earning_id, reporter_account_id, reporter_role, category,
         description, idempotency_key)
      select v_row.booking_id, v_earning, e.companion_account_id, 'system', 'unclear_attendance',
             'Attendance evidence unclear — manual review required',
             'unclear-' || v_row.booking_id::text
      from public.companion_earnings e where e.id = v_earning
      on conflict (idempotency_key) do nothing;
      perform app_private.notify_account(
        v_companion_account, 'attendance_under_review', 'Conversation under review',
        'We could not confirm the conversation outcome automatically. It is being reviewed.',
        v_row.booking_id, 'attendance-review:' || v_row.booking_id::text);
      perform app_private.notify_account(
        v_row.booked_by_account_id, 'attendance_under_review', 'Conversation under review',
        'The conversation outcome could not be confirmed automatically and is being reviewed.',
        v_row.booking_id, 'attendance-review:' || v_row.booking_id::text);
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.resolve_unconfirmed_attendance() from public, anon, authenticated;
grant execute on function public.resolve_unconfirmed_attendance() to service_role;

-- ------------------------------------------------------------
-- 5. Orchestration (service-only).
--
-- Ordering (per architecture): review prompts + reminders first, then the
-- 24-hour attendance fallback, then the ordinary 12-hour release.
--
-- Error policy — chosen deliberately for FINANCIAL correctness:
--   Each child runs in its OWN subtransaction. A child failure rolls back
--   ONLY that child's writes (atomic per child) and is recorded in
--   error_detail; the run status becomes 'error' (never a silent 'ok').
--   Children that succeeded — including release_eligible_earnings — still
--   commit. We do NOT abort the whole run on one child's failure (that would
--   discard already-correct financial work), but we NEVER swallow the error:
--   it is visible in post_conversation_run_audit and in the returned JSON.
-- ------------------------------------------------------------
create or replace function public.process_post_conversation_tasks()
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_audit uuid;
  v_reviews integer := 0;
  v_reminders integer := 0;
  v_resolved integer := 0;
  v_released integer := 0;
  v_errors text := '';
begin
  insert into public.post_conversation_run_audit (status) values ('running') returning id into v_audit;

  begin
    v_reviews := public.create_review_prompts();
  exception when others then
    v_errors := v_errors || 'review_prompts: ' || sqlerrm || '; ';
  end;

  begin
    v_reminders := public.create_companion_attendance_reminders();
  exception when others then
    v_errors := v_errors || 'reminders: ' || sqlerrm || '; ';
  end;

  begin
    v_resolved := public.resolve_unconfirmed_attendance();
  exception when others then
    v_errors := v_errors || 'resolve_attendance: ' || sqlerrm || '; ';
  end;

  begin
    v_released := public.release_eligible_earnings();
  exception when others then
    v_errors := v_errors || 'release_earnings: ' || sqlerrm || '; ';
  end;

  update public.post_conversation_run_audit
     set finished_at = now(),
         review_prompts_created = v_reviews,
         reminders_created = v_reminders,
         attendance_resolved = v_resolved,
         earnings_released = v_released,
         status = case when v_errors = '' then 'ok' else 'error' end,
         error_detail = nullif(v_errors, '')
   where id = v_audit;

  return jsonb_build_object(
    'run_id', v_audit,
    'review_prompts', v_reviews,
    'reminders', v_reminders,
    'attendance_resolved', v_resolved,
    'earnings_released', v_released,
    'status', case when v_errors = '' then 'ok' else 'error' end,
    'errors', nullif(v_errors, ''));
end;
$$;
revoke all on function public.process_post_conversation_tasks() from public, anon, authenticated;
grant execute on function public.process_post_conversation_tasks() to service_role;

-- ------------------------------------------------------------
-- 6. Schedule every 15 minutes with pg_cron WHERE AVAILABLE.
--    Guarded + idempotent: environments without pg_cron (local/CI) simply
--    skip registration; the functions are then invoked manually. There is
--    no public HTTP endpoint anywhere in this phase.
-- ------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    -- cron.schedule upserts by jobname (pg_cron >= 1.4): safe to re-run.
    perform cron.schedule(
      'process-post-conversation-tasks',
      '*/15 * * * *',
      $cron$select public.process_post_conversation_tasks();$cron$);
    raise notice 'Scheduled process_post_conversation_tasks() every 15 minutes via pg_cron.';
  else
    raise notice 'pg_cron unavailable — run select public.process_post_conversation_tasks(); on a schedule.';
  end if;
exception when others then
  raise notice 'pg_cron registration skipped (%). Invoke process_post_conversation_tasks() manually.', sqlerrm;
end $$;
