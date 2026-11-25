-- ===========================================================================
-- 0222_gdpr_erase_everything.sql
--
-- Extends public.gdpr_erase_account (0220) after a full audit (25 Nov 2026) of
-- every table that references a person. In addition to 0220 it now:
--   DELETES  interests, availability rules/exceptions, favourites, activity
--            events, prompt dismissals, match digests, notification prefs,
--            notifications, read state, sign-up step events, companion /
--            call / cancellation feedback, admin notes about them
--   SCRUBS   chat messages they sent, rating + review text, reschedule and
--            plan messages, failover SMS bodies, signed agreement names,
--            companion moderation reason, coordinator relationship summary,
--            member topics-to-avoid; revokes their referral codes; stops the
--            companion accepting members
--   RETURNS  their Stripe customer / connected-account ids so the copies held
--            AT Stripe can be deleted there (Stripe is a separate processor)
-- Still kept (anonymised id only; legal, financial and safety record):
-- bookings, payments, memberships, credits, earnings, refunds, disputes,
-- safety reports and blocks ABOUT them, audit logs.
-- ===========================================================================

set search_path = '';

create or replace function public.gdpr_erase_account(
  p_account           uuid,
  p_source_message    uuid default null,
  p_approved_by       text default null,
  p_dry_run           boolean default true,
  p_override_blockers boolean default false
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_sig      jsonb;
  v_blockers text[] := '{}';
  v_owned    uuid[];
  v_emails   text[];
  v_phones   text[];
  v_avatars  text[];
  v_rows     jsonb := '{}'::jsonb;
  v_n        integer;
  v_outcome  text;
  v_error    text;
  v_log_id   uuid;
  v_live_ok  boolean;
  v_stripe   jsonb;
begin
  if p_account is null then
    raise exception 'gdpr_erase_account: account id required';
  end if;
  if not exists (select 1 from auth.users where id = p_account)
     and not exists (select 1 from public.accounts where id = p_account) then
    raise exception 'gdpr_erase_account: account % not found', p_account;
  end if;

  if not p_dry_run then
    select erasure_live into v_live_ok from public.automation_controls where id;
    if not coalesce(v_live_ok, false) then
      raise exception 'gdpr_erase_account: live erasure disabled (automation_controls.erasure_live = false)';
    end if;
    if nullif(trim(coalesce(p_approved_by, '')), '') is null then
      raise exception 'gdpr_erase_account: live erasure requires p_approved_by';
    end if;
  end if;

  v_sig := public.automation_account_signals(p_account);

  -- Idempotency
  if coalesce((v_sig->>'already_erased')::boolean, false) then
    insert into public.gdpr_erasure_log (account_id, source_message_id, approved_by, dry_run, outcome)
    values (p_account, p_source_message, p_approved_by, p_dry_run, 'already_erased')
    returning id into v_log_id;
    return jsonb_build_object('outcome', 'already_erased', 'log_id', v_log_id, 'dry_run', p_dry_run);
  end if;

  -- Hard blockers
  if jsonb_array_length(coalesce(v_sig->'managed_profiles', '[]'::jsonb)) > 0 then v_blockers := v_blockers || 'has_managed_members'; end if;
  if coalesce((v_sig->>'open_disputes')::int, 0)     > 0 then v_blockers := v_blockers || 'open_dispute'; end if;
  if coalesce((v_sig->>'pending_refunds')::int, 0)   > 0 then v_blockers := v_blockers || 'pending_refund'; end if;
  if coalesce((v_sig->>'upcoming_bookings')::int, 0) > 0 then v_blockers := v_blockers || 'upcoming_booking'; end if;
  if coalesce((v_sig->>'unpaid_earnings')::int, 0)   > 0 then v_blockers := v_blockers || 'unpaid_earnings'; end if;

  if cardinality(v_blockers) > 0 and not p_override_blockers then
    insert into public.gdpr_erasure_log (account_id, source_message_id, approved_by, dry_run, outcome, refusal_reasons)
    values (p_account, p_source_message, p_approved_by, p_dry_run, 'refused', v_blockers)
    returning id into v_log_id;
    return jsonb_build_object('outcome', 'refused', 'refusal_reasons', to_jsonb(v_blockers),
                              'signals', v_sig, 'log_id', v_log_id, 'dry_run', p_dry_run);
  end if;

  -- Gather identifiers BEFORE scrubbing
  select coalesce(array_agg(profile_id), '{}') into v_owned
    from public.profile_access where account_id = p_account and access_role = 'owner';

  select coalesce(array_agg(distinct lower(e)) filter (where nullif(trim(e), '') is not null), '{}') into v_emails
  from (
    select email as e from auth.users where id = p_account
    union all select email from public.profile_private_details where profile_id = any (v_owned)
    union all select email from public.profiles where id = any (v_owned)
  ) s;

  select coalesce(array_agg(distinct p) filter (where nullif(trim(p), '') is not null), '{}') into v_phones
  from (
    select phone as p from auth.users where id = p_account
    union all select '+' || phone from auth.users where id = p_account and phone is not null and phone not like '+%'
    union all select phone_e164 from public.accounts where id = p_account
    union all select phone from public.profile_private_details where profile_id = any (v_owned)
    union all select phone from public.profiles where id = any (v_owned)
  ) s;

  select coalesce(array_agg(distinct a) filter (where nullif(trim(a), '') is not null), '{}') into v_avatars
  from (
    select avatar_path as a from public.profiles where id = any (v_owned)
  ) s;

  select jsonb_build_object(
    'customers', (select coalesce(jsonb_agg(stripe_customer_id), '[]'::jsonb) from public.stripe_customers where account_id = p_account),
    'connected_accounts', (select coalesce(jsonb_agg(stripe_account_id), '[]'::jsonb) from public.connected_accounts where account_id = p_account))
  into v_stripe;

  -- The erasure itself. In dry-run we raise a sentinel at the end so every
  -- statement is rolled back; plpgsql variables (v_rows) survive the rollback.
  begin
    update public.profiles set
      first_name = 'Deleted', last_name = '', email = '', phone = '', age_band = '', region = '',
      headline = '', bio = '', interests = '{}', photo_url = null, avatar_path = null,
      accessibility_needs = null, preferred_times = null, boundaries = null,
      preferred_name = null, country_of_residence = null, heard_about = null, heard_about_detail = null,
      connected_places = '{}', language_fluency = '{}'::jsonb,
      visibility = 'private', profile_status = 'hidden', updated_at = now()
    where id = any (v_owned);
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('profiles', v_n);

    update public.profile_private_details set
      legal_first_name = null, legal_last_name = null, date_of_birth = null,
      email = null, phone = null, private_location = null, updated_at = now()
    where profile_id = any (v_owned);
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('profile_private_details', v_n);

    update public.accounts set
      display_name = null, phone_e164 = null, phone_verified = false, phone_verified_at = null,
      status = 'deactivated', outreach_opt_out = true, sms_opt_out = true, updated_at = now()
    where id = p_account;
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('accounts', v_n);

    update public.contact_triage set reasoning = '[redacted: GDPR erasure]', draft_reply = null
    where message_id in (select id from public.contact_messages
                          where from_account_id = p_account or lower(email) = any (v_emails));
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('contact_triage', v_n);

    update public.contact_messages set
      name = null, email = null, message = '[redacted: GDPR erasure ' || to_char(now(), 'YYYY-MM-DD') || ']'
    where from_account_id = p_account or lower(email) = any (v_emails);
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('contact_messages', v_n);

    delete from public.landing_leads where lower(email) = any (v_emails) or phone = any (v_phones);
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('landing_leads', v_n);

    delete from public.auth_confirmation_reminders where user_id = p_account or lower(email) = any (v_emails);
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('auth_confirmation_reminders', v_n);

    update public.email_outbox set to_email = '[erased]', body_text = '[erased]'
    where account_id = p_account or lower(to_email) = any (v_emails);
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('email_outbox', v_n);

    update public.email_notifications set recipient_email = '[erased]'
    where recipient_user_id = p_account or lower(recipient_email) = any (v_emails);
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('email_notifications', v_n);

    update public.outreach_messages set address = '[erased]'
    where account_id = p_account or lower(address) = any (v_emails) or address = any (v_phones);
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('outreach_messages', v_n);

    insert into public.email_suppressions (account_id, category, source)
    select p_account, 'all', 'gdpr_erasure'
    where exists (select 1 from public.accounts where id = p_account)
    on conflict (account_id, category) do nothing;
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('email_suppressions', v_n);

    -- 0222: everything else the person created or that describes them.
    delete from public.profile_interests where profile_id = any (v_owned);
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('profile_interests', v_n);
    delete from public.availability_rules where companion_profile_id = any (v_owned);
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('availability_rules', v_n);
    delete from public.availability_exceptions where companion_profile_id = any (v_owned);
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('availability_exceptions', v_n);
    delete from public.favourites where account_id = p_account or profile_id = any (v_owned);
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('favourites', v_n);
    update public.companion_profiles set is_accepting_new_members = false, moderation_reason = null, updated_at = now() where profile_id = any (v_owned);
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('companion_profiles', v_n);
    update public.member_profiles set topics_to_avoid = '{}', updated_at = now() where profile_id = any (v_owned);
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('member_profiles', v_n);
    update public.coordinator_profiles set relationship_summary = '', updated_at = now() where profile_id = any (v_owned);
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('coordinator_profiles', v_n);
    delete from public.home_events where account_id = p_account;
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('home_events', v_n);
    delete from public.home_prompt_dismissals where account_id = p_account;
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('home_prompt_dismissals', v_n);
    delete from public.match_digest_log where account_id = p_account;
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('match_digest_log', v_n);
    delete from public.notification_preferences where account_id = p_account;
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('notification_preferences', v_n);
    delete from public.notifications where user_id = p_account;
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('notifications', v_n);
    delete from public.conversation_read_state where account_id = p_account;
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('conversation_read_state', v_n);
    delete from public.signup_step_events where account_id = p_account;
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('signup_step_events', v_n);
    delete from public.companion_feedback where account_id = p_account;
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('companion_feedback', v_n);
    delete from public.call_feedback where account_id = p_account;
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('call_feedback', v_n);
    delete from public.cancellation_feedback where account_id = p_account or member_profile_id = any (v_owned);
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('cancellation_feedback', v_n);
    delete from public.account_admin_notes where account_id = p_account;
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('account_admin_notes', v_n);
    update public.messages set body = null, system_payload = null, deleted_at = coalesce(deleted_at, now()) where sender_account_id = p_account and (body is not null or system_payload is not null);
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('messages_scrubbed', v_n);
    update public.ratings set public_comment = null, private_feedback = null, updated_at = now() where submitted_by_account_id = p_account and (public_comment is not null or private_feedback is not null);
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('ratings_scrubbed', v_n);
    update public.conversation_reviews set private_feedback = null where coordinator_account_id = p_account and private_feedback is not null;
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('conversation_reviews_scrubbed', v_n);
    update public.booking_time_proposals set message = null where proposed_by_account_id = p_account and message is not null;
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('booking_time_proposals_scrubbed', v_n);
    update public.conversation_plans set request_message = null, response_message = null, pause_reason = null, end_reason = null where created_by_account_id = p_account or member_profile_id = any (v_owned) or companion_profile_id = any (v_owned);
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('conversation_plans_scrubbed', v_n);
    update public.failover_sms_outbox set body = '[erased]' where recipient_account_id = p_account;
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('failover_sms_outbox', v_n);
    update public.membership_agreements set signed_name = null where account_id = p_account and signed_name is not null;
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('membership_agreements_scrubbed', v_n);
    update public.referral_codes set revoked = true where referrer_account_id = p_account and not revoked;
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('referral_codes_revoked', v_n);

    -- Login: anonymise, never delete (accounts cascades from auth.users).
    delete from auth.identities where user_id = p_account and provider = 'phone';
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('auth_identities_phone_deleted', v_n);

    update auth.identities set
      identity_data = jsonb_build_object('sub', p_account::text,
                                         'email', 'erased+' || p_account::text || '@invalid.apricoti')
    where user_id = p_account;
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('auth_identities_scrubbed', v_n);

    delete from auth.refresh_tokens where user_id = p_account::text;
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('auth_refresh_tokens', v_n);
    delete from auth.sessions where user_id = p_account;
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('auth_sessions', v_n);

    update auth.users set
      email = 'erased+' || p_account::text || '@invalid.apricoti',
      phone = null, phone_confirmed_at = null, phone_change = '', email_change = '',
      encrypted_password = '', raw_user_meta_data = '{}'::jsonb,
      banned_until = now() + interval '100 years', updated_at = now()
    where id = p_account;
    get diagnostics v_n = row_count; v_rows := v_rows || jsonb_build_object('auth_users', v_n);

    if p_dry_run then
      raise exception using errcode = 'P0D01', message = 'gdpr_dry_run_rollback';
    end if;
    v_outcome := 'erased';
  exception
    when sqlstate 'P0D01' then
      v_outcome := 'would_erase';
    when others then
      v_outcome := 'error';
      v_error := sqlstate || ': ' || sqlerrm;
  end;

  insert into public.gdpr_erasure_log
    (account_id, source_message_id, approved_by, dry_run, outcome, refusal_reasons, rows_affected, avatar_paths, error)
  values
    (p_account, p_source_message, p_approved_by, p_dry_run, v_outcome,
     case when p_override_blockers then v_blockers else '{}' end, v_rows, v_avatars, v_error)
  returning id into v_log_id;

  return jsonb_build_object(
    'outcome', v_outcome, 'dry_run', p_dry_run, 'log_id', v_log_id,
    'rows_affected', v_rows, 'avatar_paths', to_jsonb(v_avatars), 'stripe_ids', v_stripe,
    'overridden_blockers', to_jsonb(case when p_override_blockers then v_blockers else '{}'::text[] end),
    'error', v_error);
end;
$$;
revoke all on function public.gdpr_erase_account(uuid, uuid, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.gdpr_erase_account(uuid, uuid, text, boolean, boolean) to service_role;

select pg_notify('pgrst', 'reload schema');


-- ---------------------------------------------------------------------------
-- FINGERPRINT — should be true:
-- select (select position('conversation_read_state' in pg_get_functiondef(oid)) > 0 from pg_proc
--          where oid = to_regprocedure('public.gdpr_erase_account(uuid,uuid,text,boolean,boolean)')) as m0222;
-- ---------------------------------------------------------------------------
